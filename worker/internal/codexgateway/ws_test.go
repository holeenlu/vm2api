package codexgateway

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// fakeWSUpstream 模拟 chatgpt.com Responses WebSocket：每个 response.create 回一轮事件；
// 记录握手头、收到的帧与建连次数。
type fakeWSUpstream struct {
	mu           sync.Mutex
	handshakes   []http.Header
	frames       []map[string]any
	connections  atomic.Int32
	reject       int // 握手直接返回的状态码
	dropFirst    atomic.Int32
	closeEarly   bool
	holdResponse chan struct{}
	setCookies   []string
	// turnStates 为真时每次握手响应下发 x-codex-turn-state: ts_<握手序号>
	turnStates bool
	// handshakeDelay 推迟握手；script 按（连接序号, 轮次）返回该轮要发送的帧，nil 时用默认 created/delta/completed；
	// 返回的帧以 "<close>" 结束时发送后关闭连接；closeAfterTurn 在完成该轮后关闭连接
	handshakeDelay time.Duration
	script         func(conn int32, turn int) []string
	closeAfterTurn bool
}

func (f *fakeWSUpstream) handler(t *testing.T) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Upgrade") == "" {
			// HTTP/SSE 回退路径
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = io.WriteString(w, "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_http\"}}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_http\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}\n\n")
			return
		}
		if f.handshakeDelay > 0 {
			time.Sleep(f.handshakeDelay)
		}
		f.mu.Lock()
		f.handshakes = append(f.handshakes, r.Header.Clone())
		f.mu.Unlock()
		if f.reject != 0 {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(f.reject)
			_, _ = io.WriteString(w, `{"error":{"type":"usage_limit_reached","code":"usage_limit_reached"}}`)
			return
		}
		for _, cookie := range f.setCookies {
			w.Header().Add("Set-Cookie", cookie)
		}
		if f.turnStates {
			f.mu.Lock()
			w.Header().Set("x-codex-turn-state", fmt.Sprintf("ts_%d", len(f.handshakes)))
			f.mu.Unlock()
		}
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{CompressionMode: websocket.CompressionContextTakeover})
		if err != nil {
			return
		}
		n := f.connections.Add(1)
		defer conn.CloseNow()
		turn := 0
		for {
			_, data, err := conn.Read(context.Background())
			if err != nil {
				return
			}
			var frame map[string]any
			_ = json.Unmarshal(data, &frame)
			f.mu.Lock()
			f.frames = append(f.frames, frame)
			f.mu.Unlock()
			if frame["type"] != "response.create" {
				continue
			}
			if f.dropFirst.Load() > 0 {
				f.dropFirst.Add(-1)
				_ = conn.Close(websocket.StatusNormalClosure, "bye")
				return
			}
			turn++
			id := fmt.Sprintf("resp_ws_%d_%d", n, turn)
			send := func(v string) { _ = conn.Write(context.Background(), websocket.MessageText, []byte(v)) }
			if f.script != nil {
				if frames := f.script(n, turn); frames != nil {
					for _, frame := range frames {
						if frame == "<close>" {
							_ = conn.Close(websocket.StatusNormalClosure, "scripted")
							return
						}
						send(strings.ReplaceAll(frame, "$ID", id))
					}
					if f.closeAfterTurn {
						_ = conn.Close(websocket.StatusNormalClosure, "done")
						return
					}
					continue
				}
			}
			send(`{"type":"response.created","response":{"id":"` + id + `"}}`)
			send(`{"type":"response.output_text.delta","delta":"hi"}`)
			if f.holdResponse != nil {
				<-f.holdResponse
			}
			if f.closeEarly {
				_ = conn.Close(websocket.StatusNormalClosure, "early")
				return
			}
			send(`{"type":"response.completed","response":{"id":"` + id + `","usage":{"input_tokens":3,"output_tokens":2}}}`)
			if f.closeAfterTurn {
				_ = conn.Close(websocket.StatusNormalClosure, "done")
				return
			}
		}
	})
}

func newWSGateway(t *testing.T, fake *fakeWSUpstream, accounts ...Account) (*Server, *httptest.Server, Config) {
	t.Helper()
	upstream := httptest.NewServer(fake.handler(t))
	t.Cleanup(upstream.Close)
	// 首读失败只计会话预算、不计熔断（CPR），5 次恢复退避合计约 6.2s，提交前时限放宽到 20s
	cfg := Config{DataDir: t.TempDir(), InternalToken: "secret", UpstreamBaseURL: upstream.URL, RequestTimeoutSec: 20}
	cfg.applyDefaults()
	server, err := NewServer(cfg)
	if err != nil {
		t.Fatal(err)
	}
	for _, account := range accounts {
		if _, err := server.store.Upsert(account); err != nil {
			t.Fatal(err)
		}
	}
	httpServer := httptest.NewServer(server.Handler())
	t.Cleanup(httpServer.Close)
	return server, httpServer, cfg
}

func wsRun(t *testing.T, cfg Config, url, key, body string) (*http.Response, string) {
	t.Helper()
	n := nonceSeq.Add(1)
	response := signedExecute(t, cfg, url, Envelope{Dispatch: fmt.Sprintf("d_ws_%d", n), RequestID: fmt.Sprintf("r_ws_%d", n), Nonce: fmt.Sprintf("n_ws_%d", n), Operation: "responses", Protocol: "openai.responses", Model: "gpt-test", Stream: true, ConnectionKey: key, Body: json.RawMessage(body), Scope: Scope{GroupIDs: []int64{1}}})
	data, _ := io.ReadAll(response.Body)
	response.Body.Close()
	return response, string(data)
}

func wsRunSession(t *testing.T, cfg Config, url, clientScope, session, body string) (*http.Response, string) {
	t.Helper()
	n := nonceSeq.Add(1)
	response := signedExecute(t, cfg, url, Envelope{Dispatch: fmt.Sprintf("d_wss_%d", n), RequestID: fmt.Sprintf("r_wss_%d", n), Nonce: fmt.Sprintf("n_wss_%d", n), Operation: "responses", Protocol: "openai.responses", Model: "gpt-test", Stream: true, ClientScope: clientScope, Body: json.RawMessage(body), Scope: Scope{GroupIDs: []int64{1}, SessionID: session}})
	data, _ := io.ReadAll(response.Body)
	response.Body.Close()
	return response, string(data)
}

// 空闲池按调用方范围 + 会话锚点 + 握手画像分键：同会话复用，不同会话或不同 Key 不复用；无锚点的连接用后即关。
// 复用连接不再交付首次握手的 turn-state。
func TestUpstreamWebSocketIdlePoolIsolatesSessionsAndDropsHandshakeTurnState(t *testing.T) {
	fake := &fakeWSUpstream{turnStates: true}
	_, httpServer, cfg := newWSGateway(t, fake, account("a", "tok_a"))
	body := `{"model":"gpt-test","stream":true,"input":"hi"}`
	response, _ := wsRunSession(t, cfg, httpServer.URL, "key_1", "s1", body)
	if response.StatusCode != 200 || response.Header.Get("x-codex-turn-state") != "ts_1" {
		t.Fatalf("first turn status=%d turn-state=%q", response.StatusCode, response.Header.Get("x-codex-turn-state"))
	}
	response, _ = wsRunSession(t, cfg, httpServer.URL, "key_1", "s1", body)
	if fake.connections.Load() != 1 {
		t.Fatalf("same session should reuse the idle connection: %d", fake.connections.Load())
	}
	if got := response.Header.Get("x-codex-turn-state"); got != "" {
		t.Fatalf("reused connection replayed handshake turn-state %q", got)
	}
	wsRunSession(t, cfg, httpServer.URL, "key_1", "s2", body)
	if fake.connections.Load() != 2 {
		t.Fatalf("another session must not reuse s1's connection: %d", fake.connections.Load())
	}
	wsRunSession(t, cfg, httpServer.URL, "key_2", "s1", body)
	if fake.connections.Load() != 3 {
		t.Fatalf("another client scope must not reuse key_1's connection: %d", fake.connections.Load())
	}
	// 没有任何会话锚点（无会话、线程、prompt_cache_key，也无 instructions 与用户文本）：不入池
	for i := 0; i < 2; i++ {
		wsRunSession(t, cfg, httpServer.URL, "key_1", "", `{"model":"gpt-test","stream":true}`)
	}
	if fake.connections.Load() != 5 {
		t.Fatalf("anchorless requests must not be pooled: %d", fake.connections.Load())
	}
}

func TestConversationAnchorOrder(t *testing.T) {
	body := []byte(`{"model":"m","instructions":"sys","prompt_cache_key":"pck","previous_response_id":"resp_1","input":[{"role":"user","content":[{"type":"input_text","text":"<system-reminder>x</system-reminder> hello"}]}]}`)
	cases := []struct {
		name    string
		session string
		headers map[string]string
		body    []byte
		want    string
	}{
		{"thread spawn uses its own thread", "s", map[string]string{"x-openai-subagent": "thread_spawn", "thread-id": "t"}, body, "subagent-thread\x00t"},
		{"session first", "s", map[string]string{"thread-id": "t"}, body, "session\x00s"},
		{"thread", "", map[string]string{"thread-id": "t"}, body, "thread\x00t"},
		{"prompt cache key", "", nil, body, "prompt-cache\x00pck"},
		{"previous response when nothing stable", "", nil, []byte(`{"model":"m","previous_response_id":"resp_1"}`), "previous\x00resp_1"},
		{"none", "", nil, []byte(`{"model":"m"}`), ""},
	}
	for _, tc := range cases {
		if got := deriveConversationAnchor(tc.session, tc.headers, tc.body); got != tc.want {
			t.Errorf("%s: got %q want %q", tc.name, got, tc.want)
		}
	}
	// 稳定键忽略开头的 system-reminder，同一会话的不同提醒得到同一个键
	a := deriveConversationAnchor("", nil, []byte(`{"model":"m","input":[{"role":"user","content":"<system-reminder>a</system-reminder>hello"}]}`))
	b := deriveConversationAnchor("", nil, []byte(`{"model":"m","input":[{"role":"user","content":"<SYSTEM-REMINDER>b</SYSTEM-REMINDER> hello"}]}`))
	if a == "" || a != b {
		t.Fatalf("stable key should ignore leading reminders: %q %q", a, b)
	}
}

func TestUpstreamWebSocketTurnAndConnectionLocalContinuation(t *testing.T) {
	fake := &fakeWSUpstream{}
	acct := account("a", "tok_a")
	acct.ChatGPTAccountID = "chatgpt_a"
	_, httpServer, cfg := newWSGateway(t, fake, acct)
	response, body := wsRun(t, cfg, httpServer.URL, "conn_1", `{"model":"gpt-test","stream":true,"input":"hi"}`)
	if response.StatusCode != 200 || !strings.Contains(body, "event: response.completed") || !strings.Contains(body, "resp_ws_1_1") {
		t.Fatalf("status=%d body=%s", response.StatusCode, body)
	}
	fake.mu.Lock()
	handshake := fake.handshakes[0]
	first := fake.frames[0]
	fake.mu.Unlock()
	if handshake.Get("openai-beta") != wsBetaHeader || handshake.Get("originator") != "Codex Desktop" || handshake.Get("chatgpt-account-id") != "chatgpt_a" || handshake.Get("Authorization") != "Bearer tok_a" {
		t.Fatalf("handshake=%v", handshake)
	}
	if !strings.Contains(handshake.Get("Sec-Websocket-Extensions"), "permessage-deflate") {
		t.Fatalf("permessage-deflate not offered: %v", handshake)
	}
	if first["type"] != "response.create" || first["stream"] != true || first["model"] != "gpt-test" {
		t.Fatalf("frame=%v", first)
	}
	// 同一入站连接的续接走原上游连接，不新建连接
	response, body = wsRun(t, cfg, httpServer.URL, "conn_1", `{"model":"gpt-test","stream":true,"previous_response_id":"resp_ws_1_1","input":"more"}`)
	if response.StatusCode != 200 || !strings.Contains(body, "resp_ws_1_2") || fake.connections.Load() != 1 {
		t.Fatalf("continuation status=%d connections=%d body=%s", response.StatusCode, fake.connections.Load(), body)
	}
	// 其他入站连接不知道该 response id，也没有展开的完整历史：要求客户端重放
	response, body = wsRun(t, cfg, httpServer.URL, "conn_2", `{"model":"gpt-test","stream":true,"previous_response_id":"resp_ws_1_1","input":"x"}`)
	if response.StatusCode != 400 || !strings.Contains(body, "previous_response_not_found") {
		t.Fatalf("foreign continuation status=%d body=%s", response.StatusCode, body)
	}
}

func TestUpstreamWebSocketRecoversThenFallsBackToHTTP(t *testing.T) {
	fake := &fakeWSUpstream{}
	fake.dropFirst.Store(2)
	_, httpServer, cfg := newWSGateway(t, fake, account("a", "tok_a"))
	response, body := wsRun(t, cfg, httpServer.URL, "", `{"model":"gpt-test","stream":true,"input":"hi"}`)
	if response.StatusCode != 200 || !strings.Contains(body, "response.completed") || fake.connections.Load() != 3 {
		t.Fatalf("recovery status=%d connections=%d body=%s", response.StatusCode, fake.connections.Load(), body)
	}
	if got := response.Header.Get(upstreamTransportHeader); got != "websocket" {
		t.Fatalf("recovered transport=%q", got)
	}
	// 每次都在首个事件前断开：耗尽同账号恢复后回退 HTTP/SSE
	fake2 := &fakeWSUpstream{}
	fake2.dropFirst.Store(100)
	_, httpServer2, cfg2 := newWSGateway(t, fake2, account("a", "tok_a"))
	response, body = wsRun(t, cfg2, httpServer2.URL, "", `{"model":"gpt-test","stream":true,"input":"hi"}`)
	if response.StatusCode != 200 || !strings.Contains(body, "resp_http") {
		t.Fatalf("fallback status=%d body=%s", response.StatusCode, body)
	}
	// 回退后使用记录按 HTTP 记传输方式，路径与 WS 相同
	if got, path := response.Header.Get(upstreamTransportHeader), response.Header.Get(upstreamPathHeader); got != "http" || path != "/responses" {
		t.Fatalf("fallback transport=%q path=%q", got, path)
	}
}

func TestUpstreamWebSocketCloseBeforeTerminalIsIncomplete(t *testing.T) {
	fake := &fakeWSUpstream{closeEarly: true}
	_, httpServer, cfg := newWSGateway(t, fake, account("a", "tok_a"))
	response, _ := wsRun(t, cfg, httpServer.URL, "", `{"model":"gpt-test","stream":true,"input":"hi"}`)
	if response.StatusCode != 200 {
		t.Fatalf("status=%d", response.StatusCode)
	}
	if receipt := readReceipt(t, cfg); receipt["terminal_state"] == terminalCompleted {
		t.Fatalf("Close 1000 before a terminal event counted as success: %v", receipt)
	}
}

func TestUpstreamWebSocketHandshakeRejectionIsClassified(t *testing.T) {
	fake := &fakeWSUpstream{reject: 429}
	gw, httpServer, cfg := newWSGateway(t, fake, account("a", "tok_a"))
	response, body := wsRun(t, cfg, httpServer.URL, "", `{"model":"gpt-test","stream":true,"input":"hi"}`)
	if response.StatusCode != 429 || !strings.Contains(body, "usage_limit_reached") {
		t.Fatalf("status=%d body=%s", response.StatusCode, body)
	}
	if saved, _ := gw.store.Get("a"); saved.CooldownReason != string(categoryUsageLimit) {
		t.Fatalf("handshake 429 must cool the account: %+v", publicAccount(saved))
	}
}

func TestInterruptFrameIsForwardedToBoundUpstream(t *testing.T) {
	fake := &fakeWSUpstream{holdResponse: make(chan struct{})}
	_, httpServer, cfg := newWSGateway(t, fake, account("a", "tok_a"))
	done := make(chan string, 1)
	go func() {
		_, body := wsRun(t, cfg, httpServer.URL, "conn_i", `{"model":"gpt-test","stream":true,"input":"hi"}`)
		done <- body
	}()
	deadline := time.Now().Add(2 * time.Second)
	var status int
	for time.Now().Before(deadline) {
		resp, _ := accountActionRequest(t, cfg, httpServer.URL, "/internal/v1/ws/frame", map[string]any{"connection_key": "conn_i", "frame": map[string]any{"type": "response.interrupt", "response_id": "resp_ws_1_1"}})
		status = resp.StatusCode
		if status == 200 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	close(fake.holdResponse)
	<-done
	if status != 200 {
		t.Fatalf("interrupt status=%d", status)
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if len(fake.frames) < 2 || fake.frames[1]["type"] != "response.interrupt" {
		t.Fatalf("upstream frames=%v", fake.frames)
	}
	// 响应结束后没有活动响应：控制帧返回 409，由控制面回 interrupt.failed
	resp, _ := accountActionRequest(t, cfg, httpServer.URL, "/internal/v1/ws/frame", map[string]any{"connection_key": "conn_i", "frame": map[string]any{"type": "response.interrupt"}})
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("idle interrupt status=%d", resp.StatusCode)
	}
}

func TestResponseCreateFramePreservesFieldOrder(t *testing.T) {
	frame, search, err := responseCreateFrame([]byte(`{"model":"m","stream":true,"input":[1],"tools":[{"type":"web_search"}],"store":false}`))
	if err != nil || !search {
		t.Fatalf("err=%v search=%v", err, search)
	}
	if string(frame) != `{"type":"response.create","model":"m","stream":true,"input":[1],"tools":[{"type":"web_search"}],"store":false}` {
		t.Fatalf("frame=%s", frame)
	}
	// 缺少或为 false 的 stream 写为 true（CPR websocket_upstream_request）
	if frame, _, _ := responseCreateFrame([]byte(`{"model":"m","stream":false}`)); string(frame) != `{"type":"response.create","model":"m","stream":true}` {
		t.Fatalf("frame=%s", frame)
	}
	if frame, _, _ := responseCreateFrame([]byte(`{"model":"m"}`)); string(frame) != `{"type":"response.create","model":"m","stream":true}` {
		t.Fatalf("frame=%s", frame)
	}
}

func TestResponseCreateFrameDetectsLiteSearchDeclarations(t *testing.T) {
	cases := []struct {
		name string
		body string
		want bool
	}{
		{"top-level preview", `{"tools":[{"type":"web_search_preview_2025_03_11"}]}`, true},
		{"lite additional_tools", `{"input":[{"type":"message","role":"user","content":"hi"},{"type":"additional_tools","role":"developer","tools":[{"type":"web_search","external_web_access":false}]}]}`, true},
		{"lite tool_search_output", `{"input":[{"type":"tool_search_output","tools":[{"type":"web_search"}]}]}`, true},
		{"function named web_search", `{"tools":[{"type":"function","name":"web_search"}]}`, false},
		{"message text only", `{"input":[{"type":"message","content":"additional_tools web_search"}]}`, false},
		{"no tools", `{"input":[]}`, false},
	}
	for _, tc := range cases {
		_, search, err := responseCreateFrame([]byte(tc.body))
		if err != nil || search != tc.want {
			t.Fatalf("%s: err=%v search=%v want=%v", tc.name, err, search, tc.want)
		}
	}
}
