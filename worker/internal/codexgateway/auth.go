package codexgateway

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

type Envelope struct {
	Version   int               `json:"version"`
	Dispatch  string            `json:"dispatch_id"`
	RequestID string            `json:"request_id"`
	AttemptID string            `json:"attempt_id,omitempty"`
	Scope     Scope             `json:"pool_scope"`
	Operation string            `json:"operation"`
	Protocol  string            `json:"protocol"`
	Model     string            `json:"model"`
	Stream    bool              `json:"stream"`
	Body      json.RawMessage   `json:"body"`
	Headers   map[string]string `json:"headers,omitempty"`
	// Scheduling 是控制面冻结的调度策略（策略、亲和、smart 系数、等待预算）。
	Scheduling SchedulingPolicy `json:"scheduling,omitempty"`
	// ConnectionKey 标识一条入站 Responses WebSocket；同一键绑定同一条上游 WS（连接内续接、控制帧）。
	ConnectionKey string `json:"connection_key,omitempty"`
	// Transport 为 routing.codex.upstream_transport：prefer_websocket（默认）或 http。
	Transport string `json:"upstream_transport,omitempty"`
	// ReplayBody 是展开 previous_response_id 后的完整历史；原生续接不可用时改发它。
	ReplayBody json.RawMessage `json:"replay_body,omitempty"`
	// AccountProtection 是控制面当前的账号错误保护策略（含指纹）；缺省按关闭处理。
	AccountProtection *ProtectionPolicy `json:"account_protection,omitempty"`
	// ClientScope 是调用方范围的不透明哈希（同一 API Key），用于 Guardian 父响应归属隔离。
	ClientScope string `json:"client_scope,omitempty"`
	// FastMode 是分组的 Fast 三态策略：default（保留客户端选择）/ enabled / disabled。
	FastMode string `json:"fast_mode,omitempty"`
	// ClientProfile 是本请求的上游客户端画像选择（Key 覆盖优先，否则通用设置）；缺省为 Desktop · macOS · 最新。
	ClientProfile     *ClientProfileSelection `json:"client_profile,omitempty"`
	ProfileDeployment ProfileDeployment       `json:"profile_deployment,omitempty"`
	// Privacy 是控制面当前的隐私规则（含指纹），按顺序作用于 turn metadata、Git 上下文、环境文本、正文与请求头。
	Privacy *PrivacyPolicy `json:"privacy,omitempty"`
	// RequestLocation 是控制面开启的全局请求位置；账号代理有位置时以代理为准
	RequestLocation *RequestLocation `json:"request_location,omitempty"`
	ExpiresAt       time.Time        `json:"expires_at"`
	Nonce           string           `json:"nonce"`
}

type Scope struct {
	ScopeIDs           []string `json:"scope_ids,omitempty"`
	GroupIDs           []int64  `json:"group_ids,omitempty"`
	Model              string   `json:"model,omitempty"`
	Revision           int64    `json:"revision,omitempty"`
	RuntimeAccountID   string   `json:"runtime_account_id,omitempty"`
	AccountResourceID  string   `json:"account_resource_id,omitempty"`
	CredentialRevision int64    `json:"credential_revision,omitempty"`
	SessionID          string   `json:"session_id,omitempty"`
	// ExcludeAccounts 是控制面判定在本实例上尚未同步的运行账号：本次请求不选它们，其余账号照常接单
	ExcludeAccounts []string `json:"exclude_accounts,omitempty"`
}

func (e Envelope) Validate(now time.Time, skew time.Duration) error {
	if e.Version != 1 {
		return errors.New("unsupported envelope version")
	}
	if strings.TrimSpace(e.Dispatch) == "" || strings.TrimSpace(e.RequestID) == "" {
		return errors.New("dispatch_id and request_id are required")
	}
	if strings.TrimSpace(e.Nonce) == "" {
		return errors.New("nonce is required")
	}
	if e.ExpiresAt.IsZero() || e.ExpiresAt.Before(now.Add(-skew)) {
		return errors.New("envelope is expired")
	}
	if e.ExpiresAt.After(now.Add(15 * time.Minute)) {
		return errors.New("envelope expiry is too far in the future")
	}
	if e.Operation == "" || e.Protocol == "" {
		return errors.New("operation and protocol are required")
	}
	return nil
}

func BodyHash(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// Sign 对 "timestamp\nnonce\nbodyHash\nbody" 计算 HMAC-SHA256；分段写入，不为大正文拼接副本。
func Sign(secret string, timestamp, nonce, bodyHash string, body []byte) string {
	h := hmac.New(sha256.New, []byte(secret))
	_, _ = h.Write([]byte(timestamp + "\n" + nonce + "\n" + bodyHash + "\n"))
	_, _ = h.Write(body)
	return hex.EncodeToString(h.Sum(nil))
}

func Verify(secret, timestamp, nonce, bodyHash, signature string, body []byte, now time.Time, skew time.Duration) error {
	if secret == "" || timestamp == "" || nonce == "" || signature == "" {
		return errors.New("missing signature fields")
	}
	parsed, err := time.Parse(time.RFC3339Nano, timestamp)
	if err != nil || parsed.Before(now.Add(-skew)) || parsed.After(now.Add(skew)) {
		return errors.New("signature timestamp outside allowed window")
	}
	if !hmac.Equal([]byte(bodyHash), []byte(BodyHash(body))) {
		return errors.New("body hash mismatch")
	}
	want := Sign(secret, timestamp, nonce, bodyHash, body)
	if len(want) != len(signature) || subtle.ConstantTimeCompare([]byte(want), []byte(signature)) != 1 {
		return errors.New("invalid signature")
	}
	return nil
}

// SignV2 是实例密钥的签名串（中期技术债 M2 审查 P2，与控制面 gateway-auth.mjs 的 signGatewayRequestV2 相同）：
// 在 v1 之外覆盖方法、请求目标（路径与查询串）、实例与 key_id。共用令牌仍用 v1（Sign），兼容旧版。
func SignV2(secret, method, target, instanceID, keyID, timestamp, nonce, bodyHash string, body []byte) string {
	h := hmac.New(sha256.New, []byte(secret))
	_, _ = h.Write([]byte("v2\n" + strings.ToUpper(method) + "\n" + target + "\n" + instanceID + "\n" + keyID + "\n" + timestamp + "\n" + nonce + "\n" + bodyHash + "\n"))
	_, _ = h.Write(body)
	return hex.EncodeToString(h.Sum(nil))
}

// VerifyV2 按 v2 签名串校验（时间窗与正文摘要的检查与 Verify 相同）。
func VerifyV2(secret, method, target, instanceID, keyID, timestamp, nonce, bodyHash, signature string, body []byte, now time.Time, skew time.Duration) error {
	if secret == "" || timestamp == "" || nonce == "" || signature == "" {
		return errors.New("missing signature fields")
	}
	parsed, err := time.Parse(time.RFC3339Nano, timestamp)
	if err != nil || parsed.Before(now.Add(-skew)) || parsed.After(now.Add(skew)) {
		return errors.New("signature timestamp outside allowed window")
	}
	if !hmac.Equal([]byte(bodyHash), []byte(BodyHash(body))) {
		return errors.New("body hash mismatch")
	}
	want := SignV2(secret, method, target, instanceID, keyID, timestamp, nonce, bodyHash, body)
	if len(want) != len(signature) || subtle.ConstantTimeCompare([]byte(want), []byte(signature)) != 1 {
		return errors.New("invalid signature")
	}
	return nil
}
