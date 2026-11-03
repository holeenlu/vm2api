package codexgateway

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// Guardian 路由 Cookie 复用（对齐 codex-proxy-rs transport/routing_affinity + provider/guardian）：
// 上游 WS 握手 Set-Cookie 中的 __oailb/__cflb 是该连接的负载均衡 pin；响应开始时按
// （调用方范围, response_id）记住归属账号与这份快照（30 分钟、最多 4096 条，不持久化）。
// 随后的 Guardian 请求若 client_metadata.parent_response_id 指向同账号的父响应，保留该字段并带上同一 pin；
// 父响应属于其他账号或归属未知时删除该字段。
var routingCookieNames = []string{"__oailb", "__cflb"}

const (
	routingCookieMaxBytes   = 8192
	guardianRoutingTTL      = 30 * time.Minute
	guardianRoutingCapacity = 4096
)

type routingAffinity struct {
	id      string
	origin  string
	path    string
	cookies []string // name=value
}

// routingAffinityFromResponse 只采纳每个名字恰好一条、且不超过 8 KiB 的 pin；歧义时整体放弃。
func routingAffinityFromResponse(endpoint string, header http.Header) *routingAffinity {
	origin, path, ok := cookieScope(endpoint)
	if !ok {
		return nil
	}
	var cookies []string
	for _, name := range routingCookieNames {
		var matched []string
		for _, raw := range header.Values("Set-Cookie") {
			pair, _, _ := strings.Cut(raw, ";")
			candidate, _, found := strings.Cut(pair, "=")
			if found && strings.TrimSpace(candidate) == name {
				matched = append(matched, raw)
			}
		}
		if len(matched) == 0 {
			continue
		}
		if len(matched) > 1 || len(matched[0]) > routingCookieMaxBytes {
			return nil
		}
		parsed, err := http.ParseSetCookie(matched[0])
		if err != nil || parsed.Value == "" || !cookieApplies(parsed, origin, path) {
			continue
		}
		cookies = append(cookies, parsed.Name+"="+parsed.Value)
	}
	if len(cookies) == 0 {
		return nil
	}
	var id [16]byte
	_, _ = rand.Read(id[:])
	return &routingAffinity{id: hex.EncodeToString(id[:]), origin: origin, path: path, cookies: cookies}
}

func cookieApplies(cookie *http.Cookie, origin, path string) bool {
	if cookie.MaxAge < 0 || (!cookie.Expires.IsZero() && cookie.Expires.Before(time.Now())) {
		return false
	}
	if cookie.Path != "" && !strings.HasPrefix(path, cookie.Path) {
		return false
	}
	return true
}

// cookieScope 把 ws(s)/http(s) 端点归一为 http(s) origin 与路径。
func cookieScope(endpoint string) (string, string, bool) {
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Host == "" {
		return "", "", false
	}
	scheme := parsed.Scheme
	switch scheme {
	case "wss", "https":
		scheme = "https"
	case "ws", "http":
		scheme = "http"
	default:
		return "", "", false
	}
	return scheme + "://" + strings.ToLower(parsed.Host), parsed.Path, true
}

// apply 只对握手时的同一 origin 与路径生效；替换已有的同名 pin，保留其他 Cookie。
func (a *routingAffinity) apply(endpoint string, header http.Header) {
	if a == nil {
		return
	}
	origin, path, ok := cookieScope(endpoint)
	if !ok || origin != a.origin || path != a.path {
		return
	}
	var parts []string
	for _, value := range header.Values("Cookie") {
		for _, part := range strings.Split(value, ";") {
			part = strings.TrimSpace(part)
			name, _, _ := strings.Cut(part, "=")
			if part == "" || containsString(routingCookieNames, strings.TrimSpace(name)) {
				continue
			}
			parts = append(parts, part)
		}
	}
	parts = append(parts, a.cookies...)
	header.Set("Cookie", strings.Join(parts, "; "))
}

// responseRecord 是响应开始时记录的状态归属：账号、握手路由 pin、上游下发的 turn-state 与客户端 turn id。
// 同时供 Guardian 父响应与 turn-state 回放使用。
type responseRecord struct {
	capturedAt time.Time
	account    string
	affinity   *routingAffinity
	turnState  string
	turnID     string
}

type guardianRouting struct {
	mu       sync.Mutex
	parents  map[string]responseRecord
	sessions map[string]responseRecord
}

func newGuardianRouting() *guardianRouting {
	return &guardianRouting{parents: map[string]responseRecord{}, sessions: map[string]responseRecord{}}
}

func guardianKey(clientScope, responseID string) string {
	sum := sha256.Sum256([]byte(clientScope + "\x00" + responseID))
	return string(sum[:])
}

// remember 记录响应的归属；sessionID 非空时同时作为该会话最近一次响应（会话记录随最新响应覆盖）。
func (g *guardianRouting) remember(clientScope, responseID, sessionID string, record responseRecord) {
	if responseID == "" || record.account == "" {
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if sessionID != "" {
		boundedPut(g.sessions, guardianKey(clientScope, "session\x00"+sessionID), record, true)
	}
	boundedPut(g.parents, guardianKey(clientScope, responseID), record, false)
}

func boundedPut(entries map[string]responseRecord, key string, record responseRecord, overwrite bool) {
	if _, ok := entries[key]; ok && !overwrite {
		return
	}
	if _, ok := entries[key]; !ok && len(entries) >= guardianRoutingCapacity {
		var oldestKey string
		var oldest time.Time
		for k, entry := range entries {
			if record.capturedAt.Sub(entry.capturedAt) >= guardianRoutingTTL {
				delete(entries, k)
				continue
			}
			if oldestKey == "" || entry.capturedAt.Before(oldest) {
				oldestKey, oldest = k, entry.capturedAt
			}
		}
		if len(entries) >= guardianRoutingCapacity && oldestKey != "" {
			delete(entries, oldestKey)
		}
	}
	entries[key] = record
}

func lookup(entries map[string]responseRecord, key string, now time.Time) (responseRecord, bool) {
	record, ok := entries[key]
	if !ok {
		return responseRecord{}, false
	}
	if now.Sub(record.capturedAt) >= guardianRoutingTTL {
		delete(entries, key)
		return responseRecord{}, false
	}
	return record, true
}

// get 返回响应的归属；过期或未知时 ok=false。
func (g *guardianRouting) get(clientScope, responseID string, now time.Time) (responseRecord, bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return lookup(g.parents, guardianKey(clientScope, responseID), now)
}

// session 返回同一调用方会话最近一次响应的归属。
func (g *guardianRouting) session(clientScope, sessionID string, now time.Time) (responseRecord, bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return lookup(g.sessions, guardianKey(clientScope, "session\x00"+sessionID), now)
}

// guardianParentID 读取 client_metadata.parent_response_id。
func guardianParentID(body []byte) string {
	var fields struct {
		ClientMetadata map[string]any `json:"client_metadata"`
	}
	if json.Unmarshal(topLevelSubset(body, "client_metadata"), &fields) != nil {
		return ""
	}
	id, _ := fields.ClientMetadata["parent_response_id"].(string)
	return strings.TrimSpace(id)
}

// withoutParentResponseID 删除 client_metadata.parent_response_id，保持其余字段原顺序。
func withoutParentResponseID(body []byte) []byte {
	out, changed, err := rewriteObject(body, func(key string, value json.RawMessage) (json.RawMessage, bool, bool) {
		if key != "client_metadata" {
			return value, false, false
		}
		inner, changed, err := rewriteObject(value, func(name string, v json.RawMessage) (json.RawMessage, bool, bool) {
			return v, name == "parent_response_id", name == "parent_response_id"
		})
		if err != nil || !changed {
			return value, false, false
		}
		return inner, false, true
	})
	if err != nil || !changed {
		return body
	}
	return out
}

// guardianAffinity 解析本次尝试的父响应：同账号时保留 parent_response_id，OAuth 账号再带上握手 pin；
// 父响应属于其他账号或归属未知时返回去掉该字段的正文。
func (d *dispatchRun) guardianAffinity(account Account, body []byte) ([]byte, *routingAffinity) {
	if !d.guardian {
		return body, nil
	}
	responseID := guardianParentID(body)
	if responseID == "" {
		return body, nil
	}
	parent, ok := d.server.guardian.get(d.envelope.ClientScope, responseID, time.Now())
	if !ok || parent.account != account.ID {
		return withoutParentResponseID(body), nil
	}
	if account.APIKey != "" {
		return body, nil
	}
	return body, parent.affinity
}

// prepareAttempt 生成本次尝试的上游正文：Guardian 父响应校验、按账号归属收敛、关联 ID 映射。
func (d *dispatchRun) prepareAttempt(account Account) ([]byte, attemptState, *routingAffinity) {
	body, pinned := d.guardianAffinity(account, d.body)
	if mode := d.envelope.FastMode; (mode == "enabled" || mode == "disabled") && account.APIKey == "" && (d.envelope.Operation == "responses" || d.envelope.Operation == "chat") {
		_, priority, _ := d.server.plans.lookup(account, d.envelope.Model, time.Now())
		body = applyFastPolicy(body, mode, priority)
	}
	d.sentServiceTier = serviceTierOf(body)
	state := d.resolveAttemptState(account)
	state.keepGuard = d.guardian && guardianParentID(body) != ""
	state.profile = d.profile
	installation := ""
	if account.APIKey == "" {
		installation = account.InstallationID
	}
	body = scopeRequestToAccount(body, installation, state)
	if account.APIKey == "" && (d.envelope.Operation == "responses" || d.envelope.Operation == "chat") {
		body = normalizeCodexOAuthBody(body, d.inboundHeader("x-openai-internal-codex-responses-lite") == "true")
	}
	if d.envelope.Operation == "responses" || d.envelope.Operation == "chat" {
		body = alignRequestLocation(body, requestLocationFor(account, d.requestLocation))
	}
	if d.envelope.Operation == "responses" || d.envelope.Operation == "chat" {
		// 官方 Desktop Git 上下文的版本字段跟随本次画像，sessionId/threadId 按账号映射
		body = syncGitContext(body, d.profile, installation)
	}
	return scopeCorrelationBody(body, account.InstallationID), state, pinned
}

// applyAttemptHeaders 写入 turn-state 与按归属收敛的 turn metadata 头。
func applyAttemptHeaders(header http.Header, account Account, state attemptState) {
	if state.turnState != "" {
		header.Set("x-codex-turn-state", state.turnState)
	} else {
		header.Del("x-codex-turn-state")
	}
	if raw := header.Get("x-codex-turn-metadata"); raw != "" {
		installation := ""
		if account.APIKey == "" {
			installation = account.InstallationID
		}
		if scoped, keep := scopeTurnMetadataString(raw, installation, state.scope != scopeSame); keep {
			header.Set("x-codex-turn-metadata", scoped)
		} else {
			header.Del("x-codex-turn-metadata")
		}
	}
}
