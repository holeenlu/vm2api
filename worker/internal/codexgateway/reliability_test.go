package codexgateway

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// scriptedUpstream 按账号 token 返回预设响应序列，用于覆盖重试与换号路径。
type scriptedUpstream struct {
	mu      sync.Mutex
	scripts map[string][]func(http.ResponseWriter)
	calls   map[string]int
	order   []string
}

func newScriptedUpstream(t *testing.T, scripts map[string][]func(http.ResponseWriter)) (*scriptedUpstream, *httptest.Server) {
	t.Helper()
	u := &scriptedUpstream{scripts: scripts, calls: map[string]int{}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		u.mu.Lock()
		index := u.calls[token]
		u.calls[token]++
		u.order = append(u.order, token)
		steps := u.scripts[token]
		u.mu.Unlock()
		if len(steps) == 0 {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		if index >= len(steps) {
			index = len(steps) - 1
		}
		steps[index](w)
	}))
	t.Cleanup(server.Close)
	return u, server
}

func (u *scriptedUpstream) count(token string) int {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.calls[token]
}

func jsonReply(status int, body string, headers ...string) func(http.ResponseWriter) {
	return func(w http.ResponseWriter) {
		for i := 0; i+1 < len(headers); i += 2 {
			w.Header().Set(headers[i], headers[i+1])
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	}
}

func sseReply(events ...string) func(http.ResponseWriter) {
	return func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		for _, event := range events {
			_, _ = io.WriteString(w, "data: "+event+"\n\n")
		}
	}
}

const okResponse = `{"id":"resp_ok","usage":{"input_tokens":1,"output_tokens":1}}`

func account(id, token string) Account {
	return Account{ID: id, Enabled: true, AccessToken: token, Groups: []string{"1"}, Weight: 1}
}

var nonceSeq atomic.Int64

func run(t *testing.T, cfg Config, url string, stream bool) (*http.Response, []byte) {
	t.Helper()
	n := nonceSeq.Add(1)
	body := `{"model":"gpt-test"}`
	if stream {
		body = `{"model":"gpt-test","stream":true}`
	}
	response := signedExecute(t, cfg, url, Envelope{Dispatch: fmt.Sprintf("d_%d", n), RequestID: fmt.Sprintf("r_%d", n), Nonce: fmt.Sprintf("n_%d", n), Operation: "responses", Protocol: "openai.responses", Model: "gpt-test", Stream: stream, Body: json.RawMessage(body), Scope: Scope{GroupIDs: []int64{1}}})
	data, _ := io.ReadAll(response.Body)
	response.Body.Close()
	return response, data
}

func attemptsOf(t *testing.T, response *http.Response) []attemptRecord {
	t.Helper()
	var records []attemptRecord
	if err := json.Unmarshal([]byte(response.Header.Get(attemptsHeader)), &records); err != nil {
		t.Fatalf("attempts header=%q: %v", response.Header.Get(attemptsHeader), err)
	}
	return records
}

func TestClassifierMatchesCPROrder(t *testing.T) {
	now := time.Now()
	cases := []struct {
		name   string
		status int
		body   string
		header http.Header
		want   failureCategory
	}{
		{"flex", 400, `{"error":{"code":"flex_unavailable"}}`, nil, categoryFlexUnavailable},
		{"turn rate", 429, `{"error":{"code":"turn_rate_limit_exceeded"}}`, nil, categoryTurnRateLimited},
		{"overloaded 503", 503, `{"error":{"type":"server_error","code":"server_is_overloaded"}}`, nil, categoryCapacity},
		{"slow down 429", 429, `{"error":{"code":"slow_down"}}`, nil, categoryCapacity},
		{"usage limit", 429, `{"error":{"type":"usage_limit_reached","resets_at":1999999999}}`, nil, categoryUsageLimit},
		{"plain 429", 429, `{"error":{"type":"rate_limit_error"}}`, nil, categoryRateLimited},
		{"model", 404, `{"error":{"code":"model_not_found"}}`, nil, categoryModelUnsupported},
		{"banned", 403, `{"error":{"code":"account_deactivated"}}`, nil, categoryBanned},
		{"401", 401, `{"error":{"message":"bad"}}`, nil, categoryCredentialExpired},
		{"cloudflare", 403, `<html>Just a moment...</html>`, nil, categoryCloudflareChallenge},
		{"path blocked", 404, ``, nil, categoryCloudflarePathBlocked},
		{"402", 402, `{}`, nil, categoryQuotaExhausted},
		{"503 server_error", 503, `{"error":{"code":"server_error"}}`, nil, categoryUnavailable},
		{"422", 422, `{"error":{"message":"bad input"}}`, nil, categoryInvalidRequest},
		{"identity header", 403, `{}`, http.Header{"X-Openai-Authorization-Error": {"identity_verification_required"}}, categoryIdentityVerification},
	}
	for _, tc := range cases {
		header := tc.header
		if header == nil {
			header = http.Header{}
		}
		got := classifyHTTPFailure(tc.status, header, []byte(tc.body), now)
		if got.Category != tc.want {
			t.Errorf("%s: got %s want %s", tc.name, got.Category, tc.want)
		}
	}
	usage := classifyHTTPFailure(429, http.Header{}, []byte(`{"error":{"type":"usage_limit_reached","resets_at":1999999999}}`), now)
	if usage.ResetsAt.Unix() != 1999999999 {
		t.Fatalf("resets_at=%v", usage.ResetsAt)
	}
	if !classifyHTTPFailure(503, http.Header{}, []byte(`{"error":{"code":"server_error"}}`), now).isRetryableServerError() {
		t.Fatal("503 server_error must be retryable on the same account")
	}
	status, body := classifyHTTPFailure(503, http.Header{}, []byte(`{"error":{"type":"server_error","code":"server_is_overloaded"}}`), now).clientProjection()
	if status != 503 || strings.Contains(string(body), "server_is_overloaded") {
		t.Fatalf("overload projection status=%d body=%s", status, body)
	}
}

func TestUsageLimitRotatesToAnotherAccountAndCoolsDown(t *testing.T) {
	upstream, server := newScriptedUpstream(t, map[string][]func(http.ResponseWriter){
		"tok_a": {jsonReply(429, `{"error":{"type":"usage_limit_reached","resets_at":1999999999}}`)},
		"tok_b": {jsonReply(200, okResponse)},
	})
	gw, httpServer, cfg := newExecuteServer(t, server.URL, account("a", "tok_a"), Account{ID: "b", Enabled: true, AccessToken: "tok_b", Groups: []string{"1"}, Weight: 1, InFlight: 0})
	// 让 a 排在前面
	gw.store.mu.Lock()
	b := gw.store.accounts["b"]
	b.LastUsedAt = time.Now()
	gw.store.accounts["b"] = b
	gw.store.mu.Unlock()
	response, body := run(t, cfg, httpServer.URL, false)
	if response.StatusCode != 200 || !strings.Contains(string(body), "resp_ok") {
		t.Fatalf("status=%d body=%s", response.StatusCode, body)
	}
	if response.Header.Get("X-Kin-Gateway-Account") != "b" || upstream.count("tok_a") != 1 {
		t.Fatalf("account=%s calls a=%d", response.Header.Get("X-Kin-Gateway-Account"), upstream.count("tok_a"))
	}
	records := attemptsOf(t, response)
	if len(records) != 2 || records[0].Category != string(categoryUsageLimit) || records[1].Status != 200 {
		t.Fatalf("attempts=%+v", records)
	}
	a, _ := gw.store.Get("a")
	if a.CooldownUntil.Unix() != 1999999999 || a.CooldownReason != string(categoryUsageLimit) || a.InFlight != 0 {
		t.Fatalf("account a=%+v", publicAccount(a))
	}
	b2, _ := gw.store.Get("b")
	if b2.InFlight != 0 {
		t.Fatalf("account b in-flight=%d", b2.InFlight)
	}
}

func TestAllAccountsUsageLimitedReturns429UsageLimit(t *testing.T) {
	_, server := newScriptedUpstream(t, map[string][]func(http.ResponseWriter){})
	gw, httpServer, cfg := newExecuteServer(t, server.URL, account("a", "tok_a"))
	gw.store.Dispose("a", "gpt-test", upstreamFailure{Category: categoryUsageLimit, ResetsAt: time.Now().Add(time.Hour)}, time.Now())
	response, body := run(t, cfg, httpServer.URL, false)
	if response.StatusCode != 429 || !strings.Contains(string(body), "usage_limit_reached") || response.Header.Get(sendStateHeader) != "not_sent" {
		t.Fatalf("status=%d send=%s body=%s", response.StatusCode, response.Header.Get(sendStateHeader), body)
	}
}

func TestCapacityRetriesSameAccountThenSucceeds(t *testing.T) {
	overloaded := jsonReply(503, `{"error":{"type":"server_error","code":"server_is_overloaded"}}`, "Retry-After", "0")
	upstream, server := newScriptedUpstream(t, map[string][]func(http.ResponseWriter){
		"tok_a": {overloaded, overloaded, jsonReply(200, okResponse)},
	})
	_, httpServer, cfg := newExecuteServer(t, server.URL, account("a", "tok_a"))
	response, _ := run(t, cfg, httpServer.URL, false)
	if response.StatusCode != 200 || upstream.count("tok_a") != 3 {
		t.Fatalf("status=%d calls=%d", response.StatusCode, upstream.count("tok_a"))
	}
}

func TestCapacityExhaustionRotatesAndProjectsServerError(t *testing.T) {
	overloaded := jsonReply(503, `{"error":{"type":"server_error","code":"server_is_overloaded"}}`, "Retry-After", "0")
	upstream, server := newScriptedUpstream(t, map[string][]func(http.ResponseWriter){
		"tok_a": {overloaded},
	})
	_, httpServer, cfg := newExecuteServer(t, server.URL, account("a", "tok_a"))
	response, body := run(t, cfg, httpServer.URL, false)
	// 首次 + 3 次同号重试，单账号无可换，交付投影后的 503 server_error
	if upstream.count("tok_a") != 4 || response.StatusCode != 503 || strings.Contains(string(body), "server_is_overloaded") {
		t.Fatalf("calls=%d status=%d body=%s", upstream.count("tok_a"), response.StatusCode, body)
	}
	if response.Header.Get(sendStateHeader) != "sent" {
		t.Fatalf("send state=%s", response.Header.Get(sendStateHeader))
	}
}

func TestServerError503StaysOnAccountAndDoesNotRotate(t *testing.T) {
	failing := jsonReply(503, `{"error":{"code":"server_error"}}`, "Retry-After", "0")
	upstream, server := newScriptedUpstream(t, map[string][]func(http.ResponseWriter){
		"tok_a": {failing},
		"tok_b": {jsonReply(200, okResponse)},
	})
	gw, httpServer, cfg := newExecuteServer(t, server.URL, account("a", "tok_a"), account("b", "tok_b"))
	gw.store.mu.Lock()
	b := gw.store.accounts["b"]
	b.LastUsedAt = time.Now()
	gw.store.accounts["b"] = b
	gw.store.mu.Unlock()
	response, _ := run(t, cfg, httpServer.URL, false)
	if upstream.count("tok_a") != 6 || upstream.count("tok_b") != 0 || response.StatusCode != 503 {
		t.Fatalf("a=%d b=%d status=%d", upstream.count("tok_a"), upstream.count("tok_b"), response.StatusCode)
	}
}

func TestFlexUnavailableIsTerminal(t *testing.T) {
	upstream, server := newScriptedUpstream(t, map[string][]func(http.ResponseWriter){
		"tok_a": {jsonReply(400, `{"error":{"code":"flex_unavailable"}}`)},
		"tok_b": {jsonReply(200, okResponse)},
	})
	_, httpServer, cfg := newExecuteServer(t, server.URL, account("a", "tok_a"), account("b", "tok_b"))
	response, _ := run(t, cfg, httpServer.URL, false)
	if response.StatusCode != 400 || upstream.count("tok_a")+upstream.count("tok_b") != 1 {
		t.Fatalf("status=%d a=%d b=%d", response.StatusCode, upstream.count("tok_a"), upstream.count("tok_b"))
	}
}

func TestModelUnsupportedCoolsAccountModelOnly(t *testing.T) {
	_, server := newScriptedUpstream(t, map[string][]func(http.ResponseWriter){
		"tok_a": {jsonReply(404, `{"error":{"code":"model_not_found"}}`)},
		"tok_b": {jsonReply(200, okResponse)},
	})
	gw, httpServer, cfg := newExecuteServer(t, server.URL, account("a", "tok_a"), account("b", "tok_b"))
	gw.store.mu.Lock()
	b := gw.store.accounts["b"]
	b.LastUsedAt = time.Now()
	gw.store.accounts["b"] = b
	gw.store.mu.Unlock()
	response, _ := run(t, cfg, httpServer.URL, false)
	if response.StatusCode != 200 {
		t.Fatalf("status=%d", response.StatusCode)
	}
	a, _ := gw.store.Get("a")
	if !a.ModelCooldowns["gpt-test"].After(time.Now().Add(29*time.Minute)) || !a.CooldownUntil.IsZero() {
		t.Fatalf("account a=%+v", publicAccount(a))
	}
	if _, err := gw.store.Select(Scope{GroupIDs: []int64{1}}, "other-model", map[string]bool{"b": true}); err != nil {
		t.Fatalf("other models must stay selectable on a: %v", err)
	}
}

func TestCredentialExpiredRefreshesThenRetriesSameAccount(t *testing.T) {
	var refreshes atomic.Int32
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		refreshes.Add(1)
		_ = r.ParseForm()
		if r.Form.Get("refresh_token") != "rt_a" {
			w.WriteHeader(400)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"access_token":"tok_new","refresh_token":"rt_a2","expires_in":3600}`)
	}))
	defer tokenServer.Close()
	upstream, server := newScriptedUpstream(t, map[string][]func(http.ResponseWriter){
		"tok_old": {jsonReply(401, `{"error":{"code":"token_expired"}}`)},
		"tok_new": {jsonReply(200, okResponse)},
	})
	cfg := Config{DataDir: t.TempDir(), InternalToken: "secret", UpstreamBaseURL: server.URL, OAuthTokenURL: tokenServer.URL, RequestTimeoutSec: 5}
	cfg.applyDefaults()
	gw, err := NewServer(cfg)
	if err != nil {
		t.Fatal(err)
	}
	acct := account("a", "tok_old")
	acct.RefreshToken = "rt_a"
	acct.ExpiresAt = time.Now().Add(time.Hour)
	if _, err := gw.store.Upsert(acct); err != nil {
		t.Fatal(err)
	}
	httpServer := httptest.NewServer(gw.Handler())
	defer httpServer.Close()
	response, _ := run(t, cfg, httpServer.URL, false)
	if response.StatusCode != 200 || refreshes.Load() != 1 || upstream.count("tok_new") != 1 {
		t.Fatalf("status=%d refreshes=%d new=%d", response.StatusCode, refreshes.Load(), upstream.count("tok_new"))
	}
	saved, _ := gw.store.Get("a")
	if saved.AccessToken != "tok_new" || saved.RefreshToken != "rt_a2" || saved.CredentialRevision != 2 || saved.CredentialState != "" {
		t.Fatalf("saved=%+v", publicAccount(saved))
	}
	if response.Header.Get("X-Kin-Gateway-Credential-Revision") != "2" {
		t.Fatalf("credential revision header=%s", response.Header.Get("X-Kin-Gateway-Credential-Revision"))
	}
}

func TestRefreshIsSingleFlightAndTerminalCodesInvalidate(t *testing.T) {
	var refreshes atomic.Int32
	release := make(chan struct{})
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		refreshes.Add(1)
		<-release
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"access_token":"tok_new","expires_in":3600}`)
	}))
	defer tokenServer.Close()
	cfg := Config{DataDir: t.TempDir(), InternalToken: "secret", OAuthTokenURL: tokenServer.URL, RequestTimeoutSec: 5}
	cfg.applyDefaults()
	gw, _ := NewServer(cfg)
	acct := account("a", "tok_old")
	acct.RefreshToken = "rt"
	_, _ = gw.store.Upsert(acct)
	var wg sync.WaitGroup
	for range 5 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = gw.refreshNow(context.Background(), "a")
		}()
	}
	time.Sleep(100 * time.Millisecond)
	close(release)
	wg.Wait()
	if refreshes.Load() != 1 {
		t.Fatalf("refresh calls=%d, want single flight", refreshes.Load())
	}

	terminal := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(400)
		_, _ = io.WriteString(w, `{"error":{"code":"refresh_token_reused","message":"reused"}}`)
	}))
	defer terminal.Close()
	gw.cfg.OAuthTokenURL = terminal.URL
	if _, err := gw.refreshNow(context.Background(), "a"); err == nil {
		t.Fatal("expected terminal refresh failure")
	}
	saved, _ := gw.store.Get("a")
	if saved.CredentialState != "invalid" {
		t.Fatalf("credential state=%q", saved.CredentialState)
	}
	if _, err := gw.store.Select(Scope{GroupIDs: []int64{1}}, "gpt-test", nil); err == nil {
		t.Fatal("invalid credential must not be selected")
	}
}

func TestRefreshLoopRefreshesAccountsInsideStaggeredWindow(t *testing.T) {
	var refreshed sync.Map
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		refreshed.Store(r.Form.Get("refresh_token"), true)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"access_token":"tok_new","expires_in":3600}`)
	}))
	defer tokenServer.Close()
	cfg := Config{DataDir: t.TempDir(), InternalToken: "secret", OAuthTokenURL: tokenServer.URL}
	cfg.applyDefaults()
	gw, _ := NewServer(cfg)
	soon := account("soon", "t1")
	soon.RefreshToken = "rt_soon"
	soon.ExpiresAt = time.Now().Add(2 * time.Minute)
	later := account("later", "t2")
	later.RefreshToken = "rt_later"
	later.ExpiresAt = time.Now().Add(time.Hour)
	_, _ = gw.store.Upsert(soon)
	_, _ = gw.store.Upsert(later)
	if count := gw.refreshDueAccounts(context.Background(), time.Now()); count != 1 {
		t.Fatalf("refreshed=%d", count)
	}
	if _, ok := refreshed.Load("rt_soon"); !ok {
		t.Fatal("expiring account was not refreshed")
	}
	if _, ok := refreshed.Load("rt_later"); ok {
		t.Fatal("account outside the window was refreshed")
	}
	if stagger := refreshStagger("soon"); stagger < 0 || stagger > refreshMargin || stagger != refreshStagger("soon") {
		t.Fatalf("stagger=%v", stagger)
	}
}

func TestStreamFailureBeforeContentRotates(t *testing.T) {
	upstream, server := newScriptedUpstream(t, map[string][]func(http.ResponseWriter){
		"tok_a": {sseReply(`{"type":"response.created","response":{"id":"r1"}}`, `{"type":"response.failed","response":{"error":{"type":"usage_limit_reached","code":"usage_limit_reached"}}}`)},
		"tok_b": {sseReply(`{"type":"response.created","response":{"id":"r2"}}`, `{"type":"response.output_text.delta","delta":"hi"}`, `{"type":"response.completed","response":{"id":"r2","usage":{"input_tokens":2,"output_tokens":1,"output_tokens_details":{"reasoning_tokens":1}}}}`)},
	})
	gw, httpServer, cfg := newExecuteServer(t, server.URL, account("a", "tok_a"), account("b", "tok_b"))
	gw.store.mu.Lock()
	b := gw.store.accounts["b"]
	b.LastUsedAt = time.Now()
	gw.store.accounts["b"] = b
	gw.store.mu.Unlock()
	response, body := run(t, cfg, httpServer.URL, true)
	if response.StatusCode != 200 || strings.Contains(string(body), `"r1"`) || !strings.Contains(string(body), "response.completed") {
		t.Fatalf("status=%d body=%s", response.StatusCode, body)
	}
	if upstream.count("tok_a") != 1 || response.Header.Get("X-Kin-Gateway-Account") != "b" {
		t.Fatalf("a=%d account=%s", upstream.count("tok_a"), response.Header.Get("X-Kin-Gateway-Account"))
	}
	receipt := readReceipt(t, cfg)
	usage, _ := receipt["usage"].(map[string]any)
	details, _ := usage["output_tokens_details"].(map[string]any)
	if receipt["usage_confidence"] != "complete" || details["reasoning_tokens"] != float64(1) {
		t.Fatalf("receipt usage=%v", receipt["usage"])
	}
	if attempts, _ := receipt["attempts"].([]any); len(attempts) != 2 {
		t.Fatalf("receipt attempts=%v", receipt["attempts"])
	}
}

func TestLongStreamKeepsTerminalUsage(t *testing.T) {
	big := strings.Repeat("x", 64<<10)
	events := []string{`{"type":"response.created","response":{"id":"r"}}`}
	for range 80 {
		events = append(events, `{"type":"response.output_text.delta","delta":"`+big+`"}`)
	}
	events = append(events, `{"type":"response.completed","response":{"id":"r","usage":{"input_tokens":9,"output_tokens":7}}}`)
	_, server := newScriptedUpstream(t, map[string][]func(http.ResponseWriter){"tok_a": {sseReply(events...)}})
	_, httpServer, cfg := newExecuteServer(t, server.URL, account("a", "tok_a"))
	response, body := run(t, cfg, httpServer.URL, true)
	if response.StatusCode != 200 || len(body) < 5<<20 {
		t.Fatalf("status=%d len=%d", response.StatusCode, len(body))
	}
	receipt := readReceipt(t, cfg)
	usage, _ := receipt["usage"].(map[string]any)
	if usage["output_tokens"] != float64(7) {
		t.Fatalf("usage lost on a >5MB stream: %v", receipt["usage"])
	}
}

func TestStreamWithoutTerminalEventIsIncomplete(t *testing.T) {
	_, server := newScriptedUpstream(t, map[string][]func(http.ResponseWriter){
		"tok_a": {sseReply(`{"type":"response.created","response":{"id":"r"}}`, `{"type":"response.output_text.delta","delta":"hi"}`)},
	})
	_, httpServer, cfg := newExecuteServer(t, server.URL, account("a", "tok_a"))
	response, _ := run(t, cfg, httpServer.URL, true)
	if response.StatusCode != 200 {
		t.Fatalf("status=%d", response.StatusCode)
	}
	if receipt := readReceipt(t, cfg); receipt["terminal_state"] != terminalIncomplete {
		t.Fatalf("terminal_state=%v", receipt["terminal_state"])
	}
}

func TestRateLimitedRPMEvidenceExpires(t *testing.T) {
	store, _ := OpenStore(t.TempDir() + "/accounts.json")
	_, _ = store.Upsert(account("a", "tok"))
	stale := time.Now().Add(-2 * time.Minute).UTC().Format(time.RFC3339Nano)
	store.UpdateQuota("a", map[string]any{"rpm_remaining": float64(0), "confidence": "partial", "updated_at": stale})
	if _, err := store.Select(Scope{GroupIDs: []int64{1}}, "gpt-test", nil); err != nil {
		t.Fatalf("stale RPM evidence must not lock the account: %v", err)
	}
}

func TestInFlightIsNotRestoredAfterRestart(t *testing.T) {
	path := t.TempDir() + "/accounts.json"
	store, _ := OpenStore(path)
	_, _ = store.Upsert(Account{ID: "a", Enabled: true, AccessToken: "t", MaxConcurrency: 1, Groups: []string{"1"}})
	if _, err := store.Select(Scope{GroupIDs: []int64{1}}, "m", nil); err != nil {
		t.Fatal(err)
	}
	store.Dispose("a", "m", upstreamFailure{Category: categoryModelUnsupported}, time.Now()) // forces persist
	reopened, _ := OpenStore(path)
	if account, _ := reopened.Get("a"); account.InFlight != 0 {
		t.Fatalf("in-flight restored as %d", account.InFlight)
	}
	// 控制面投影不能覆盖运行时观察
	_, _ = store.Upsert(Account{ID: "a", Enabled: true, Groups: []string{"1"}})
	if account, _ := store.Get("a"); account.InFlight != 1 || account.ModelCooldowns["m"].IsZero() {
		t.Fatalf("projection reset runtime state: %+v", publicAccount(account))
	}
}

func readReceipt(t *testing.T, cfg Config) map[string]any {
	t.Helper()
	// 上游带 Content-Length 时客户端可能先读完正文，Receipt 随后才落盘
	var entries []string
	var err error
	for deadline := time.Now().Add(2 * time.Second); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		entries, err = filepathGlob(cfg.ReceiptDir())
		if err == nil && len(entries) > 0 {
			break
		}
	}
	if err != nil || len(entries) == 0 {
		t.Fatalf("no receipt: %v", err)
	}
	data, _ := readFile(entries[len(entries)-1])
	var receipt map[string]any
	if err := json.Unmarshal(data, &receipt); err != nil {
		t.Fatal(err)
	}
	return receipt
}

func filepathGlob(dir string) ([]string, error) { return filepath.Glob(filepath.Join(dir, "*.json")) }

func readFile(path string) ([]byte, error) { return os.ReadFile(path) }

func TestContinuationOnExhaustedAccountReturnsPreviousResponseNotFound(t *testing.T) {
	upstream, server := newScriptedUpstream(t, map[string][]func(http.ResponseWriter){
		"tok_a": {jsonReply(429, `{"error":{"type":"usage_limit_reached"}}`)},
		"tok_b": {jsonReply(200, okResponse)},
	})
	_, httpServer, cfg := newExecuteServer(t, server.URL, account("a", "tok_a"), account("b", "tok_b"))
	n := nonceSeq.Add(1)
	response := signedExecute(t, cfg, httpServer.URL, Envelope{Dispatch: fmt.Sprintf("d_%d", n), RequestID: fmt.Sprintf("r_%d", n), Nonce: fmt.Sprintf("n_%d", n), Operation: "responses", Protocol: "openai.responses", Model: "gpt-test", Body: json.RawMessage(`{"model":"gpt-test","previous_response_id":"resp_1"}`), Scope: Scope{GroupIDs: []int64{1}, RuntimeAccountID: "a"}})
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != 400 || !strings.Contains(string(body), "previous_response_not_found") || upstream.count("tok_b") != 0 {
		t.Fatalf("status=%d b=%d body=%s", response.StatusCode, upstream.count("tok_b"), body)
	}
	// 账号已冷却，后续续接在发送前即返回同一错误
	n = nonceSeq.Add(1)
	again := signedExecute(t, cfg, httpServer.URL, Envelope{Dispatch: fmt.Sprintf("d_%d", n), RequestID: fmt.Sprintf("r_%d", n), Nonce: fmt.Sprintf("n_%d", n), Operation: "responses", Protocol: "openai.responses", Model: "gpt-test", Body: json.RawMessage(`{"model":"gpt-test","previous_response_id":"resp_2"}`), Scope: Scope{GroupIDs: []int64{1}, RuntimeAccountID: "a"}})
	again.Body.Close()
	if again.StatusCode != 400 || again.Header.Get(sendStateHeader) != "not_sent" || upstream.count("tok_a") != 1 {
		t.Fatalf("second status=%d send=%s a=%d", again.StatusCode, again.Header.Get(sendStateHeader), upstream.count("tok_a"))
	}
}

// 只指定账号（账号测试）而非续接：额度耗尽交付 usage_limit_reached，不改写为 previous_response_not_found，也不换号
func TestPinnedAccountWithoutContinuationReportsUsageLimit(t *testing.T) {
	upstream, server := newScriptedUpstream(t, map[string][]func(http.ResponseWriter){
		"tok_a": {jsonReply(429, `{"error":{"type":"usage_limit_reached"}}`)},
		"tok_b": {jsonReply(200, okResponse)},
	})
	_, httpServer, cfg := newExecuteServer(t, server.URL, account("a", "tok_a"), account("b", "tok_b"))
	for i, wantSend := range []string{"sent", "not_sent"} {
		n := nonceSeq.Add(1)
		response := signedExecute(t, cfg, httpServer.URL, Envelope{Dispatch: fmt.Sprintf("d_%d", n), RequestID: fmt.Sprintf("r_%d", n), Nonce: fmt.Sprintf("n_%d", n), Operation: "responses", Protocol: "openai.responses", Model: "gpt-test", Body: json.RawMessage(`{"model":"gpt-test"}`), Scope: Scope{RuntimeAccountID: "a"}})
		body, _ := io.ReadAll(response.Body)
		response.Body.Close()
		if response.StatusCode != 429 || strings.Contains(string(body), "previous_response_not_found") || response.Header.Get(sendStateHeader) != wantSend || upstream.count("tok_a") != 1 || upstream.count("tok_b") != 0 {
			t.Fatalf("attempt %d status=%d send=%s a=%d b=%d body=%s", i, response.StatusCode, response.Header.Get(sendStateHeader), upstream.count("tok_a"), upstream.count("tok_b"), body)
		}
	}
}

// 控制面按递归排序键的紧凑 JSON 校验 payload_hash；含结构体字段（attempts）的 Receipt 也必须一致
func TestReceiptHashUsesRecursivelySortedKeys(t *testing.T) {
	_, server := newScriptedUpstream(t, map[string][]func(http.ResponseWriter){
		"tok_a": {jsonReply(429, `{"error":{"type":"usage_limit_reached"}}`)},
		"tok_b": {jsonReply(200, okResponse)},
	})
	_, httpServer, cfg := newExecuteServer(t, server.URL, account("a", "tok_a"), account("b", "tok_b"))
	response, _ := run(t, cfg, httpServer.URL, false)
	if response.StatusCode != 200 {
		t.Fatalf("status=%d", response.StatusCode)
	}
	receipt := readReceipt(t, cfg)
	claimed, _ := receipt["payload_hash"].(string)
	delete(receipt, "payload_hash")
	if got := BodyHash([]byte(sortedJSON(receipt))); got != claimed {
		t.Fatalf("payload hash %s does not match the sorted-key hash %s", claimed, got)
	}
}

func sortedJSON(value any) string {
	switch v := value.(type) {
	case map[string]any:
		keys := make([]string, 0, len(v))
		for key := range v {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		parts := make([]string, 0, len(keys))
		for _, key := range keys {
			name, _ := json.Marshal(key)
			parts = append(parts, string(name)+":"+sortedJSON(v[key]))
		}
		return "{" + strings.Join(parts, ",") + "}"
	case []any:
		parts := make([]string, 0, len(v))
		for _, item := range v {
			parts = append(parts, sortedJSON(item))
		}
		return "[" + strings.Join(parts, ",") + "]"
	default:
		data, _ := marshalJSON(v)
		return string(data)
	}
}

// Retry-After 上限（CPR 0ff1a729）：配置缺省 240 秒，显式 0 不接受正数等待，超过上限不截短而是放弃同号等待。
func TestRetryAfterLimitDefaultsAndExplicitZero(t *testing.T) {
	dir := t.TempDir()
	write := func(name, body string) string {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		return path
	}
	base := `"listen":"127.0.0.1:0","data_dir":"` + dir + `","instance_id":"gw","internal_token":"0123456789abcdef0123456789abcdef","receipt_token":"0123456789abcdef0123456789abcdef"`
	missing, err := LoadConfig(write("missing.json", `{`+base+`}`))
	if err != nil {
		t.Fatal(err)
	}
	zero, err := LoadConfig(write("zero.json", `{`+base+`,"max_retry_after_seconds":0}`))
	if err != nil {
		t.Fatal(err)
	}
	if got := (&Server{cfg: missing}).maxRetryAfter(); got != 240*time.Second {
		t.Fatalf("default limit=%v", got)
	}
	if got := (&Server{cfg: zero}).maxRetryAfter(); got != 0 {
		t.Fatalf("explicit zero limit=%v", got)
	}
	if got := (&Server{cfg: Config{MaxRetryAfterSec: -1}}).maxRetryAfter(); got != defaultMaxRetryAfter {
		t.Fatalf("negative limit=%v", got)
	}
	overloaded := upstreamFailure{Category: categoryCapacity, HasRetryAfter: true, RetryAfter: time.Second}
	if _, ok := overloaded.sameAccountRetryDelay(0, 0); ok {
		t.Fatal("explicit zero limit must refuse a positive wait")
	}
	if delay, ok := (upstreamFailure{Category: categoryCapacity, HasRetryAfter: true}).sameAccountRetryDelay(0, 0); !ok || delay != 0 {
		t.Fatalf("zero Retry-After under zero limit: delay=%v ok=%v", delay, ok)
	}
	if delay, ok := overloaded.sameAccountRetryDelay(0, 240*time.Second); !ok || delay != time.Second {
		t.Fatalf("within limit: delay=%v ok=%v", delay, ok)
	}
}
