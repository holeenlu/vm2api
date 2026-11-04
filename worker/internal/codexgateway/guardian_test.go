package codexgateway

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func guardianRun(t *testing.T, cfg Config, url, clientScope, body string, guardian bool) (*http.Response, string) {
	t.Helper()
	n := nonceSeq.Add(1)
	headers := map[string]string{}
	if guardian {
		headers["x-openai-subagent"] = "guardian"
	}
	response := signedExecute(t, cfg, url, Envelope{Dispatch: fmt.Sprintf("d_g_%d", n), RequestID: fmt.Sprintf("r_g_%d", n), Nonce: fmt.Sprintf("n_g_%d", n), Operation: "responses", Protocol: "openai.responses", Model: "gpt-test", Stream: true, Headers: headers, ClientScope: clientScope, Body: json.RawMessage(body), Scope: Scope{GroupIDs: []int64{1}}})
	data, _ := io.ReadAll(response.Body)
	response.Body.Close()
	return response, string(data)
}

func TestGuardianReusesParentRoutingCookieOnSameAccount(t *testing.T) {
	fake := &fakeWSUpstream{setCookies: []string{"__oailb=pin-1; Path=/; HttpOnly", "__cflb=cf-1; Path=/", "other=x; Path=/"}}
	_, httpServer, cfg := newWSGateway(t, fake, account("a", "tok_a"))
	response, body := guardianRun(t, cfg, httpServer.URL, "key_1", `{"model":"gpt-test","stream":true,"input":"main"}`, false)
	if response.StatusCode != 200 || !strings.Contains(body, "resp_ws_1_1") {
		t.Fatalf("parent status=%d body=%s", response.StatusCode, body)
	}
	// 同账号父响应：新连接带上握手 pin，保留 parent_response_id
	response, _ = guardianRun(t, cfg, httpServer.URL, "key_1", `{"model":"gpt-test","stream":true,"input":"review","client_metadata":{"parent_response_id":"resp_ws_1_1","x-openai-subagent":"guardian"}}`, true)
	if response.StatusCode != 200 {
		t.Fatalf("guardian status=%d", response.StatusCode)
	}
	fake.mu.Lock()
	handshakes := append([]http.Header(nil), fake.handshakes...)
	frames := append([]map[string]any(nil), fake.frames...)
	fake.mu.Unlock()
	if len(handshakes) != 2 {
		t.Fatalf("guardian should open its own pinned connection, handshakes=%d", len(handshakes))
	}
	if got := handshakes[1].Get("Cookie"); got != "__oailb=pin-1; __cflb=cf-1" {
		t.Fatalf("guardian cookie=%q", got)
	}
	metadata, _ := frames[len(frames)-1]["client_metadata"].(map[string]any)
	if metadata["parent_response_id"] != "resp_ws_1_1" {
		t.Fatalf("parent_response_id dropped: %v", frames[len(frames)-1])
	}
	// 其他调用方范围看不到该父响应：删除 parent_response_id，且不带 pin
	guardianRun(t, cfg, httpServer.URL, "key_2", `{"model":"gpt-test","stream":true,"input":"review","client_metadata":{"parent_response_id":"resp_ws_1_1"}}`, true)
	fake.mu.Lock()
	last := fake.frames[len(fake.frames)-1]
	handshakeCount := len(fake.handshakes)
	fake.mu.Unlock()
	if metadata, _ := last["client_metadata"].(map[string]any); metadata != nil && metadata["parent_response_id"] != nil {
		t.Fatalf("unknown parent must be removed: %v", last)
	}
	// 没有可信父响应时走普通连接池（复用第一条连接），不新开带 pin 的连接
	if handshakeCount != 2 {
		t.Fatalf("unpinned guardian should reuse the pooled connection, handshakes=%d", handshakeCount)
	}
}

func TestRoutingAffinityRejectsAmbiguousOrOversizedPins(t *testing.T) {
	header := http.Header{"Set-Cookie": {"__oailb=a; Path=/", "__oailb=b; Path=/"}}
	if routingAffinityFromResponse("wss://chatgpt.com/backend-api/codex/responses", header) != nil {
		t.Fatal("ambiguous pin must be ignored")
	}
	header = http.Header{"Set-Cookie": {"__cflb=" + strings.Repeat("x", routingCookieMaxBytes)}}
	if routingAffinityFromResponse("wss://chatgpt.com/backend-api/codex/responses", header) != nil {
		t.Fatal("oversized pin must be ignored")
	}
	affinity := routingAffinityFromResponse("wss://chatgpt.com/backend-api/codex/responses", http.Header{"Set-Cookie": {"__oailb=p; Path=/"}})
	out := http.Header{"Cookie": {"session=s; __oailb=old"}}
	affinity.apply("https://chatgpt.com/backend-api/codex/responses", out)
	if out.Get("Cookie") != "session=s; __oailb=p" {
		t.Fatalf("cookie=%q", out.Get("Cookie"))
	}
	other := http.Header{}
	affinity.apply("https://chatgpt.com/backend-api/other", other)
	affinity.apply("https://example.com/backend-api/codex/responses", other)
	if other.Get("Cookie") != "" {
		t.Fatal("pin must only apply to the handshake origin and path")
	}
	routing := newGuardianRouting()
	routing.remember("k", "resp_1", "", responseRecord{capturedAt: time.Now().Add(-guardianRoutingTTL), account: "a", affinity: affinity})
	if _, ok := routing.get("k", "resp_1", time.Now()); ok {
		t.Fatal("expired parent must be forgotten")
	}
}
