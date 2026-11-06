package codexgateway

import (
	"context"
	"encoding/json"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"
)

const (
	bpsEndpointResponses   = "responses"
	bpsEndpointAttachments = "attachments"
	// bpsEndpointHeader 只出现在 Worker 自己构造的附件失败响应上，标记被拒端点（不来自上游）
	bpsEndpointHeader = "X-Kin-Bps-Endpoint"
)

// usage-policy 403 退避（对齐 hloolx/codex2api）：首次 30 秒，之后 60、120、240、300 秒封顶。
var bpsPolicyBackoffSteps = []time.Duration{30 * time.Second, 60 * time.Second, 120 * time.Second, 240 * time.Second, 300 * time.Second}

const (
	// bpsPolicyAccountKey：usage-policy 退避按账号记（PolicyBackoff 的唯一键）。上游的这类拒绝针对整个账号，
	// 按模型分别退避会让被封账号在每个模型上各撞一遍
	bpsPolicyAccountKey = "*"
	// bpsPolicyBlockSessions：连续命中（期间没有一次成功）来自这么多个不同会话时，开启“403 自动停用”的账号
	// 停用 BPS，交给 403 恢复探测；要求不同会话，避免单个会话的内容误伤账号
	bpsPolicyBlockSessions = 3
	bpsPolicyMaxSessions   = 8
)

func bpsCooldownKey(model, endpoint string) string {
	switch {
	case model != "" && endpoint != "":
		return "model:" + model + "|endpoint:" + endpoint
	case model != "":
		return "model:" + model
	case endpoint != "":
		return "endpoint:" + endpoint
	}
	return ""
}

// bpsEndpointName 把上游声明的端点（路径或 bps.openai.com 绝对地址）归一为 responses / attachments。
func bpsEndpointName(value string) string {
	value = strings.TrimSpace(value)
	if parsed, err := url.Parse(value); err == nil && parsed.Path != "" {
		value = parsed.Path
	}
	value = strings.TrimSuffix(value, "/")
	switch {
	case value == bpsEndpointResponses || strings.HasSuffix(value, "/"+bpsEndpointResponses):
		return bpsEndpointResponses
	case value == bpsEndpointAttachments || strings.HasSuffix(value, "/"+bpsEndpointAttachments):
		return bpsEndpointAttachments
	case value == bpsImageOpGenerations || strings.HasSuffix(value, "/images/generations"):
		return bpsImageOpGenerations
	case value == bpsImageOpEdits || strings.HasSuffix(value, "/images/edits"):
		return bpsImageOpEdits
	}
	return value
}

// parseBPSRateLimit 解析 BPS 429 的冷却范围（对齐 sub2api parseExcelBPSRateLimitFailure）：只有显式 error.scope
// （account / bps / model / endpoint / model_endpoint，或带 type/model/endpoint 的对象）能收窄范围；目标与本次
// 模型/端点矛盾时返回 ok=false（只换号，不扩大为账号冷却）。未知范围按整个 BPS 通道。重置时间只在范围可识别时采用。
func parseBPSRateLimit(raw []byte, model, endpoint string, now time.Time) (key string, resetAt time.Time, ok bool) {
	var envelope struct {
		Error    json.RawMessage `json:"error"`
		Response struct {
			Error json.RawMessage `json:"error"`
		} `json:"response"`
	}
	if len(raw) == 0 || len(raw) > 512<<10 || json.Unmarshal(raw, &envelope) != nil {
		return "", time.Time{}, true
	}
	detailRaw := envelope.Error
	if len(envelope.Response.Error) > 0 {
		detailRaw = envelope.Response.Error
	}
	var detail struct {
		Scope           json.RawMessage `json:"scope"`
		Model           string          `json:"model"`
		Endpoint        string          `json:"endpoint"`
		ResetsAt        json.RawMessage `json:"resets_at"`
		ResetsInSeconds json.RawMessage `json:"resets_in_seconds"`
		RetryAfter      json.RawMessage `json:"retry_after"`
	}
	if json.Unmarshal(detailRaw, &detail) != nil {
		return "", time.Time{}, true
	}
	var declared struct {
		Type     string `json:"type"`
		Model    string `json:"model"`
		Endpoint string `json:"endpoint"`
	}
	if json.Unmarshal(detail.Scope, &declared.Type) == nil {
		declared.Model, declared.Endpoint = detail.Model, detail.Endpoint
	} else if json.Unmarshal(detail.Scope, &declared) != nil {
		return "", time.Time{}, true
	}
	var scopedModel, scopedEndpoint string
	switch declared.Type {
	case "account", "bps":
	case "model", "endpoint", "model_endpoint":
		if declared.Type != "endpoint" {
			if model == "" || (declared.Model != "" && strings.TrimSpace(declared.Model) != model) {
				return "", time.Time{}, false
			}
			scopedModel = model
		}
		if declared.Type != "model" {
			if endpoint == "" || (declared.Endpoint != "" && bpsEndpointName(declared.Endpoint) != endpoint) {
				return "", time.Time{}, false
			}
			scopedEndpoint = endpoint
		}
	default:
		return "", time.Time{}, true
	}
	for _, value := range []json.RawMessage{detail.RetryAfter, detail.ResetsInSeconds} {
		if seconds, err := strconv.ParseFloat(rateLimitScalar(value), 64); err == nil && seconds > 0 && seconds <= 7*24*3600 {
			if until := now.Add(time.Duration(seconds * float64(time.Second))); until.After(resetAt) {
				resetAt = until
			}
		}
	}
	if seconds, err := strconv.ParseInt(rateLimitScalar(detail.ResetsAt), 10, 64); err == nil {
		if until := time.Unix(seconds, 0); until.Year() <= 9999 && until.After(now) && until.After(resetAt) {
			resetAt = until
		}
	}
	return bpsCooldownKey(scopedModel, scopedEndpoint), resetAt, true
}

func rateLimitScalar(raw json.RawMessage) string {
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return strings.TrimSpace(text)
	}
	var number json.Number
	if json.Unmarshal(raw, &number) == nil {
		return number.String()
	}
	return ""
}

// bpsRefreshRetry（对齐 sub2api refreshRejectedExcelPrimary）：BPS 返回 401 且授权有刷新令牌时，刷新授权后
// 在同一账号上重发一次。并发请求只刷新一次：令牌已被其他请求换新时直接用新令牌重发。
func (d *dispatchRun) bpsRefreshRetry(ctx context.Context, account Account, failure upstreamFailure) (Account, bool) {
	if !d.bpsAttempt || d.bpsRefreshRetried || failure.Status != 401 || account.BPS == nil || account.BPS.RefreshToken == "" {
		return account, false
	}
	d.bpsRefreshRetried = true
	s := d.server
	used := account.BPS.AccessToken
	s.bps.refreshMu.Lock()
	current, ok := s.store.Get(account.ID)
	if ok && current.BPS != nil && current.BPS.AccessToken == used {
		// 标记 AT 被拒：刷新得到的新 AT 记为“被拒后刷新”，它再被拒就判授权失效
		_, _ = s.store.UpdateBPS(account.ID, func(account *Account) bool {
			if account.BPS == nil || account.BPS.AccessToken != used || account.BPS.AccessRejected {
				return false
			}
			account.BPS.AccessRejected = true
			return true
		})
		refreshCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
		err := s.refreshBPS(refreshCtx, account.ID)
		cancel()
		if err == nil {
			current, ok = s.store.Get(account.ID)
		} else {
			ok = false
		}
	}
	s.bps.refreshMu.Unlock()
	if !ok || current.BPS == nil || current.BPS.AccessToken == "" || current.BPS.AccessToken == used || current.BPS.State != "" {
		return account, false
	}
	return current, true
}

// disposeBPSRateLimit 写入 429 冷却；返回 false 表示上游声明的范围与本次请求矛盾，不写冷却（只换号）。
func disposeBPSRateLimit(grant *BPSGrant, settings *BPSSettings, model string, failure upstreamFailure, now time.Time) bool {
	key, resetAt, ok := parseBPSRateLimit(failure.Body, model, failure.bpsEndpoint, now)
	if !ok {
		return false
	}
	delay := settings.rateLimitCooldown()
	if failure.HasRetryAfter {
		delay = clampDuration(failure.RetryAfter, bpsRateLimitMinCooldown, bpsRateLimitMaxCooldown)
	}
	until := now.Add(delay)
	if resetAt.After(until) {
		until = resetAt
	}
	if key == "" {
		if until.After(grant.CooldownUntil) {
			grant.CooldownUntil = until
		}
		return true
	}
	if grant.ScopedCooldowns == nil {
		grant.ScopedCooldowns = map[string]time.Time{}
	}
	for k, v := range grant.ScopedCooldowns {
		if !v.After(now) {
			delete(grant.ScopedCooldowns, k)
		}
	}
	if until.After(grant.ScopedCooldowns[key]) {
		grant.ScopedCooldowns[key] = until
	}
	return true
}

// disposeBPSUsagePolicy 记一次 usage-policy 拒绝：按账号退避（冷却期内的并发失败不延长期限），并记下所在会话；
// 连续命中来自 bpsPolicyBlockSessions 个不同会话且开启“403 自动停用”时停用 BPS（交给恢复探测）。
func disposeBPSUsagePolicy(grant *BPSGrant, settings *BPSSettings, session string, now time.Time) bool {
	if grant.PolicyBackoff == nil {
		grant.PolicyBackoff = map[string]bpsBackoff{}
	}
	backoff := grant.PolicyBackoff[bpsPolicyAccountKey]
	changed := false
	if session != "" && !slices.Contains(backoff.Sessions, session) {
		backoff.Sessions = append(backoff.Sessions, session)
		if len(backoff.Sessions) > bpsPolicyMaxSessions {
			backoff.Sessions = backoff.Sessions[len(backoff.Sessions)-bpsPolicyMaxSessions:]
		}
		changed = true
	}
	if !backoff.Until.After(now) {
		step := bpsPolicyBackoffSteps[min(backoff.Strikes, len(bpsPolicyBackoffSteps)-1)]
		backoff.Until, backoff.Strikes = now.Add(step), backoff.Strikes+1
		changed = true
	}
	if !changed {
		return false
	}
	if len(backoff.Sessions) >= bpsPolicyBlockSessions && settings != nil && settings.AutoDisableOn403 {
		grant.State, grant.BlockedAt, grant.ProbedAt, grant.RecoveryStopped = bpsStateBlocked, now, time.Time{}, false
		grant.PolicyBackoff = nil
		return true
	}
	grant.PolicyBackoff = map[string]bpsBackoff{bpsPolicyAccountKey: backoff}
	return true
}
