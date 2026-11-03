package codexgateway

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
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

func Sign(secret string, timestamp, nonce, bodyHash string, body []byte) string {
	message := fmt.Sprintf("%s\n%s\n%s\n%s", timestamp, nonce, bodyHash, string(body))
	h := hmac.New(sha256.New, []byte(secret))
	_, _ = h.Write([]byte(message))
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
