package codexgateway

import (
	"encoding/json"
	"strconv"
	"strings"
	"time"
)

// 请求正文按账号收敛（对齐 codex-proxy-rs transport/request.rs scope_request_to_account）：
// 只有确认状态归属于本次账号（Same）时才保留 turn-state 与账号绑定字段；归属不明或换号时
// 删除跨账号身份、turn-state 与响应引用字段。OAuth 账号的 client_metadata 总是写入本账号的
// installation id。随后再由 correlation.go 把关联 ID 映射到账号范围。
var (
	crossAccountIdentityKeys = []string{
		"authorization", "Authorization", "cookie", "Cookie", "chatgpt-account-id", "chatgpt_account_id", "chatgptAccountId",
		"account_id", "accountId", "user_id", "userId", "chatgpt_user_id", "chatgptUserId", "access_token", "accessToken",
		"session_token", "sessionToken", "refresh_token", "refreshToken", "id_token", "idToken", "token", "cookies",
		"cookie_header", "cookieHeader", "cf_clearance",
	}
	turnStateKeys         = []string{"turnState", "turn_state", "x-codex-turn-state"}
	accountBoundStateKeys = []string{"previous_response_id", "previousResponseId", "response_id", "responseId", "conversation"}
	turnMetadataKeys      = []string{"turnMetadata", "turn_metadata", "x-codex-turn-metadata"}
	installationIDKeys    = []string{"installation_id", "installationId", "x-codex-installation-id"}
)

const (
	wsResponsesLiteMetadataKey = "ws_request_header_x_openai_internal_codex_responses_lite"
	wsRequestStartMetadataKey  = "x-codex-ws-stream-request-start-ms"
)

type accountScope int

const (
	scopeUnknown accountScope = iota
	scopeSame
	scopeDifferent
)

func resetKeys() []string {
	out := append([]string{}, crossAccountIdentityKeys...)
	out = append(out, turnStateKeys...)
	return append(out, accountBoundStateKeys...)
}

// attemptState 是一次尝试的账号归属结论与要发送的 turn-state。
type attemptState struct {
	scope     accountScope
	turnState string
	keepGuard bool // Guardian 父响应已确认属于本账号
	profile   wireProfile
}

// resolveAttemptState：状态归属来自续接钉住的账号、previous_response_id 或同会话最近一次响应的记录。
func (d *dispatchRun) resolveAttemptState(account Account) attemptState {
	s := d.server
	now := time.Now()
	owner := d.envelope.Scope.RuntimeAccountID
	var record *responseRecord
	if previous := previousResponseID(d.body); previous != "" {
		if found, ok := s.guardian.get(d.envelope.ClientScope, previous, now); ok {
			record = &found
		}
	}
	if record == nil {
		if session := d.inboundHeader("session-id"); session != "" {
			if found, ok := s.guardian.session(d.envelope.ClientScope, session, now); ok {
				record = &found
			}
		}
	}
	if owner == "" && record != nil {
		owner = record.account
	}
	state := attemptState{scope: scopeUnknown}
	switch {
	case owner != "" && owner == account.ID:
		state.scope = scopeSame
	case owner != "" || d.switches > 0:
		state.scope = scopeDifferent
	}
	if state.scope == scopeSame {
		state.turnState = d.inboundHeader("x-codex-turn-state")
		turnID := d.inboundHeader("x-codex-turn-id")
		if state.turnState == "" && record != nil && record.account == account.ID && record.turnID != "" && record.turnID == turnID {
			state.turnState = record.turnState
		}
	}
	// 归属不明的全量请求：token 已证明是本账号交给本客户端同一 turn 的，才回传（CPR 790f3147）；
	// 范围仍为 unknown，previous_response_id 等其他账号状态照常清理
	if state.scope == scopeUnknown {
		if token := d.inboundHeader("x-codex-turn-state"); token != "" && s.turnStates.owns(d.turnStateScope(account), token, s.store.SessionTTL(), now) {
			state.turnState = token
		}
	}
	return state
}

func (d *dispatchRun) inboundHeader(name string) string {
	for key, value := range d.envelope.Headers {
		if strings.EqualFold(key, name) {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func previousResponseID(body []byte) string {
	var fields struct {
		PreviousResponseID string `json:"previous_response_id"`
	}
	_ = json.Unmarshal(topLevelSubset(body, "previous_response_id"), &fields)
	return strings.TrimSpace(fields.PreviousResponseID)
}

// scopeRequestToAccount 按归属结论改写正文；installationID 为空（API Key 账号）时只做清理。
func scopeRequestToAccount(body []byte, installationID string, state attemptState) []byte {
	reset := state.scope != scopeSame
	sawMetadata := false
	out, changed, err := rewriteObject(body, func(key string, value json.RawMessage) (json.RawMessage, bool, bool) {
		if reset && containsString(resetKeys(), key) && !keepsVerifiedTurnState(key, value, state) {
			return nil, true, true
		}
		if installationID != "" && containsString(installationIDKeys, key) {
			replaced, _ := json.Marshal(installationID)
			return replaced, false, string(replaced) != string(value)
		}
		if containsString(turnMetadataKeys, key) {
			return scopeTurnMetadataValue(value, installationID, reset)
		}
		if key == "client_metadata" {
			sawMetadata = true
			mapped, ok := scopeClientMetadata(value, installationID, state)
			return mapped, false, ok
		}
		return value, false, false
	})
	if err != nil {
		return body
	}
	if !sawMetadata && installationID != "" {
		// 官方 Core 总在 client_metadata 写入当前安装身份
		metadata, _ := json.Marshal(map[string]string{"x-codex-installation-id": installationID})
		out = appendObjectField(out, "client_metadata", metadata)
		changed = true
	}
	if !changed {
		return body
	}
	return out
}

// keepsVerifiedTurnState：归属需要清理时，只保留与已证明 token 相同的 turn-state 字段。
func keepsVerifiedTurnState(key string, value json.RawMessage, state attemptState) bool {
	if state.turnState == "" || !containsString(turnStateKeys, key) {
		return false
	}
	var token string
	return json.Unmarshal(value, &token) == nil && token == state.turnState
}

func scopeClientMetadata(value json.RawMessage, installationID string, state attemptState) (json.RawMessage, bool) {
	reset := state.scope != scopeSame
	sawInstallation := false
	out, changed, err := rewriteObject(value, func(key string, inner json.RawMessage) (json.RawMessage, bool, bool) {
		if reset && ((containsString(resetKeys(), key) && !keepsVerifiedTurnState(key, inner, state)) || (key == "parent_response_id" && !state.keepGuard)) {
			return nil, true, true
		}
		if key == "x-codex-installation-id" {
			sawInstallation = true
		}
		if installationID != "" && containsString(installationIDKeys, key) {
			replaced, _ := json.Marshal(installationID)
			return replaced, false, string(replaced) != string(inner)
		}
		if containsString(turnMetadataKeys, key) {
			return scopeTurnMetadataValue(inner, installationID, reset)
		}
		return inner, false, false
	})
	if err != nil {
		return value, false
	}
	if installationID != "" && !sawInstallation {
		id, _ := json.Marshal(installationID)
		out = appendObjectField(out, "x-codex-installation-id", id)
		changed = true
	}
	return out, changed
}

// scopeTurnMetadataValue 处理 turn metadata（对象或 JSON 字符串）：换号/归属不明时删除身份、turn-state、
// 响应引用与嵌套 turn metadata；已有的 installation id 改为当前账号。无法解析且需清理时删除整个字段。
func scopeTurnMetadataValue(value json.RawMessage, installationID string, reset bool) (json.RawMessage, bool, bool) {
	trimmed := strings.TrimSpace(string(value))
	if strings.HasPrefix(trimmed, "{") {
		out, changed := scopeTurnMetadataObject([]byte(trimmed), installationID, reset)
		return out, false, changed
	}
	var raw string
	if json.Unmarshal(value, &raw) != nil {
		return value, false, false
	}
	scoped, keep := scopeTurnMetadataString(raw, installationID, reset)
	if !keep {
		return nil, true, true
	}
	if scoped == raw {
		return value, false, false
	}
	out, _ := json.Marshal(scoped)
	return out, false, true
}

func scopeTurnMetadataObject(data []byte, installationID string, reset bool) ([]byte, bool) {
	out, changed, err := rewriteObject(data, func(key string, inner json.RawMessage) (json.RawMessage, bool, bool) {
		if reset && (containsString(resetKeys(), key) || containsString(turnMetadataKeys, key)) {
			return nil, true, true
		}
		if installationID != "" && containsString(installationIDKeys, key) {
			replaced, _ := json.Marshal(installationID)
			return replaced, false, string(replaced) != string(inner)
		}
		return inner, false, false
	})
	if err != nil {
		return data, false
	}
	return out, changed
}

// scopeTurnMetadataString 返回改写后的 ASCII JSON 字符串；不可解析时归属不明则丢弃（keep=false）。
func scopeTurnMetadataString(raw, installationID string, reset bool) (string, bool) {
	trimmed := strings.TrimSpace(raw)
	if !strings.HasPrefix(trimmed, "{") {
		return raw, !reset
	}
	out, changed := scopeTurnMetadataObject([]byte(trimmed), installationID, reset)
	if !changed {
		return raw, true
	}
	return asciiJSON(out), true
}

// appendObjectField 在 JSON 对象末尾追加字段（保持既有字段顺序）。
func appendObjectField(object []byte, key string, value []byte) []byte {
	trimmed := strings.TrimRight(string(object), " \t\r\n")
	if !strings.HasSuffix(trimmed, "}") {
		return object
	}
	name, _ := json.Marshal(key)
	body := strings.TrimSuffix(trimmed, "}")
	separator := ","
	if strings.TrimSpace(strings.TrimPrefix(body, "{")) == "" {
		separator = ""
	}
	return []byte(body + separator + string(name) + ":" + string(value) + "}")
}

// projectWSClientMetadata：WS 首帧把只能以请求头表达的字段写入 client_metadata
// （responses-lite、turn-state、请求开始毫秒时间戳），与官方 Core 相同。
func projectWSClientMetadata(body []byte, responsesLite, turnState string, now time.Time) []byte {
	start, _ := json.Marshal(strconv.FormatInt(now.UnixMilli(), 10))
	project := func(metadata json.RawMessage) json.RawMessage {
		sawLite := false
		out, _, err := rewriteObject(metadata, func(key string, inner json.RawMessage) (json.RawMessage, bool, bool) {
			switch key {
			case wsResponsesLiteMetadataKey:
				sawLite = true
			case "x-codex-turn-state", wsRequestStartMetadataKey:
				return nil, true, true
			}
			return inner, false, false
		})
		if err != nil {
			return metadata
		}
		if responsesLite != "" && !sawLite {
			lite, _ := json.Marshal(responsesLite)
			out = appendObjectField(out, wsResponsesLiteMetadataKey, lite)
		}
		if turnState != "" {
			value, _ := json.Marshal(turnState)
			out = appendObjectField(out, "x-codex-turn-state", value)
		}
		return appendObjectField(out, wsRequestStartMetadataKey, start)
	}
	sawMetadata := false
	out, _, err := rewriteObject(body, func(key string, value json.RawMessage) (json.RawMessage, bool, bool) {
		if key != "client_metadata" || !strings.HasPrefix(strings.TrimSpace(string(value)), "{") {
			return value, false, false
		}
		sawMetadata = true
		return project(value), false, true
	})
	if err != nil {
		return body
	}
	if !sawMetadata {
		out = appendObjectField(out, "client_metadata", project(json.RawMessage(`{}`)))
	}
	return out
}
