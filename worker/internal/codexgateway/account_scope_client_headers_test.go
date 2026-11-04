package codexgateway

import (
	"net/http"
	"strings"
	"testing"
	"time"
)

const traceBody = `{"model":"m","traceparent":"00-a-b-01","ws_request_header_baggage":"k=v","input":"hi",` +
	`"client_metadata":{"tracestate":"s","ws_request_header_x-openai-fedramp":"true","keep":"1",` +
	`"x-codex-turn-metadata":"{\"sentry-trace\":\"t\",\"turn_id\":\"u\"}"},` +
	`"turn_metadata":{"baggage":"b","turn_id":"u"}}`

func TestSwitchingAccountsDropsClientTraceContext(t *testing.T) {
	out := string(scopeRequestToAccount([]byte(traceBody), "inst-2", attemptState{scope: scopeDifferent}))
	for _, leaked := range []string{"traceparent", "baggage", "tracestate", "fedramp", "sentry-trace"} {
		if strings.Contains(out, leaked) {
			t.Fatalf("换号后仍带有 %s: %s", leaked, out)
		}
	}
	for _, kept := range []string{`"input":"hi"`, `"keep":"1"`} {
		if !strings.Contains(out, kept) {
			t.Fatalf("业务字段 %s 被误删: %s", kept, out)
		}
	}
}

func TestSameOrUnknownAccountKeepsClientTraceContext(t *testing.T) {
	for _, scope := range []accountScope{scopeSame, scopeUnknown} {
		out := string(scopeRequestToAccount([]byte(traceBody), "inst-1", attemptState{scope: scope}))
		for _, kept := range []string{`"traceparent":"00-a-b-01"`, `"ws_request_header_baggage":"k=v"`, `"tracestate":"s"`, `"ws_request_header_x-openai-fedramp":"true"`} {
			if !strings.Contains(out, kept) {
				t.Fatalf("scope=%d 不应清理 %s: %s", scope, kept, out)
			}
		}
	}
}

func TestSwitchingAccountsDropsClientTraceHeaders(t *testing.T) {
	build := func(scope accountScope) http.Header {
		header := http.Header{}
		for _, name := range []string{"traceparent", "tracestate", "sentry-trace", "baggage", "x-openai-fedramp", "x-client-request-id"} {
			header.Set(name, "v")
		}
		header.Set("x-codex-turn-metadata", `{"baggage":"b","turn_id":"u"}`)
		applyAttemptHeaders(header, Account{InstallationID: "inst-2"}, attemptState{scope: scope})
		return header
	}
	different := build(scopeDifferent)
	for _, name := range crossAccountClientHeaders {
		if different.Get(name) != "" {
			t.Fatalf("换号后请求头 %s 未清理", name)
		}
	}
	if different.Get("x-client-request-id") == "" || strings.Contains(different.Get("x-codex-turn-metadata"), "baggage") {
		t.Fatalf("无关头应保留且 turn metadata 内的追踪字段应清理: %v", different)
	}
	for _, scope := range []accountScope{scopeSame, scopeUnknown} {
		if kept := build(scope); kept.Get("traceparent") == "" || kept.Get("x-openai-fedramp") == "" {
			t.Fatalf("scope=%d 不应清理追踪头", scope)
		}
	}
}

func TestFullPayloadPreferenceHasHysteresis(t *testing.T) {
	budget := newWSSessionBudget()
	now := time.Now()
	const key = "caller\x00thread"
	step := func(bytes int, want bool) {
		t.Helper()
		if got := budget.httpForFullPayload(key, bytes, now); got != want {
			t.Fatalf("%d 字节：got %v want %v", bytes, got, want)
		}
	}
	step(wsPayloadLimit-1, false)
	step(wsPayloadLimit, true)
	step(wsPayloadLimit-1, true) // 回差区间内沿用 HTTP
	step(wsPayloadResume, true)
	step(wsPayloadResume-1, false)
	step(wsPayloadLimit-1, false)
	if got := newWSSessionBudget().httpForFullPayload("", wsPayloadLimit, now); !got {
		t.Fatal("没有会话 ID 时仍应按上限判断")
	}
}

func TestWebSocketSuccessKeepsPayloadPreference(t *testing.T) {
	budget := newWSSessionBudget()
	now := time.Now()
	const key = "caller\x00thread"
	budget.httpForFullPayload(key, wsPayloadLimit, now)
	budget.recordFailure(key, now)
	budget.succeeded(key) // 预热或增量成功不证明完整请求放得进 WS
	if !budget.httpForFullPayload(key, wsPayloadResume, now) {
		t.Fatal("成功后大小偏好被清除")
	}
	budget.httpForFullPayload(key, wsPayloadResume-1, now)
	budget.succeeded(key)
	if budget.usesHTTP(key, now) || len(budget.sessions) != 0 {
		t.Fatalf("无偏好且成功后应释放会话状态: %+v", budget.sessions)
	}
}
