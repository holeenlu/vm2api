package codexgateway

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// 归属不明的全量请求：客户端回传的 turn-state 原样转发，不依赖本地记录；previous_response_id 仍清理（CPR 1daa0623）。
func TestUnknownScopeEchoesClientTurnState(t *testing.T) {
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
		w.Header().Set("x-codex-turn-state", fmt.Sprintf("ts-%d", n))
		w.Header().Set("Content-Type", "text/event-stream")
		id := fmt.Sprintf("resp_v_%d", n)
		_, _ = io.WriteString(w, "data: {\"type\":\"response.created\",\"response\":{\"id\":\""+id+"\"}}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\""+id+"\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}\n\n")
	}))
	t.Cleanup(upstream.Close)
	acct := account("a", "tok_a")
	acct.ProxyURL = forwardProxy(t, upstream.URL)
	_, httpServer, cfg := newExecuteServer(t, "http://chatgpt.com/backend-api/codex", acct)

	// 1. 新进程、无任何本地记录：头与 client_metadata 中的 token 都原样保留
	turnRun(t, cfg, httpServer.URL, map[string]string{"x-codex-turn-id": "turn_1", "x-codex-turn-state": "ts-client"},
		`{"model":"gpt-test","stream":true,"input":"retry","previous_response_id":"resp_foreign","client_metadata":{"x-codex-turn-state":"ts-client"}}`)
	// 2. 只在 client_metadata 携带（WS 首帧形状）：同样回传
	turnRun(t, cfg, httpServer.URL, map[string]string{"x-codex-turn-id": "turn_1"},
		`{"model":"gpt-test","stream":true,"input":"meta","client_metadata":{"x-codex-turn-state":"ts-meta"}}`)

	mu.Lock()
	defer mu.Unlock()
	if len(requests) != 2 {
		t.Fatalf("requests=%d", len(requests))
	}
	if got := requests[0].Get("x-codex-turn-state"); got != "ts-client" {
		t.Fatalf("client token not echoed: %q", got)
	}
	if metadata, _ := bodies[0]["client_metadata"].(map[string]any); metadata["x-codex-turn-state"] != "ts-client" {
		t.Fatalf("client metadata token dropped: %v", bodies[0])
	}
	if _, ok := bodies[0]["previous_response_id"]; ok {
		t.Fatalf("unknown scope must still clear previous_response_id: %v", bodies[0])
	}
	if got := requests[1].Get("x-codex-turn-state"); got != "ts-meta" {
		t.Fatalf("metadata-only token not echoed: %q", got)
	}
}

// 明确换号时 turn-state 在头、正文、client_metadata 与 turn metadata 中一并清理；归属不明时都保留。
func TestTurnStateClearedOnlyOnConfirmedAccountSwitch(t *testing.T) {
	body := []byte(`{"model":"m","turn_state":"b","client_metadata":{"x-codex-turn-state":"c"},"turn_metadata":{"turnState":"d","turn_id":"u"}}`)
	for _, tc := range []struct {
		scope accountScope
		keep  bool
	}{{scopeDifferent, false}, {scopeUnknown, true}, {scopeSame, true}} {
		out := string(scopeRequestToAccount(body, "inst", attemptState{scope: tc.scope}))
		for _, field := range []string{`"turn_state":"b"`, `"x-codex-turn-state":"c"`, `"turnState":"d"`} {
			if strings.Contains(out, field) != tc.keep {
				t.Fatalf("scope=%d field %s keep=%v: %s", tc.scope, field, tc.keep, out)
			}
		}
		header := http.Header{}
		header.Set("x-codex-turn-metadata", `{"turnState":"h","turn_id":"u"}`)
		state := attemptState{scope: tc.scope}
		if tc.keep {
			state.turnState = "t"
		}
		applyAttemptHeaders(header, Account{InstallationID: "inst"}, state)
		if (header.Get("x-codex-turn-state") == "t") != tc.keep || strings.Contains(header.Get("x-codex-turn-metadata"), `"turnState"`) != tc.keep {
			t.Fatalf("scope=%d headers=%v", tc.scope, header)
		}
	}
}
