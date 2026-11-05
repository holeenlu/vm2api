package codexgateway

import (
	"errors"
	"os"
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
			if !disposeBPSUsagePolicy(grant, model, now) {
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
			// AT 被拒：有刷新令牌时标记过期让刷新器尽快换新，否则需要重新授权
			if grant.RefreshToken != "" {
				grant.ExpiresAt = now
			} else {
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

// RecordBPSSuccess 在 BPS 请求成功后清除通道级限流冷却、该模型的 usage-policy 退避与最近错误。
func (s *Store) RecordBPSSuccess(id, model string) {
	_, _ = s.UpdateBPS(id, func(account *Account) bool {
		grant := account.BPS
		if grant == nil {
			return false
		}
		_, backoff := grant.PolicyBackoff[model]
		if grant.LastError == "" && grant.CooldownUntil.IsZero() && !backoff {
			return false
		}
		grant.LastError = ""
		grant.CooldownUntil = time.Time{}
		if backoff {
			delete(grant.PolicyBackoff, model)
		}
		return true
	})
}
