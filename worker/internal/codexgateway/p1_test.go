package codexgateway

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/klauspost/compress/zstd"
)

func TestCodexCookiePolicyCapturesOnlyAllowedScopes(t *testing.T) {
	now := time.Now()
	origin, _ := url.Parse("https://chatgpt.com/backend-api/codex/responses")
	updates := parseCodexSetCookies(origin, []string{
		"cf_clearance=c1; Path=/; Secure",
		"__cf_bm=b1; Domain=.chatgpt.com; Path=/backend-api; Max-Age=60",
		"tracking=x; Path=/",                     // 不在允许名单
		"oai-did=d1; Domain=example.com; Path=/", // 域名不属于响应来源
		"_cfuvid=gone; Path=/; Max-Age=0",        // 删除指令
	}, now)
	if len(updates) != 3 {
		t.Fatalf("updates=%+v", updates)
	}
	if updates[0].cookie.Domain != "chatgpt.com" || !updates[0].cookie.HostOnly || !updates[0].cookie.Secure {
		t.Fatalf("host-only cookie=%+v", updates[0].cookie)
	}
	if updates[1].cookie.HostOnly || updates[1].cookie.Path != "/backend-api" || updates[1].cookie.ExpiresAt.IsZero() {
		t.Fatalf("domain cookie=%+v", updates[1].cookie)
	}
	if !updates[2].delete {
		t.Fatalf("expired cookie should delete: %+v", updates[2])
	}
	foreign, _ := url.Parse("https://example.com/")
	if parseCodexSetCookies(foreign, []string{"cf_clearance=c1"}, now) != nil {
		t.Fatal("cookies from a foreign origin must be ignored")
	}

	stored := []StoredCookie{updates[0].cookie, updates[1].cookie}
	target, _ := url.Parse("https://chatgpt.com/backend-api/codex/responses")
	if got := cookieHeader(stored, target, now); got != "__cf_bm=b1; cf_clearance=c1" {
		t.Fatalf("replay=%q", got)
	}
	plain, _ := url.Parse("http://chatgpt.com/backend-api/x")
	if got := cookieHeader(stored, plain, now); got != "__cf_bm=b1" {
		t.Fatalf("secure cookie must not replay over http: %q", got)
	}
	other, _ := url.Parse("https://ab.chatgpt.com/")
	if got := cookieHeader(stored, other, now); got != "" {
		t.Fatalf("host-only / path-scoped cookies leaked: %q", got)
	}
	header := http.Header{"Cookie": {"cf_clearance=old; session=s"}}
	mergeCookieHeader(header, "cf_clearance=c1")
	if header.Get("Cookie") != "session=s; cf_clearance=c1" {
		t.Fatalf("merged=%q", header.Get("Cookie"))
	}
}

func TestStoreCookiesFollowCredentialRevision(t *testing.T) {
	gw, _, _ := newExecuteServer(t, "http://127.0.0.1:1", account("a", "tok_a"))
	origin, _ := url.Parse("https://chatgpt.com/backend-api/codex")
	now := time.Now()
	a := mustGet(t, gw, "a")
	gw.store.ApplyCookies("a", a.CredentialRevision, parseCodexSetCookies(origin, []string{"cf_clearance=v1; Path=/"}, now), now)
	if got := mustGet(t, gw, "a").Cookies; len(got) != 1 || got[0].Value != "v1" {
		t.Fatalf("cookies=%+v", got)
	}
	// 迟到响应（旧凭据代次）不写入
	gw.store.ApplyCookies("a", a.CredentialRevision-1, parseCodexSetCookies(origin, []string{"cf_clearance=stale; Path=/"}, now), now)
	if got := mustGet(t, gw, "a").Cookies; got[0].Value != "v1" {
		t.Fatalf("stale revision overwrote cookie: %+v", got)
	}
	if publicAccount(mustGet(t, gw, "a")).Cookies != nil {
		t.Fatal("cookies must not appear in the public view")
	}
	// 新凭据代次投影后旧 Cookie 失效
	next := mustGet(t, gw, "a")
	next.CredentialRevision++
	next.Cookies = nil
	if _, err := gw.store.Upsert(next); err != nil {
		t.Fatal(err)
	}
	if got := mustGet(t, gw, "a").Cookies; len(got) != 0 {
		t.Fatalf("cookies survived a credential change: %+v", got)
	}
}

// forwardProxy 把发往 chatgpt.com 的明文请求转到本地上游，用于在测试中走真实 Cookie 作用域。
func forwardProxy(t *testing.T, upstream string) string {
	t.Helper()
	target, _ := url.Parse(upstream)
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		out := r.Clone(r.Context())
		out.RequestURI = ""
		out.URL.Scheme, out.URL.Host = target.Scheme, target.Host
		out.Header.Set("X-Original-Host", r.Host)
		resp, err := http.DefaultTransport.RoundTrip(out)
		if err != nil {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()
		for key, values := range resp.Header {
			w.Header()[key] = values
		}
		w.WriteHeader(resp.StatusCode)
		_, _ = io.Copy(w, resp.Body)
	}))
	t.Cleanup(proxy.Close)
	return proxy.URL
}

type turnUpstream struct {
	mu       sync.Mutex
	requests []http.Header
	bodies   []map[string]any
}

func (u *turnUpstream) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(decompressed(r, data), &body)
		u.mu.Lock()
		u.requests = append(u.requests, r.Header.Clone())
		u.bodies = append(u.bodies, body)
		n := len(u.requests)
		u.mu.Unlock()
		w.Header().Add("Set-Cookie", "cf_clearance=clear-1; Path=/")
		w.Header().Add("Set-Cookie", "unrelated=1; Path=/")
		w.Header().Set("x-codex-turn-state", fmt.Sprintf("ts-%d", n))
		w.Header().Set("Content-Type", "text/event-stream")
		id := fmt.Sprintf("resp_turn_%d", n)
		_, _ = io.WriteString(w, "data: {\"type\":\"response.created\",\"response\":{\"id\":\""+id+"\"}}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\""+id+"\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}\n\n")
	})
}

func decompressed(r *http.Request, data []byte) []byte {
	if r.Header.Get("Content-Encoding") != "zstd" {
		return data
	}
	decoder, _ := zstd.NewReader(nil)
	defer decoder.Close()
	out, err := decoder.DecodeAll(data, nil)
	if err != nil {
		return data
	}
	return out
}

func turnRun(t *testing.T, cfg Config, url string, headers map[string]string, body string) *http.Response {
	t.Helper()
	n := nonceSeq.Add(1)
	response := signedExecute(t, cfg, url, Envelope{Dispatch: fmt.Sprintf("d_t_%d", n), RequestID: fmt.Sprintf("r_t_%d", n), Nonce: fmt.Sprintf("n_t_%d", n), Operation: "responses", Protocol: "openai.responses", Model: "gpt-test", Stream: true, Headers: headers, ClientScope: "key_1", Body: json.RawMessage(body), Scope: Scope{GroupIDs: []int64{1}}})
	_, _ = io.ReadAll(response.Body)
	response.Body.Close()
	return response
}

func TestHTTPAttemptReplaysCookiesAndTurnStateOnSameAccount(t *testing.T) {
	upstream := &turnUpstream{}
	server := httptest.NewServer(upstream.handler())
	t.Cleanup(server.Close)
	acct := account("a", "tok_a")
	acct.ProxyURL = forwardProxy(t, server.URL)
	gw, httpServer, cfg := newExecuteServer(t, "http://chatgpt.com/backend-api/codex", acct)
	headers := map[string]string{"session-id": "sess_1", "x-codex-turn-id": "turn_1", "openai-beta": "responses=experimental"}
	first := turnRun(t, cfg, httpServer.URL, headers, `{"model":"gpt-test","stream":true,"input":"hi"}`)
	if first.StatusCode != 200 || first.Header.Get("x-codex-turn-state") != "ts-1" {
		t.Fatalf("first status=%d turn-state=%q", first.StatusCode, first.Header.Get("x-codex-turn-state"))
	}
	// 同一 turn 的后续请求：回放上一轮 turn-state 与账号 Cookie
	turnRun(t, cfg, httpServer.URL, headers, `{"model":"gpt-test","stream":true,"input":"tool output"}`)
	// 新 turn：不回放旧 turn-state
	turnRun(t, cfg, httpServer.URL, map[string]string{"session-id": "sess_1", "x-codex-turn-id": "turn_2"}, `{"model":"gpt-test","stream":true,"input":"next"}`)

	upstream.mu.Lock()
	defer upstream.mu.Unlock()
	if len(upstream.requests) != 3 {
		t.Fatalf("requests=%d", len(upstream.requests))
	}
	firstReq, second, third := upstream.requests[0], upstream.requests[1], upstream.requests[2]
	if firstReq.Get("Cookie") != "" || firstReq.Get("x-codex-turn-state") != "" {
		t.Fatalf("first request should carry no replayed state: %v", firstReq)
	}
	if second.Get("Cookie") != "cf_clearance=clear-1" || second.Get("x-codex-turn-state") != "ts-1" {
		t.Fatalf("second request cookie=%q turn-state=%q", second.Get("Cookie"), second.Get("x-codex-turn-state"))
	}
	if third.Get("x-codex-turn-state") != "" {
		t.Fatalf("turn-state leaked into a new turn: %q", third.Get("x-codex-turn-state"))
	}
	for _, req := range upstream.requests {
		if req.Get("openai-beta") != "" || req.Get("x-codex-turn-id") != "" || req.Get("Accept") != "text/event-stream" {
			t.Fatalf("HTTP header contract violated: %v", req)
		}
	}
	metadata, _ := upstream.bodies[0]["client_metadata"].(map[string]any)
	if metadata["x-codex-installation-id"] != mustGet(t, gw, "a").InstallationID {
		t.Fatalf("installation id not written to client_metadata: %v", upstream.bodies[0])
	}
	if cookies := mustGet(t, gw, "a").Cookies; len(cookies) != 1 || cookies[0].Name != "cf_clearance" {
		t.Fatalf("stored cookies=%+v", cookies)
	}
}

func TestScopeRequestToAccountDropsForeignState(t *testing.T) {
	body := []byte(`{"model":"m","previous_response_id":"resp_x","turn_state":"t","chatgpt_account_id":"other","client_metadata":{"x-codex-turn-state":"t","parent_response_id":"p","installation_id":"old","turn_metadata":"{\"turn_state\":\"t\",\"installation_id\":\"old\",\"kind\":\"k\"}"}}`)
	out := scopeRequestToAccount(body, "inst-new", attemptState{scope: scopeDifferent})
	var parsed map[string]any
	if err := json.Unmarshal(out, &parsed); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"previous_response_id", "turn_state", "chatgpt_account_id"} {
		if _, ok := parsed[key]; ok {
			t.Fatalf("%s survived a cross-account attempt: %s", key, out)
		}
	}
	metadata := parsed["client_metadata"].(map[string]any)
	if metadata["x-codex-turn-state"] != nil || metadata["parent_response_id"] != nil || metadata["installation_id"] != "inst-new" || metadata["x-codex-installation-id"] != "inst-new" {
		t.Fatalf("metadata=%v", metadata)
	}
	if turn := metadata["turn_metadata"].(string); strings.Contains(turn, "turn_state") || !strings.Contains(turn, `"installation_id":"inst-new"`) {
		t.Fatalf("turn metadata=%s", turn)
	}
	same := scopeRequestToAccount(body, "inst-new", attemptState{scope: scopeSame})
	if !strings.Contains(string(same), `"previous_response_id":"resp_x"`) || !strings.Contains(string(same), `"x-codex-turn-state":"t"`) {
		t.Fatalf("same-account attempt lost its state: %s", same)
	}
}

func TestWebSocketFrameCarriesClientMetadataProjection(t *testing.T) {
	now := time.UnixMilli(1_762_000_000_123)
	out := projectWSClientMetadata([]byte(`{"type":"response.create","model":"m","client_metadata":{"a":"b","x-codex-turn-state":"stale"}}`), "lite-1", "ts-9", now)
	var parsed map[string]any
	if err := json.Unmarshal(out, &parsed); err != nil {
		t.Fatal(err)
	}
	metadata := parsed["client_metadata"].(map[string]any)
	if metadata["a"] != "b" || metadata[wsResponsesLiteMetadataKey] != "lite-1" || metadata["x-codex-turn-state"] != "ts-9" || metadata[wsRequestStartMetadataKey] != "1762000000123" {
		t.Fatalf("metadata=%v", metadata)
	}
	empty := projectWSClientMetadata([]byte(`{"type":"response.create"}`), "", "", now)
	if !strings.Contains(string(empty), `"client_metadata":{"x-codex-ws-stream-request-start-ms":"1762000000123"}`) {
		t.Fatalf("empty=%s", empty)
	}
}
