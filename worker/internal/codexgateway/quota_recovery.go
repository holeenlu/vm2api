package codexgateway

import (
	"math"
	"time"
)

// 额度耗尽的判定与解除（对齐 codex-proxy-rs credential/quota/snapshot.rs 与 recovery.rs）：
// 额度耗尽是账号的访问结论（CooldownReason 为 usage_limit / quota_exhausted），只由证据设置、只由证据解除；
// CooldownUntil 只表示何时该向上游复查，到期本身不是恢复证据。完整快照（/wham/usage）的访问结论取默认
// codex 桶：allowed=true 放行、allowed=false 或 limit_reached 判耗尽，其余未知；有可用点数时直接放行。
// 已耗尽的账号只在以下情况解除，单次未触顶的观测不够，避免耗尽后立刻拉到的旧快照误解封：
//   - 记录的耗尽窗口全部滚动到新窗口（reset 前进）且新窗口用量低于 10%；
//   - 或同一窗口连续两次报告未触顶（reset 未滚动、用量回落）；
//   - 或耗尽之后的全部 reset 都已到期，且本次快照明确放行。
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

// allowedAfterReset：耗尽之后记录的 reset 全部到期，且本次快照明确放行（兼容百分比滞后）。
func (r *QuotaRecovery) allowedAfterReset(snapshotAllowed bool, now time.Time) bool {
	if !snapshotAllowed || len(r.Pending) == 0 {
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

// quotaExhaustedFact：账号处于额度耗尽结论，与冷却是否到期无关。
func quotaExhaustedFact(account Account) bool {
	return account.CooldownReason == string(categoryUsageLimit) || account.CooldownReason == string(categoryQuotaExhausted)
}

// 快照访问结论（quotaFromUsage 写入 quota["access"]）
const (
	quotaAccessAllowed   = "allowed"
	quotaAccessExhausted = "exhausted"
)

// reconcileQuotaSnapshot 按完整快照更新额度结论（CPR reconcile_refresh）；previous 是替换前的额度（耗尽时的基线）。
func reconcileQuotaSnapshot(account *Account, previous, quota map[string]any, now time.Time) {
	access, _ := quota["access"].(string)
	if usable, _ := quota["credits_usable"].(bool); usable {
		// 点数独立于套餐窗口：直接放行并丢弃窗口恢复进度
		if quotaExhaustedFact(*account) {
			account.CooldownUntil, account.CooldownReason = time.Time{}, ""
		}
		account.QuotaRecovery = nil
		return
	}
	if !quotaExhaustedFact(*account) {
		account.QuotaRecovery = nil
		if access == quotaAccessExhausted {
			_, until := quotaExhausted(quota, now)
			if reset := quotaAccessReset(quota); !reset.IsZero() {
				until = reset
			}
			account.CooldownUntil, account.CooldownReason = until, string(categoryUsageLimit)
			account.QuotaExhaustedAt = now
			account.QuotaRecovery = newQuotaRecovery(now, quota, until, false)
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
	if recovery.allowedAfterReset(access == quotaAccessAllowed, now) || recovery.observe(quota) {
		account.CooldownUntil, account.CooldownReason = time.Time{}, ""
		account.QuotaRecovery = nil
		return
	}
	account.QuotaRecovery = recovery
	// 仍未确认解除：保持耗尽结论，复查时刻取最早的待解除 reset（可能已过去，由后台额度刷新按到期节奏复查）
	if earliest := recovery.earliestReset(); !earliest.IsZero() {
		account.CooldownUntil = earliest
	} else if _, until := quotaExhausted(quota, now); until.After(account.CooldownUntil) {
		account.CooldownUntil = until
	}
}

// quotaAccessReset 是快照记录的耗尽窗口最早 reset（quota["access_reset_at"]）。
func quotaAccessReset(quota map[string]any) time.Time {
	text, _ := quota["access_reset_at"].(string)
	at, _ := time.Parse(time.RFC3339Nano, text)
	return at
}
