package codexgateway

import (
	"strings"
	"testing"
	"time"
)

const completedFrame = `{"type":"response.completed","response":{"id":"$ID","usage":{"input_tokens":1,"output_tokens":1}}}`

// 熔断按“源站 + 账号出口”分开：一个出口连续失败只打开自己的熔断；到期后只放一个半开探测，探测成功关闭。
func TestWSBreakerIsPerEgressWithHalfOpenProbe(t *testing.T) {
	pool := newWSPool()
	now := time.Now()
	for i := 0; i < wsBreakerThreshold; i++ {
		probe, ok := pool.breakerAcquire("o\x00a", now)
		if !ok {
			t.Fatalf("attempt %d rejected early", i)
		}
		pool.breakerResult("o\x00a", probe, false, now)
	}
	if _, ok := pool.breakerAcquire("o\x00a", now); ok {
		t.Fatal("breaker should be open after three cold-dial failures")
	}
	if _, ok := pool.breakerAcquire("o\x00b", now); !ok {
		t.Fatal("another egress must not be affected")
	}
	later := now.Add(wsBreakerOpenDuration)
	probe, ok := pool.breakerAcquire("o\x00a", later)
	if !ok || probe == 0 {
		t.Fatal("an expired breaker should grant one half-open probe")
	}
	if _, ok := pool.breakerAcquire("o\x00a", later); ok {
		t.Fatal("only one probe may run while half-open")
	}
	pool.breakerResult("o\x00a", probe, true, later)
	if _, ok := pool.breakerAcquire("o\x00a", later); !ok {
		t.Fatal("a successful probe closes the breaker")
	}
}

// 800ms 快路径：握手慢于预算时本次走 HTTP，后台建好的连接入池，同一会话的下一个请求直接复用。
func TestWSFastPathFallsBackAndPoolsBackgroundConnection(t *testing.T) {
	fake := &fakeWSUpstream{handshakeDelay: 1200 * time.Millisecond}
	_, httpServer, cfg := newWSGateway(t, fake, account("a", "tok_a"))
	body := `{"model":"gpt-test","stream":true,"input":"hi"}`
	response, text := wsRunSession(t, cfg, httpServer.URL, "key_1", "s_fast", body)
	if response.StatusCode != 200 || !strings.Contains(text, "resp_http") {
		t.Fatalf("a slow handshake should fall back to HTTP this time: status=%d body=%s", response.StatusCode, text)
	}
	time.Sleep(800 * time.Millisecond)
	response, text = wsRunSession(t, cfg, httpServer.URL, "key_1", "s_fast", body)
	if response.StatusCode != 200 || !strings.Contains(text, "resp_ws_1_1") || fake.connections.Load() != 1 {
		t.Fatalf("the background connection should be reused: status=%d connections=%d body=%s", response.StatusCode, fake.connections.Load(), text)
	}
}

// 终态回池（CPR reducer）：interrupted 的 incomplete 回池；其他 incomplete 与 error 帧丢弃连接。
// codex.rate_limits 不转发；metadata 帧里的 turn-state 交给客户端。
func TestWSTerminalPoolingRateLimitsAndMetadataTurnState(t *testing.T) {
	fake := &fakeWSUpstream{script: func(conn int32, turn int) []string {
		switch {
		case conn == 1 && turn == 1:
			return []string{`{"type":"response.metadata","headers":{"x-codex-turn-state":"ts_meta"}}`, `{"type":"codex.rate_limits","rate_limits":{"primary":{"used_percent":12,"window_minutes":300}}}`, `{"type":"response.created","response":{"id":"$ID"}}`, `{"type":"response.incomplete","response":{"id":"$ID","incomplete_details":{"reason":"interrupted"}}}`}
		case conn == 1 && turn == 2:
			return []string{`{"type":"response.created","response":{"id":"$ID"}}`, `{"type":"response.incomplete","response":{"id":"$ID","incomplete_details":{"reason":"max_output_tokens"}}}`}
		case conn == 2:
			return []string{`{"type":"response.created","response":{"id":"$ID"}}`, `{"type":"error","error":{"code":"internal","message":"boom"}}`}
		}
		return []string{`{"type":"response.created","response":{"id":"$ID"}}`, completedFrame}
	}}
	gw, httpServer, cfg := newWSGateway(t, fake, account("a", "tok_a"))
	body := `{"model":"gpt-test","stream":true,"input":"hi"}`
	response, text := wsRunSession(t, cfg, httpServer.URL, "key_1", "s_term", body)
	if strings.Contains(text, "codex.rate_limits") || response.Header.Get("x-codex-turn-state") != "ts_meta" {
		t.Fatalf("rate limits leaked or turn-state missing: header=%v body=%s", response.Header, text)
	}
	if saved, _ := gw.store.Get("a"); saved.Quota["primary_window"] == nil {
		t.Fatalf("rate limits should be merged into quota: %v", saved.Quota)
	}
	// 回执带上流内额度观测，控制面据此把已用比例与用量配对
	if quota, _ := readReceipt(t, cfg)["quota"].(map[string]any); quota["primary_window"] == nil {
		t.Fatalf("receipt must carry the stream rate limits: %v", quota)
	}
	wsRunSession(t, cfg, httpServer.URL, "key_1", "s_term", body)
	if fake.connections.Load() != 1 {
		t.Fatalf("an interrupted response returns the connection to the pool: %d", fake.connections.Load())
	}
	wsRunSession(t, cfg, httpServer.URL, "key_1", "s_term", body)
	if fake.connections.Load() != 2 {
		t.Fatalf("a max_output_tokens incomplete must discard the connection: %d", fake.connections.Load())
	}
	wsRunSession(t, cfg, httpServer.URL, "key_1", "s_term", body)
	if fake.connections.Load() != 3 {
		t.Fatalf("an error frame must discard the connection: %d", fake.connections.Load())
	}
}

// 首个语义输出前（只收到 created）断线：同账号恢复，不交付截断的流。
func TestWSRecoversWhenDroppedBeforeSemanticOutput(t *testing.T) {
	fake := &fakeWSUpstream{script: func(conn int32, turn int) []string {
		if conn == 1 {
			return []string{`{"type":"response.created","response":{"id":"$ID","output":[]}}`, "<close>"}
		}
		return []string{`{"type":"response.created","response":{"id":"$ID"}}`, `{"type":"response.output_text.delta","delta":"ok"}`, completedFrame}
	}}
	_, httpServer, cfg := newWSGateway(t, fake, account("a", "tok_a"))
	response, text := wsRunSession(t, cfg, httpServer.URL, "key_1", "s_rec", `{"model":"gpt-test","stream":true,"input":"hi"}`)
	if response.StatusCode != 200 || !strings.Contains(text, "resp_ws_2_1") || strings.Contains(text, "resp_ws_1_1") {
		t.Fatalf("should recover on a new connection: status=%d body=%s", response.StatusCode, text)
	}
}

// 空闲连接被上游关闭：读循环发现失效，下一个请求不会拿到它。
func TestWSIdleConnectionClosedUpstreamIsNotReused(t *testing.T) {
	fake := &fakeWSUpstream{closeAfterTurn: true}
	_, httpServer, cfg := newWSGateway(t, fake, account("a", "tok_a"))
	body := `{"model":"gpt-test","stream":true,"input":"hi"}`
	wsRunSession(t, cfg, httpServer.URL, "key_1", "s_idle", body)
	time.Sleep(100 * time.Millisecond)
	response, text := wsRunSession(t, cfg, httpServer.URL, "key_1", "s_idle", body)
	if response.StatusCode != 200 || !strings.Contains(text, "resp_ws_2_1") {
		t.Fatalf("a closed idle connection must not be reused: status=%d body=%s", response.StatusCode, text)
	}
}

// 必须走 WS 的预热（generate:false, store:false）不受熔断影响。
func TestWSRequiredWarmupBypassesBreaker(t *testing.T) {
	fake := &fakeWSUpstream{}
	gw, httpServer, cfg := newWSGateway(t, fake, account("a", "tok_a"))
	acct, _ := gw.store.Get("a")
	key := gw.wsBreakerKey(acct)
	for i := 0; i < wsBreakerThreshold; i++ {
		gw.ws.breakerResult(key, 0, false, time.Now())
	}
	response, text := wsRunSession(t, cfg, httpServer.URL, "key_1", "s_warm", `{"model":"gpt-test","stream":true,"generate":false,"store":false,"input":[]}`)
	if response.StatusCode != 200 || !strings.Contains(text, "resp_ws_1_1") {
		t.Fatalf("a required warmup must use WS even with the breaker open: status=%d body=%s", response.StatusCode, text)
	}
	// 普通请求在熔断打开时直接走 HTTP
	response, text = wsRunSession(t, cfg, httpServer.URL, "key_1", "s_plain", `{"model":"gpt-test","stream":true,"input":"x"}`)
	if response.StatusCode != 200 || !strings.Contains(text, "resp_http") {
		t.Fatalf("an open breaker should send ordinary requests over HTTP: status=%d body=%s", response.StatusCode, text)
	}
}
