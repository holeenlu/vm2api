package codexgateway

import (
	"encoding/json"
	"strings"
)

// 上游请求头的透传与身份推导（对齐 codex-proxy-rs gateway-api responses/request.rs、transport/headers.rs、
// gateway-protocol openai/codex.rs）：入站头按黑名单过滤后透传；会话、线程、turn metadata、
// x-client-request-id 缺省值与若干正文字段投影为请求头，入站头优先。

// blockedInboundHeaders 是不能透传到上游的头：传输管理、调用方凭据与客户端身份、部署配套头、非 Codex 环境头。
// 认证、originator、User-Agent、version、安装 ID 与部署配套头由 Worker 按账号与画像重建。
var blockedInboundHeaders = map[string]bool{
	"connection": true, "keep-alive": true, "proxy-connection": true, "proxy-authenticate": true, "proxy-authorization": true,
	"te": true, "trailer": true, "transfer-encoding": true, "upgrade": true, "host": true, "content-length": true,
	"content-encoding": true, "accept-encoding": true, "x-request-id": true,
	"authorization": true, "x-api-key": true, "x-openai-actor-authorization": true, "cookie": true, "cookie2": true,
	"chatgpt-account-id": true, "chatgpt-project-id": true, "openai-organization": true, "openai-project": true,
	"originator": true, "user-agent": true, "version": true, "x-oai-attestation": true, "x-oai-is": true, "x-oai-is-update": true,
	"x-codex-installation-id": true, "x-openai-internal-codex-residency": true, "x-openai-account-routing-override": true,
	"forwarded": true, "via": true, "cdn-loop": true, "x-real-ip": true, "true-client-ip": true, "origin": true, "referer": true,
	"session_id": true,
	// 由 Worker 自己写出或单独判定的头
	"accept": true, "content-type": true, "openai-beta": true, "x-codex-routing-hint": true, "x-codex-turn-id": true, "x-codex-turn-state": true,
}

var blockedInboundPrefixes = []string{"sec-websocket-", "cf-", "x-forwarded-", "x-stainless-", "sec-ch-ua", "sec-fetch-", "x-kin-"}

// upstreamHeaderName 判定入站头能否透传到上游，返回小写头名。
func upstreamHeaderName(key string) (string, bool) {
	lower := strings.ToLower(strings.TrimSpace(key))
	if lower == "" || blockedInboundHeaders[lower] {
		return "", false
	}
	for _, prefix := range blockedInboundPrefixes {
		if strings.HasPrefix(lower, prefix) {
			return "", false
		}
	}
	return lower, true
}

// bodyHeaderProjections：正文顶层字符串字段 → 请求头（入站头优先，CPR transport/request.rs）。
var bodyHeaderProjections = [][2]string{
	{"betaFeatures", "x-codex-beta-features"},
	{"codexWindowId", "x-codex-window-id"},
	{"parentThreadId", "x-codex-parent-thread-id"},
	{"includeTimingMetrics", "x-responsesapi-include-timing-metrics"},
}

func validHeaderValue(value string) bool {
	if value == "" || len(value) > 8<<10 {
		return false
	}
	for i := 0; i < len(value); i++ {
		if c := value[i]; c < 0x20 && c != '\t' || c == 0x7f {
			return false
		}
	}
	return true
}

// upstreamInboundHeaders 返回本次分发要透传到上游的入站头（已过滤）加上推导出的身份头：
// session-id / thread-id 依次取入站头、正文顶层、client_metadata、turn metadata、正文 context；
// turn metadata 缺头时取正文或 client_metadata 中的值；x-openai-subagent 取 client_metadata；
// x-client-request-id 缺头时依次取正文同名字段、线程、会话与网关请求 ID。结果在本次分发内缓存。
func (d *dispatchRun) upstreamInboundHeaders() map[string]string {
	if d.inbound != nil {
		return d.inbound
	}
	out := map[string]string{}
	raw := map[string]string{}
	for key, value := range d.envelope.Headers {
		lower := strings.ToLower(strings.TrimSpace(key))
		raw[lower] = strings.TrimSpace(value)
		if name, ok := upstreamHeaderName(key); ok && validHeaderValue(value) {
			out[name] = value
		}
	}
	keys := []string{"session_id", "thread_id", "client_metadata", "turnMetadata", "turn_metadata", "x-codex-turn-metadata", "context", "x-client-request-id"}
	for _, pair := range bodyHeaderProjections {
		keys = append(keys, pair[0])
	}
	var body map[string]any
	_ = json.Unmarshal(topLevelSubset(d.envelope.Body, keys...), &body)
	metadata, _ := body["client_metadata"].(map[string]any)
	context, _ := body["context"].(map[string]any)
	text := func(value any) string {
		if s, ok := value.(string); ok {
			return strings.TrimSpace(s)
		}
		return ""
	}
	first := func(values ...string) string {
		for _, value := range values {
			if value != "" && validHeaderValue(value) {
				return value
			}
		}
		return ""
	}
	turnRaw := first(out["x-codex-turn-metadata"], text(body["turnMetadata"]), text(body["turn_metadata"]), text(body["x-codex-turn-metadata"]),
		text(metadata["x-codex-turn-metadata"]), text(metadata["turnMetadata"]), text(metadata["turn_metadata"]))
	if turnRaw != "" && out["x-codex-turn-metadata"] == "" {
		out["x-codex-turn-metadata"] = turnRaw
	}
	var turn map[string]any
	_ = json.Unmarshal([]byte(turnRaw), &turn)
	session := first(raw["session-id"], raw["session_id"], text(body["session_id"]), text(metadata["session_id"]), text(turn["session_id"]), text(context["session_id"]))
	thread := first(raw["thread-id"], text(body["thread_id"]), text(metadata["thread_id"]), text(turn["thread_id"]), text(context["thread_id"]))
	if session != "" && out["session-id"] == "" {
		out["session-id"] = session
	}
	if thread != "" && out["thread-id"] == "" {
		out["thread-id"] = thread
	}
	for _, pair := range bodyHeaderProjections {
		if value := first(text(body[pair[0]])); value != "" && out[pair[1]] == "" {
			out[pair[1]] = value
		}
	}
	if value := first(text(metadata["x-openai-subagent"])); value != "" && out["x-openai-subagent"] == "" {
		out["x-openai-subagent"] = value
	}
	if out["x-client-request-id"] == "" {
		if value := first(text(body["x-client-request-id"]), thread, session, d.envelope.RequestID); value != "" {
			out["x-client-request-id"] = value
		}
	}
	d.inbound = out
	return out
}
