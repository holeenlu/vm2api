package codexgateway

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

// 没有会话记录（归属不明）的全量请求：只回传已证明属于本账号同一 turn 的 token（CPR 790f3147）。
func TestUnknownScopeEchoesOnlyVerifiedTurnState(t *testing.T) {
	var mu sync.Mutex
	var requests []http.Header
	var bodies []map[string]any
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(decompressed(r, data), &body)
		mu.Lock()
		requests = append(requests, r.Header.Clone())
		bodies = append(bodies, body)
		n := len(requests)
		mu.Unlock()
		if n == 1 {
			// 失败响应同样下发 turn-state，客户端可在同一 turn 带回
			w.Header().Set("x-codex-turn-state", "ts-fail")
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_, _ = io.WriteString(w, `{"error":{"type":"invalid_request_error","code":"unsupported_value","message":"bad value"}}`)
			return
		}
		w.Header().Set("x-codex-turn-state", fmt.Sprintf("ts-%d", n))
		w.Header().Set("Content-Type", "text/event-stream")
		id := fmt.Sprintf("resp_v_%d", n)
		_, _ = io.WriteString(w, "data: {\"type\":\"response.created\",\"response\":{\"id\":\""+id+"\"}}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\""+id+"\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}\n\n")
	}))
	t.Cleanup(upstream.Close)
	acct := account("a", "tok_a")
	acct.ProxyURL = forwardProxy(t, upstream.URL)
	_, httpServer, cfg := newExecuteServer(t, "http://chatgpt.com/backend-api/codex", acct)

	// 1. 上游 400 失败，失败响应的 turn-state 交给客户端
	first := turnRun(t, cfg, httpServer.URL, map[string]string{"x-codex-turn-id": "turn_1"}, `{"model":"gpt-test","stream":true,"input":"hi"}`)
	if first.StatusCode != http.StatusBadRequest || first.Header.Get("x-codex-turn-state") != "ts-fail" {
		t.Fatalf("first status=%d turn-state=%q", first.StatusCode, first.Header.Get("x-codex-turn-state"))
	}
	// 2. 同一 turn 带回失败响应的 token：已证明，头与 client_metadata 都保留；previous_response_id 仍清理
	turnRun(t, cfg, httpServer.URL, map[string]string{"x-codex-turn-id": "turn_1", "x-codex-turn-state": "ts-fail"},
		`{"model":"gpt-test","stream":true,"input":"retry","previous_response_id":"resp_foreign","client_metadata":{"x-codex-turn-state":"ts-fail"}}`)
	// 3. 伪造 token：清理
	turnRun(t, cfg, httpServer.URL, map[string]string{"x-codex-turn-id": "turn_1", "x-codex-turn-state": "ts-forged"},
		`{"model":"gpt-test","stream":true,"input":"forged","client_metadata":{"x-codex-turn-state":"ts-forged"}}`)
	// 4. 已证明的 token 换到新 turn：清理
	turnRun(t, cfg, httpServer.URL, map[string]string{"x-codex-turn-id": "turn_2", "x-codex-turn-state": "ts-fail"}, `{"model":"gpt-test","stream":true,"input":"next"}`)
	// 5. 成功响应的 token（ts-2，turn_1）同样记录
	turnRun(t, cfg, httpServer.URL, map[string]string{"x-codex-turn-id": "turn_1", "x-codex-turn-state": "ts-2"}, `{"model":"gpt-test","stream":true,"input":"again"}`)

	mu.Lock()
	defer mu.Unlock()
	if len(requests) != 5 {
		t.Fatalf("requests=%d", len(requests))
	}
	if got := requests[1].Get("x-codex-turn-state"); got != "ts-fail" {
		t.Fatalf("verified token not echoed: %q", got)
	}
	metadata, _ := bodies[1]["client_metadata"].(map[string]any)
	if metadata["x-codex-turn-state"] != "ts-fail" {
		t.Fatalf("verified metadata token dropped: %v", bodies[1])
	}
	if _, ok := bodies[1]["previous_response_id"]; ok {
		t.Fatalf("proof must not release previous_response_id: %v", bodies[1])
	}
	if got := requests[2].Get("x-codex-turn-state"); got != "" {
		t.Fatalf("forged token echoed: %q", got)
	}
	if metadata, _ := bodies[2]["client_metadata"].(map[string]any); metadata["x-codex-turn-state"] != nil {
		t.Fatalf("forged metadata token kept: %v", bodies[2])
	}
	if got := requests[3].Get("x-codex-turn-state"); got != "" {
		t.Fatalf("token crossed turns: %q", got)
	}
	if got := requests[4].Get("x-codex-turn-state"); got != "ts-2" {
		t.Fatalf("success token not remembered: %q", got)
	}
}

func TestTurnStateProofsScopeAccountClientAndExpiry(t *testing.T) {
	proofs := newTurnStateProofs()
	now := time.Now()
	run := func(clientScope string) *dispatchRun {
		return &dispatchRun{envelope: Envelope{ClientScope: clientScope, Headers: map[string]string{"x-codex-turn-id": "turn_1", "session-id": "s"}}}
	}
	a := Account{ID: "a"}
	proofs.remember(run("key_1").turnStateScope(a), "tok", time.Minute, now)
	if !proofs.owns(run("key_1").turnStateScope(a), "tok", time.Minute, now) {
		t.Fatal("proof not found")
	}
	if proofs.owns(run("key_2").turnStateScope(a), "tok", time.Minute, now) {
		t.Fatal("proof crossed client keys")
	}
	if proofs.owns(run("key_1").turnStateScope(Account{ID: "b"}), "tok", time.Minute, now) {
		t.Fatal("proof crossed accounts")
	}
	if proofs.owns(run("key_1").turnStateScope(a), "tok", time.Minute, now.Add(2*time.Minute)) {
		t.Fatal("expired proof accepted")
	}
	// 没有 turn id 不建立证明
	noTurn := &dispatchRun{envelope: Envelope{ClientScope: "key_1"}}
	proofs.remember(noTurn.turnStateScope(a), "tok2", time.Minute, now)
	if proofs.owns(noTurn.turnStateScope(a), "tok2", time.Minute, now) {
		t.Fatal("proof without turn id")
	}
	// API Key 账号换凭据后不继承
	key := Account{ID: "k", APIKey: "sk", CredentialRevision: 1}
	proofs.remember(run("key_1").turnStateScope(key), "tok3", time.Minute, now)
	key.CredentialRevision = 2
	if proofs.owns(run("key_1").turnStateScope(key), "tok3", time.Minute, now) {
		t.Fatal("API key proof survived credential replacement")
	}
	// 容量上限：满额后淘汰最早到期的一项
	full := newTurnStateProofs()
	scope := run("key_1").turnStateScope(a)
	for i := 0; i < turnStateProofCapacity; i++ {
		full.remember(scope, fmt.Sprintf("t%d", i), time.Duration(i+1)*time.Second, now)
	}
	full.remember(scope, "newest", time.Hour, now)
	if len(full.proofs) != turnStateProofCapacity || full.owns(scope, "t0", time.Hour, now) || !full.owns(scope, "newest", time.Hour, now) {
		t.Fatalf("capacity eviction wrong: len=%d", len(full.proofs))
	}
}
