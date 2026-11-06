package codexgateway

import (
	"errors"
	"os"
	"slices"
	"time"
)

// errBPSNotAuthorized：账号没有 BPS 授权。
var errBPSNotAuthorized = errors.New("account has no BPS authorization")

// UpdateBPS 在锁内修改账号的 BPS 授权与状态；fn 返回 false 时不保存。
func (s *Store) UpdateBPS(id string, fn func(account *Account) bool) (Account, error) {
	s.mu.Lock()
	account, ok := s.accounts[id]
	if !ok {
		s.mu.Unlock()
		return Account{}, os.ErrNotExist
	}
	if account.BPS != nil {
		grant := *account.BPS
		account.BPS = &grant
	}
	if !fn(&account) {
		s.mu.Unlock()
		return account, nil
	}
	account.RuntimeRevision++
	s.accounts[id] = account
	s.mu.Unlock()
	return account, s.persist()
}

// DisposeBPS 处置 BPS 通道的失败：限流、模型无权、授权失效、账号级 403 只写 Account.BPS；
// 额度耗尽是同一 ChatGPT 账号的共享事实，交给原有处置（两条通道一起跳过）。
func (s *Store) DisposeBPS(id, model string, failure upstreamFailure, now time.Time) {
	switch failure.Category {
	case categoryUsageLimit, categoryQuotaExhausted:
		s.Dispose(id, model, failure, now)
		return
	}
	_, _ = s.UpdateBPS(id, func(account *Account) bool {
		grant := account.BPS
		if grant == nil {
			return false
		}
		switch {
		case failure.bpsUsagePolicy:
			if !disposeBPSUsagePolicy(grant, account.BPSSettings, failure.bpsSession, now) {
				return false
			}
			grant.LastError = "usage_policy"
			return true
		}
		switch failure.Category {
		case categoryRateLimited:
			if !disposeBPSRateLimit(grant, account.BPSSettings, model, failure, now) {
				return false
			}
		case categoryModelUnsupported:
			if model == "" {
				return false
			}
			if grant.ModelCooldowns == nil {
				grant.ModelCooldowns = map[string]time.Time{}
			}
			grant.ModelCooldowns[model] = now.Add(modelUnsupportedCooldown)
		case categoryCredentialExpired:
			// AT 被拒：有刷新令牌时标记过期让刷新器尽快换新，否则需要重新授权；
			// 被拒后刷新得到的 AT 再被拒，说明授权本身失效（对齐 sub2api refreshed_access_token_rejected）
			switch {
			case grant.RefreshedAfterRejection:
				grant.State = bpsStateInvalid
				grant.LastError = "refreshed_access_token_rejected"
				return true
			case grant.RefreshToken != "":
				grant.ExpiresAt, grant.AccessRejected = now, true
			default:
				grant.State = bpsStateExpired
			}
		case categoryIdentityVerification:
			grant.State = bpsStateInvalid
		case categoryBanned:
			// 账号/工作区级 403：开启自动停用时停用 BPS，否则只对本请求换号
			if account.BPSSettings == nil || !account.BPSSettings.AutoDisableOn403 {
				return false
			}
			grant.State = bpsStateBlocked
			grant.BlockedAt = now
			grant.ProbedAt = time.Time{}
			grant.RecoveryStopped = false
		default:
			return false
		}
		grant.LastError = string(failure.Category)
		return true
	})
}

// RecordBPSSuccess 在 BPS 请求成功后清除通道级限流冷却、账号的 usage-policy 退避（含命中会话计数）、AT 被拒标记与最近错误。
func (s *Store) RecordBPSSuccess(id, model string) {
	_, _ = s.UpdateBPS(id, func(account *Account) bool {
		grant := account.BPS
		if grant == nil {
			return false
		}
		if grant.LastError == "" && grant.CooldownUntil.IsZero() && len(grant.PolicyBackoff) == 0 && !grant.AccessRejected && !grant.RefreshedAfterRejection {
			return false
		}
		grant.LastError = ""
		grant.CooldownUntil = time.Time{}
		grant.PolicyBackoff = nil
		grant.AccessRejected, grant.RefreshedAfterRejection = false, false
		return true
	})
}

// bpsRecoveryWait 返回最早有 BPS 账号冷却到期、重新可选（就绪或仅受并发阻塞）所需的等待；limit 内没有则 ok=false。
// 只用于不能改走原生通道的请求：BPS 429 冷却通常只有数秒，等它到期比立刻把 429 交给调用方更合适。
func (s *Store) bpsRecoveryWait(req selectRequest, now time.Time, limit time.Duration) (time.Duration, bool) {
	if !req.BPS || limit <= 0 {
		return 0, false
	}
	deadline := now.Add(limit)
	s.mu.Lock()
	defer s.mu.Unlock()
	var instants []time.Time
	add := func(at time.Time) {
		if at.After(now) && !at.After(deadline) {
			instants = append(instants, at)
		}
	}
	for id, account := range s.accounts {
		grant := account.BPS
		if grant == nil || req.Exclude[id] {
			continue
		}
		add(grant.CooldownUntil)
		add(grant.ModelCooldowns[req.Model])
		// usage-policy 退避不等：这类拒绝多为账号被上游封禁，等到期只会再撞一次
		for _, until := range grant.ScopedCooldowns {
			add(until)
		}
	}
	slices.SortFunc(instants, func(a, b time.Time) int { return a.Compare(b) })
	for _, at := range instants {
		// 到期时刻之后一点点再看：冷却以 After(now) 判定，恰好在到期时刻仍算冷却中
		at = at.Add(time.Millisecond)
		if set := s.collect(req, at, nil); len(set.ready) > 0 || len(set.blocked) > 0 {
			return at.Sub(now), true
		}
	}
	return 0, false
}
