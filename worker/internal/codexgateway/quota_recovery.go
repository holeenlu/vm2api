package codexgateway

import (
	"math"
	"time"
)

// 额度耗尽的解除（对齐 codex-proxy-rs credential/quota/recovery.rs）：完整快照（/wham/usage）只在以下情况
// 解除额度冷却，单次未触顶的观测不够，避免耗尽后立刻拉到的旧快照误解封：
//   - 记录的耗尽窗口全部滚动到新窗口（reset 前进）且新窗口用量低于 10%；
//   - 或同一窗口连续两次报告未触顶（reset 未滚动、用量回落）；
//   - 或耗尽之后的全部 reset 都已到期，且本次快照明确未耗尽。
//
// 成功推理、重置卡、人工恢复仍直接解除。
const resetRecoveryMaxUsedPercent = 10.0

var accountQuotaWindows = []string{"primary_window", "secondary_window"}

// QuotaRecovery 绑定一次耗尽事实：待解除窗口及其 reset 基线（nil 表示未知），以及已观测到一次未触顶的候选。
type QuotaRecovery struct {
	ExhaustedAt time.Time             `json:"exhausted_at"`
	Pending     map[string]*time.Time `json:"pending"`
	Candidates  map[string]bool       `json:"candidates,omitempty"`
}

type quotaWindowView struct {
	present bool
	used    float64
	reset   *time.Time
}

func quotaWindow(quota map[string]any, key string) quotaWindowView {
	window, ok := quota[key].(map[string]any)
	if !ok {
		return quotaWindowView{}
	}
	view := quotaWindowView{present: true, used: math.NaN()}
	if used, ok := window["used_percent"].(float64); ok {
		view.used = used
	}
	if text, ok := window["reset_at"].(string); ok {
		if at, err := time.Parse(time.RFC3339Nano, text); err == nil {
			view.reset = &at
		}
	}
	return view
}

func (w quotaWindowView) limitReached() bool { return w.present && w.used >= 100 }

// newQuotaRecovery 以耗尽时的快照为基线；usage_limit_reached 错误的 reset 用来补充百分比尚未触顶的窗口。
func newQuotaRecovery(exhaustedAt time.Time, baseline map[string]any, errorReset time.Time, usageLimitEvidence bool) *QuotaRecovery {
	recovery := &QuotaRecovery{ExhaustedAt: exhaustedAt, Pending: map[string]*time.Time{}}
	for _, key := range accountQuotaWindows {
		if window := quotaWindow(baseline, key); window.limitReached() {
			recovery.Pending[key] = window.reset
		}
	}
	if len(recovery.Pending) == 0 || usageLimitEvidence {
		for _, key := range accountQuotaWindows {
			window := quotaWindow(baseline, key)
			// 错误与 usage 的秒级 reset 可能相差一秒，只用来识别窗口
			if window.reset != nil && !errorReset.IsZero() && math.Abs(float64(window.reset.Unix()-errorReset.Unix())) <= 1 {
				recovery.Pending[key] = window.reset
			}
		}
	}
	// 上游未指出耗尽窗口时保留所有候选，不能任意归给 primary
	if len(recovery.Pending) == 0 {
		for _, key := range accountQuotaWindows {
			if window := quotaWindow(baseline, key); window.present {
				recovery.Pending[key] = window.reset
			}
		}
	}
	return recovery
}

// observe 返回 true 表示全部待解除窗口已有解除证据。
func (r *QuotaRecovery) observe(quota map[string]any) bool {
	hadBaseline := len(r.Pending) > 0
	candidates := map[string]bool{}
	for _, key := range accountQuotaWindows {
		window := quotaWindow(quota, key)
		if !window.present {
			continue
		}
		previous, pending := r.Pending[key]
		if !pending {
			if window.limitReached() {
				r.Pending[key] = window.reset
			}
			continue
		}
		rolled := previous != nil && window.reset != nil && window.reset.After(*previous)
		if rolled && !math.IsNaN(window.used) && window.used < resetRecoveryMaxUsedPercent {
			delete(r.Pending, key)
			continue
		}
		if previous == nil {
			// 首次观测到该窗口只锚定 reset 基线，不构成解除证据
			r.Pending[key] = window.reset
			continue
		}
		if !rolled && !window.limitReached() {
			if r.Candidates[key] {
				delete(r.Pending, key)
			} else {
				candidates[key] = true
			}
		}
	}
	r.Candidates = candidates
	return hadBaseline && len(r.Pending) == 0
}

// allowedAfterReset：耗尽之后记录的 reset 全部到期，且本次快照明确未耗尽（兼容百分比滞后）。
func (r *QuotaRecovery) allowedAfterReset(snapshotExhausted bool, now time.Time) bool {
	if snapshotExhausted || len(r.Pending) == 0 {
		return false
	}
	for _, reset := range r.Pending {
		if reset == nil || !reset.After(r.ExhaustedAt) || reset.After(now) {
			return false
		}
	}
	return true
}

func (r *QuotaRecovery) earliestReset() time.Time {
	var earliest time.Time
	for _, reset := range r.Pending {
		if reset != nil && (earliest.IsZero() || reset.Before(earliest)) {
			earliest = *reset
		}
	}
	return earliest
}

func quotaCooldown(account Account, now time.Time) bool {
	return (account.CooldownReason == string(categoryUsageLimit) || account.CooldownReason == string(categoryQuotaExhausted)) && account.CooldownUntil.After(now)
}

// reconcileQuotaSnapshot 按完整快照更新额度冷却；previous 是替换前的额度（耗尽时的基线）。
func reconcileQuotaSnapshot(account *Account, previous, quota map[string]any, now time.Time) {
	exhausted, until := quotaExhausted(quota, now)
	if !quotaCooldown(*account, now) {
		account.QuotaRecovery = nil
		if exhausted {
			account.CooldownUntil, account.CooldownReason = until, string(categoryUsageLimit)
			account.QuotaRecovery = newQuotaRecovery(now, quota, until, false)
		} else if account.CooldownReason == string(categoryUsageLimit) || account.CooldownReason == string(categoryQuotaExhausted) {
			account.CooldownUntil, account.CooldownReason = time.Time{}, ""
		}
		return
	}
	recovery := account.QuotaRecovery
	if recovery == nil || len(recovery.Pending) == 0 {
		baseline := previous
		if len(baseline) == 0 {
			baseline = quota
		}
		exhaustedAt := account.QuotaExhaustedAt
		if exhaustedAt.IsZero() {
			exhaustedAt = now
		}
		recovery = newQuotaRecovery(exhaustedAt, baseline, account.CooldownUntil, account.CooldownReason == string(categoryUsageLimit))
	}
	if recovery.allowedAfterReset(exhausted, now) || recovery.observe(quota) {
		account.CooldownUntil, account.CooldownReason = time.Time{}, ""
		account.QuotaRecovery = nil
		return
	}
	account.QuotaRecovery = recovery
	if exhausted && until.After(account.CooldownUntil) {
		account.CooldownUntil = until
	}
	// 仍等待确认：冷却至少保持到最早的待解除 reset，最近的复查由后台额度刷新完成
	if earliest := recovery.earliestReset(); earliest.After(account.CooldownUntil) {
		account.CooldownUntil = earliest
	}
	if !account.CooldownUntil.After(now) {
		account.CooldownUntil = now.Add(quotaResetFastInterval)
	}
}
