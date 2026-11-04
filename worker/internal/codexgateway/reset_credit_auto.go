package codexgateway

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"math/rand/v2"
	"sort"
	"strings"
	"sync"
	"time"
)

// 自动使用重置卡（对齐 codex-proxy-rs gateway-admin reset_credit_automation）：账号开启后，每天在当地次日
// 随机时刻发现可用卡片，在卡片到期前 lead 分钟（前 10%、最多一分钟按账号错峰）自动消费最早到期的一张。
// 消费前先把幂等键落盘，结果不明时沿原键重试；可选“剩余周额度上限”，周额度剩余高于上限时暂缓。
// 只由控制面指定的一个在线实例执行（与预热相同），手动与自动消费共用账号锁。
const (
	resetCreditAutoTick       = 5 * time.Second
	resetCreditAutoBatch      = 100
	resetCreditAutoBudget     = 30 * time.Second
	defaultResetCreditLeadMin = 10
)

// ResetCreditPolicy 由控制面 routing.codex.reset_credit 下发；Enabled=false 表示本实例不执行。
type ResetCreditPolicy struct {
	Enabled                   bool `json:"enabled"`
	LeadMinutes               int  `json:"lead_minutes"`
	MaxWeeklyRemainingPercent *int `json:"max_weekly_remaining_percent,omitempty"`
}

func (p *ResetCreditPolicy) lead() int {
	if p == nil || p.LeadMinutes < 1 || p.LeadMinutes > 1440 {
		return defaultResetCreditLeadMin
	}
	return p.LeadMinutes
}

type PlannedResetCredit struct {
	ID        string    `json:"id"`
	ExpiresAt time.Time `json:"expires_at"`
}

type PendingResetCredit struct {
	Credit   PlannedResetCredit `json:"credit"`
	RedeemID string             `json:"redeem_request_id"`
}

// ResetCreditPlan 是账号的自动使用计划；不保存凭据或完整卡片。
type ResetCreditPlan struct {
	NextDiscoveryAt time.Time            `json:"next_discovery_at"`
	Credits         []PlannedResetCredit `json:"credits,omitempty"`
	Pending         *PendingResetCredit  `json:"pending,omitempty"`
	RetryAt         time.Time            `json:"retry_at,omitempty"`
	Failures        int                  `json:"failures,omitempty"`
	LastResult      string               `json:"last_result,omitempty"`
}

func (p *ResetCreditPlan) clone() *ResetCreditPlan {
	if p == nil {
		return nil
	}
	out := *p
	out.Credits = append([]PlannedResetCredit(nil), p.Credits...)
	if p.Pending != nil {
		pending := *p.Pending
		out.Pending = &pending
	}
	return &out
}

// consumeAt：到期前 lead 分钟消费；提前窗口的前 10%（最多一分钟）按账号与卡片错峰。
func resetCreditConsumeAt(accountID string, credit PlannedResetCredit, lead int) time.Time {
	leadSeconds := int64(lead) * 60
	spread := min(max(leadSeconds/10, 1), 60)
	sum := sha256.Sum256([]byte(accountID + "\x00" + credit.ID))
	offset := int64(binary.BigEndian.Uint16(sum[:2])) % spread
	return credit.ExpiresAt.Add(-time.Duration(leadSeconds-offset) * time.Second)
}

func (p *ResetCreditPlan) nextConsumption(accountID string, lead int) time.Time {
	var next time.Time
	for _, credit := range p.Credits {
		if at := resetCreditConsumeAt(accountID, credit, lead); next.IsZero() || at.Before(next) {
			next = at
		}
	}
	return next
}

// nextRun：重试时刻优先；有未决消费立即继续；否则取下次消费与下次发现中较早者。
func (p *ResetCreditPlan) nextRun(accountID string, lead int, now time.Time) time.Time {
	if !p.RetryAt.IsZero() {
		return p.RetryAt
	}
	if p.Pending != nil {
		return now
	}
	if next := p.nextConsumption(accountID, lead); !next.IsZero() && next.Before(p.NextDiscoveryAt) {
		return next
	}
	return p.NextDiscoveryAt
}

// nextResetCreditDiscovery：当地（UTC+8）次日的随机时刻。
func nextResetCreditDiscovery(now time.Time) time.Time {
	local := now.In(systemZone)
	start := time.Date(local.Year(), local.Month(), local.Day()+1, 0, 0, 0, 0, systemZone)
	return start.Add(time.Duration(rand.Int64N(int64(24 * time.Hour)))).UTC()
}

// observe 记录可用且未到期的卡片（按到期排序去重），并在需要时推进下次发现。
func (p *ResetCreditPlan) observe(list map[string]any, now time.Time) {
	credits, _ := list["credits"].([]map[string]any)
	seen := map[string]bool{}
	p.Credits = p.Credits[:0]
	for _, credit := range credits {
		id, _ := credit["id"].(string)
		status, _ := credit["status"].(string)
		expiry, _ := credit["expires_at"].(string)
		at, err := time.Parse(time.RFC3339Nano, expiry)
		if id == "" || seen[id] || status != "available" || err != nil || !at.After(now) {
			continue
		}
		seen[id] = true
		p.Credits = append(p.Credits, PlannedResetCredit{ID: id, ExpiresAt: at.UTC()})
	}
	sort.Slice(p.Credits, func(i, j int) bool { return p.Credits[i].ExpiresAt.Before(p.Credits[j].ExpiresAt) })
	if !p.NextDiscoveryAt.After(now) || p.NextDiscoveryAt.In(systemZone).YearDay() == now.In(systemZone).YearDay() {
		p.NextDiscoveryAt = nextResetCreditDiscovery(now)
	}
	if p.Pending == nil {
		p.RetryAt = time.Time{}
		p.Failures = 0
	}
}

// failed：发现失败且没有到期卡片时等到下次发现；否则 30s×2^n（上限 300s）加 30s 内抖动重试。
func (p *ResetCreditPlan) failed(accountID string, lead int, now time.Time) {
	if next := p.nextConsumption(accountID, lead); p.Pending == nil && (next.IsZero() || next.After(now)) {
		p.NextDiscoveryAt = nextResetCreditDiscovery(now)
		p.RetryAt = time.Time{}
		p.LastResult = "discovery_failed"
		return
	}
	p.Failures++
	delay := min(30*time.Second<<min(p.Failures-1, 3), 300*time.Second) + time.Duration(rand.Int64N(int64(30*time.Second)))
	p.RetryAt = now.Add(delay)
	p.LastResult = "discovery_failed"
	if p.Pending != nil {
		p.LastResult = "pending"
	}
}

// deferred：暂不满足条件时不丢弃卡片，也不建立未决消费，30～60s 后（不晚于最早到期）再判断。
func (p *ResetCreditPlan) deferred(reason string, now time.Time) {
	retry := now.Add(30*time.Second + time.Duration(rand.Int64N(int64(30*time.Second))))
	if len(p.Credits) > 0 && p.Credits[0].ExpiresAt.Before(retry) {
		retry = p.Credits[0].ExpiresAt
	}
	p.RetryAt = retry
	p.LastResult = reason
	p.Failures = 0
}

// resetCreditLocks 串行化同一账号的重置卡消费（手动与自动共用），避免并发连续消费两张卡。
type resetCreditLocks struct {
	mu    sync.Mutex
	locks map[string]*sync.Mutex
}

func (l *resetCreditLocks) lock(accountID string) func() {
	l.mu.Lock()
	if l.locks == nil {
		l.locks = map[string]*sync.Mutex{}
	}
	lock := l.locks[accountID]
	if lock == nil {
		lock = &sync.Mutex{}
		l.locks[accountID] = lock
	}
	l.mu.Unlock()
	lock.Lock()
	return lock.Unlock
}

func (s *Server) resetCreditLoop(ctx context.Context) {
	ticker := time.NewTicker(resetCreditAutoTick)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			s.runResetCreditAutomation(ctx, now)
		}
	}
}

func (s *Server) runResetCreditAutomation(ctx context.Context, now time.Time) {
	policy := s.runtime.resetCreditPolicy()
	if policy == nil || !policy.Enabled {
		return
	}
	lead := policy.lead()
	ctx, cancel := context.WithTimeout(ctx, resetCreditAutoBudget)
	defer cancel()
	due := 0
	for _, account := range s.store.snapshot() {
		if due >= resetCreditAutoBatch || ctx.Err() != nil {
			return
		}
		if !account.ResetCreditAuto || !account.Enabled || account.Paused || account.APIKey != "" || !credentialUsable(account, now) {
			continue
		}
		if plan := account.ResetCreditPlan; plan != nil && plan.nextRun(account.ID, lead, now).After(now) {
			continue
		}
		due++
		s.reconcileResetCredit(ctx, account.ID, policy, time.Now())
	}
}

// reconcileResetCredit 执行一个账号的一轮自动使用：发现、选卡、周额度门槛、先落盘幂等键再消费。
func (s *Server) reconcileResetCredit(ctx context.Context, accountID string, policy *ResetCreditPolicy, now time.Time) {
	unlock := s.resetLocks.lock(accountID)
	defer unlock()
	account, ok := s.store.Get(accountID)
	if !ok || !account.ResetCreditAuto {
		return
	}
	lead := policy.lead()
	plan := account.ResetCreditPlan.clone()
	if plan == nil {
		// 首次开启错开一分钟
		plan = &ResetCreditPlan{NextDiscoveryAt: now.Add(time.Duration(rand.Int64N(int64(time.Minute))))}
		s.store.SetResetCreditPlan(accountID, plan)
		return
	}
	kept := plan.Credits[:0]
	for _, credit := range plan.Credits {
		if credit.ExpiresAt.After(now) {
			kept = append(kept, credit)
		}
	}
	plan.Credits = kept
	if plan.Pending != nil && !plan.Pending.Credit.ExpiresAt.After(now) {
		plan.Pending, plan.RetryAt, plan.LastResult = nil, time.Time{}, "expired_unknown"
	}
	if plan.RetryAt.After(now) {
		s.store.SetResetCreditPlan(accountID, plan)
		return
	}
	next := plan.nextConsumption(accountID, lead)
	dueCredit := !next.IsZero() && !next.After(now)
	if plan.Pending == nil && (dueCredit || !plan.NextDiscoveryAt.After(now) || !plan.RetryAt.IsZero()) {
		// 先保存下一次发现与重试时刻：查询被取消或进程重启也不会重复刷发现接口
		if !plan.NextDiscoveryAt.After(now) {
			plan.NextDiscoveryAt = nextResetCreditDiscovery(now)
		}
		if dueCredit || !plan.RetryAt.IsZero() {
			plan.RetryAt = now.Add(30 * time.Second)
		}
		s.store.SetResetCreditPlan(accountID, plan)
		callCtx, cancel := context.WithTimeout(ctx, accountRequestTimeout)
		list, err := s.listResetCredits(callCtx, account)
		cancel()
		if err != nil {
			plan.failed(accountID, lead, time.Now())
			s.store.SetResetCreditPlan(accountID, plan)
			return
		}
		plan.observe(list, time.Now())
		var chosen *PlannedResetCredit
		for i := range plan.Credits {
			if !resetCreditConsumeAt(accountID, plan.Credits[i], lead).After(time.Now()) {
				chosen = &plan.Credits[i]
				break
			}
		}
		if chosen != nil {
			if limit := policy.MaxWeeklyRemainingPercent; limit != nil {
				if reason := s.weeklyResetCreditGate(ctx, accountID, *limit); reason != "" {
					plan.deferred(reason, time.Now())
					s.store.SetResetCreditPlan(accountID, plan)
					return
				}
			}
			if !chosen.ExpiresAt.After(time.Now()) {
				s.store.SetResetCreditPlan(accountID, plan)
				return
			}
			plan.Pending = &PendingResetCredit{Credit: *chosen, RedeemID: newUUIDv4()}
			plan.LastResult = "pending"
			plan.RetryAt = time.Now().Add(30 * time.Second)
			// 必须在发送消费请求前落盘：进程退出或响应丢失后沿用同一幂等键
			s.store.SetResetCreditPlan(accountID, plan)
		}
	}
	if plan.Pending == nil {
		s.store.SetResetCreditPlan(accountID, plan)
		return
	}
	pending := *plan.Pending
	callCtx, cancel := context.WithTimeout(ctx, 2*accountRequestTimeout)
	result, _, err := s.consumeResetCreditLocked(callCtx, accountID, pending.Credit.ID, pending.RedeemID)
	cancel()
	if err != nil {
		plan.failed(accountID, lead, time.Now())
		s.store.SetResetCreditPlan(accountID, plan)
		return
	}
	code, _ := result["code"].(string)
	plan.Pending = nil
	if code == "nothing_to_reset" {
		plan.deferred("nothing_to_reset", time.Now())
		s.store.SetResetCreditPlan(accountID, plan)
		return
	}
	kept = plan.Credits[:0]
	for _, credit := range plan.Credits {
		if credit.ID != pending.Credit.ID {
			kept = append(kept, credit)
		}
	}
	plan.Credits = kept
	plan.RetryAt, plan.Failures = time.Time{}, 0
	plan.LastResult = "not_redeemed"
	if resetCreditConfirmed(code) {
		plan.LastResult = code
	}
	s.store.SetResetCreditPlan(accountID, plan)
}

func resetCreditConfirmed(code string) bool {
	switch strings.ToLower(strings.TrimSpace(code)) {
	case "reset", "already_redeemed":
		return true
	}
	return false
}

// weeklyResetCreditGate：读取最新额度，周窗口（7 天）剩余高于上限时暂缓；没有周窗口时同样暂缓。
func (s *Server) weeklyResetCreditGate(ctx context.Context, accountID string, maxRemaining int) string {
	callCtx, cancel := context.WithTimeout(ctx, accountRequestTimeout)
	_, _, err := s.queryQuota(callCtx, accountID)
	cancel()
	account, ok := s.store.Get(accountID)
	if err != nil || !ok {
		return "weekly_quota_unavailable"
	}
	for _, key := range accountQuotaWindows {
		window, _ := account.Quota[key].(map[string]any)
		minutes, _ := window["window_minutes"].(float64)
		used, okUsed := window["used_percent"].(float64)
		if minutes < 7*24*60 || !okUsed {
			continue
		}
		if 100-min(max(used, 0), 100) > float64(maxRemaining) {
			return "weekly_quota_above_threshold"
		}
		return ""
	}
	return "weekly_quota_unavailable"
}

// resetCreditStatus 是账号详情的自动使用状态（不含卡片 ID 与幂等键）。
func resetCreditStatus(account Account, policy *ResetCreditPolicy, now time.Time) map[string]any {
	status := map[string]any{"enabled": account.ResetCreditAuto, "lead_minutes": policy.lead()}
	plan := account.ResetCreditPlan
	if !account.ResetCreditAuto || plan == nil {
		return status
	}
	status["next_discovery_at"] = plan.NextDiscoveryAt
	next := plan.nextConsumption(account.ID, policy.lead())
	if next.IsZero() && plan.Pending != nil {
		next = resetCreditConsumeAt(account.ID, plan.Pending.Credit, policy.lead())
	}
	if !next.IsZero() {
		if plan.RetryAt.After(next) {
			next = plan.RetryAt
		}
		status["next_consume_at"] = next
	}
	if plan.LastResult != "" {
		status["last_result"] = plan.LastResult
	}
	if plan.Pending != nil && !plan.Pending.Credit.ExpiresAt.After(now) {
		status["last_result"] = "expired_unknown"
	}
	return status
}
