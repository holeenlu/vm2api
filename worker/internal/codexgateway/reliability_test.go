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

// 容量拒绝先同号退避（CPR：3 次）再换号；同号重试中恢复则不换号。
func TestCapacityRetriesSameAccountThenRotates(t *testing.T) {
	overloaded := jsonReply(503, `{"error":{"type":"server_error","code":"server_is_overloaded"}}`, "Retry-After", "0")
	first := account("a", "tok_a")
	first.Weight = 2
	upstream, server := newScriptedUpstream(t, map[string][]func(http.ResponseWriter){
		"tok_a": {overloaded},
		"tok_b": {jsonReply(200, okResponse)},
	})
	_, httpServer, cfg := newExecuteServer(t, server.URL, first, account("b", "tok_b"))
	response, _ := run(t, cfg, httpServer.URL, false)
	if response.StatusCode != 200 || upstream.count("tok_a") != 1+capacityRetryLimit || upstream.count("tok_b") != 1 {
		t.Fatalf("status=%d calls a=%d b=%d", response.StatusCode, upstream.count("tok_a"), upstream.count("tok_b"))
	}
	recovering, server2 := newScriptedUpstream(t, map[string][]func(http.ResponseWriter){
		"tok_a": {overloaded, jsonReply(200, okResponse)},
		"tok_b": {jsonReply(200, okResponse)},
	})
	_, httpServer2, cfg2 := newExecuteServer(t, server2.URL, first, account("b", "tok_b"))
	response, _ = run(t, cfg2, httpServer2.URL, false)
	if response.StatusCode != 200 || recovering.count("tok_a") != 2 || recovering.count("tok_b") != 0 {
		t.Fatalf("a same-account recovery must not rotate: status=%d a=%d b=%d", response.StatusCode, recovering.count("tok_a"), recovering.count("tok_b"))
	}
	// 退避：500ms 起翻倍、上限 8s、不加抖动；超过 Retry-After 上限时不同号等待
	capacity := upstreamFailure{Category: categoryCapacity, Status: 503, Code: "server_is_overloaded"}
	for attempt, want := range []time.Duration{500 * time.Millisecond, time.Second, 2 * time.Second} {
		if delay, ok := capacity.sameAccountRetryDelay(attempt, 240*time.Second); !ok || delay != want {
			t.Fatalf("attempt %d delay=%v ok=%v", attempt, delay, ok)
		}
	}
	if _, ok := capacity.sameAccountRetryDelay(capacityRetryLimit, 240*time.Second); ok {
		t.Fatal("retries beyond the limit must rotate")
	}
	capacity.HasRetryAfter, capacity.RetryAfter = true, 300*time.Second
	if _, ok := capacity.sameAccountRetryDelay(0, 240*time.Second); ok {
		t.Fatal("a Retry-After above the limit skips the same-account wait")
	}
}

func TestCapacityExhaustionRotatesAndProjectsServerError(t *testing.T) {
	overloaded := jsonReply(503, `{"error":{"type":"server_error","code":"server_is_overloaded"}}`, "Retry-After", "0")
	upstream, server := newScriptedUpstream(t, map[string][]func(http.ResponseWriter){
		"tok_a": {overloaded},
	})
	_, httpServer, cfg := newExecuteServer(t, server.URL, account("a", "tok_a"))
	response, body := run(t, cfg, httpServer.URL, false)
	// 同号退避用完后单账号无可换，交付投影后的 503 server_error
	if upstream.count("tok_a") != 1+capacityRetryLimit || response.StatusCode != 503 || strings.Contains(string(body), "server_is_overloaded") {
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

// 401 不在请求内刷新重放（CPR OpenAI 无请求内凭据恢复）：AT 未过期却被拒判过期终态，请求换号；
// 终态账号不再被自动刷新，也不再参与选号。
func TestCredentialExpiredRotatesWithoutInRequestRefresh(t *testing.T) {
	var refreshes atomic.Int32
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		refreshes.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"access_token":"tok_new","refresh_token":"rt_a2","expires_in":3600}`)
	}))
	defer tokenServer.Close()
	upstream, server := newScriptedUpstream(t, map[string][]func(http.ResponseWriter){
		"tok_old": {jsonReply(401, `{"error":{"code":"token_expired"}}`)},
		"tok_b":   {jsonReply(200, okResponse)},
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
	acct.Weight = 10
	if _, err := gw.store.Upsert(acct); err != nil {
		t.Fatal(err)
	}
	if _, err := gw.store.Upsert(account("b", "tok_b")); err != nil {
		t.Fatal(err)
	}
	httpServer := httptest.NewServer(gw.Handler())
	defer httpServer.Close()
	response, _ := run(t, cfg, httpServer.URL, false)
	if response.StatusCode != 200 || upstream.count("tok_old") != 1 || upstream.count("tok_b") != 1 || refreshes.Load() != 0 {
		t.Fatalf("status=%d old=%d b=%d refreshes=%d", response.StatusCode, upstream.count("tok_old"), upstream.count("tok_b"), refreshes.Load())
	}
	saved, _ := gw.store.Get("a")
	if saved.CredentialState != "expired" || saved.AccessToken != "tok_old" || credentialUsable(saved, time.Now()) || refreshDue(saved, time.Now().Add(55*time.Minute)) {
		t.Fatalf("a rejected unexpired token must be terminal: %+v", publicAccount(saved))
	}
}

// AT 已过期且仍在 2 小时恢复窗口内：401 不判终态，账号暂不可选，由定时刷新恢复；窗口过后刷新失败判过期终态，
// 下次重试不晚于窗口截止。
func TestCredentialRecoveryWindow(t *testing.T) {
	now := time.Now()
	store, _ := OpenStore(t.TempDir() + "/accounts.json")
	acct := account("a", "tok")
	acct.RefreshToken = "rt"
	acct.ExpiresAt = now.Add(-30 * time.Minute)
	_, _ = store.Upsert(acct)
	store.Dispose("a", "", upstreamFailure{Category: categoryCredentialExpired, Status: 401}, now)
	saved, _ := store.Get("a")
	if saved.CredentialState != "" || credentialUsable(saved, now) || !refreshDue(saved, now) {
		t.Fatalf("an expired AT inside the window must wait for refresh: %+v", publicAccount(saved))
	}
	if refreshDue(saved, now.Add(2*time.Hour)) {
		t.Fatal("past the recovery window the account is no longer a refresh candidate")
	}
	r := newRefresher()
	r.recordFailure("a", saved.ExpiresAt, now)
	r.recordFailure("a", saved.ExpiresAt, now)
	for i := 0; i < 6; i++ {
		r.recordFailure("a", saved.ExpiresAt, now)
	}
	if deadline := saved.ExpiresAt.Add(refreshRecoveryWindow); r.failures["a"].nextAt.After(deadline) {
		t.Fatalf("retry %v is later than the recovery deadline %v", r.failures["a"].nextAt, deadline)
	}
	refreshFailing := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer refreshFailing.Close()
	cfg := Config{DataDir: t.TempDir(), InternalToken: "secret", OAuthTokenURL: refreshFailing.URL, RequestTimeoutSec: 5}
	cfg.applyDefaults()
	gw, err := NewServer(cfg)
	if err != nil {
		t.Fatal(err)
	}
	late := account("late", "tok")
	late.RefreshToken = "rt"
	late.ExpiresAt = now.Add(-3 * time.Hour)
	_, _ = gw.store.Upsert(late)
	if _, err := gw.refreshAccount("late"); err == nil {
		t.Fatal("refresh should fail")
	}
	if saved, _ := gw.store.Get("late"); saved.CredentialState != "expired" {
		t.Fatalf("a failed refresh past the window must be terminal: %+v", publicAccount(saved))
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
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		refreshed.Store(body["refresh_token"], true)
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
	serverError := func(retryAfter time.Duration) upstreamFailure {
		return upstreamFailure{Category: categoryUnavailable, Status: http.StatusServiceUnavailable, Code: "server_error", HasRetryAfter: true, RetryAfter: retryAfter}
	}
	overloaded := serverError(time.Second)
	if _, ok := overloaded.sameAccountRetryDelay(0, 0); ok {
		t.Fatal("explicit zero limit must refuse a positive wait")
	}
	if delay, ok := serverError(0).sameAccountRetryDelay(0, 0); !ok || delay != 0 {
		t.Fatalf("zero Retry-After under zero limit: delay=%v ok=%v", delay, ok)
	}
	if delay, ok := overloaded.sameAccountRetryDelay(0, 240*time.Second); !ok || delay != time.Second {
		t.Fatalf("within limit: delay=%v ok=%v", delay, ok)
	}
}

// 全池过载：每个账号用完同号退避后才换号，换号超过 1 次后检测到近期活跃账号普遍失败，停止换号并提示 3 秒后重试。
func TestPoolOverloadStopsRotationWithRetryAfter(t *testing.T) {
	overloaded := jsonReply(503, `{"error":{"type":"server_error","code":"server_is_overloaded","message":"Our servers are currently overloaded."}}`, "Retry-After", "0")
	upstream, server := newScriptedUpstream(t, map[string][]func(http.ResponseWriter){
		"tok_a": {overloaded}, "tok_b": {overloaded}, "tok_c": {overloaded}, "tok_d": {jsonReply(200, okResponse)},
	})
	gw, httpServer, cfg := newExecuteServer(t, server.URL, account("a", "tok_a"), account("b", "tok_b"), account("c", "tok_c"), account("d", "tok_d"))
	// 近期反馈显示全池都在过载（中位数 ≥30%），但没有离群账号
	for _, id := range []string{"a", "b", "c", "d"} {
		gw.store.RecordFeedback(id, feedbackCapacityRejected, 0)
	}
	response, body := run(t, cfg, httpServer.URL, false)
	total := upstream.count("tok_a") + upstream.count("tok_b") + upstream.count("tok_c") + upstream.count("tok_d")
	if response.StatusCode != 503 || response.Header.Get("Retry-After") != "3" || total != 2*(1+capacityRetryLimit) {
		t.Fatalf("status=%d retry-after=%q attempts=%d body=%s", response.StatusCode, response.Header.Get("Retry-After"), total, body)
	}
	// 过载原因保留给客户端（code 投影为 server_error，提示文字不丢）
	if !strings.Contains(string(body), "overloaded") {
		t.Fatalf("overload message lost: %s", body)
	}
}

// 未整体过载时照常换号直到成功。
func TestCapacityKeepsRotatingWhenPoolIsHealthy(t *testing.T) {
	overloaded := jsonReply(503, `{"error":{"type":"server_error","code":"server_is_overloaded"}}`, "Retry-After", "0")
	upstream, server := newScriptedUpstream(t, map[string][]func(http.ResponseWriter){
		"tok_a": {overloaded}, "tok_b": {overloaded}, "tok_c": {jsonReply(200, okResponse)},
	})
	gw, httpServer, cfg := newExecuteServer(t, server.URL, account("a", "tok_a"), account("b", "tok_b"), account("c", "tok_c"))
	for _, id := range []string{"a", "b", "c"} {
		gw.store.RecordFeedback(id, feedbackSucceeded, 0)
	}
	response, _ := run(t, cfg, httpServer.URL, false)
	if response.StatusCode != 200 || upstream.count("tok_c") != 1 {
		t.Fatalf("status=%d calls a=%d b=%d c=%d", response.StatusCode, upstream.count("tok_a"), upstream.count("tok_b"), upstream.count("tok_c"))
	}
}

// 离群账号：失败率远高于其余账号时停放 60 秒；全池一起失败时不停放。
func TestOverloadOutlierParksOnlyTheOutlier(t *testing.T) {
	gw, _, _ := newExecuteServer(t, "http://127.0.0.1:1", account("a", "tok_a"), account("b", "tok_b"), account("c", "tok_c"), account("d", "tok_d"))
	now := time.Now()
	for i := 0; i < 6; i++ {
		gw.store.RecordFeedback("a", feedbackCapacityRejected, 0)
	}
	for _, id := range []string{"b", "c", "d"} {
		gw.store.RecordFeedback(id, feedbackSucceeded, 0)
	}
	if !gw.store.parkOverloadOutlier("a", now) {
		t.Fatal("outlier not parked")
	}
	a, _ := gw.store.Get("a")
	if a.CooldownReason != "overload_outlier" || a.CooldownUntil.Sub(now) != overloadOutlierHold {
		t.Fatalf("cooldown=%s until=%v", a.CooldownReason, a.CooldownUntil.Sub(now))
	}
	for i := 0; i < 6; i++ {
		for _, id := range []string{"b", "c", "d"} {
			gw.store.RecordFeedback(id, feedbackCapacityRejected, 0)
		}
	}
	if gw.store.parkOverloadOutlier("b", now) {
		t.Fatal("pool-wide overload must not park accounts")
	}
}

// 提交前重试总时长：超过上限后不再同号退避，直接交付失败。
func TestPreCommitRetryBudgetStopsSameAccountRetries(t *testing.T) {
	run := &dispatchRun{startedAt: time.Now().Add(-preCommitRetryBudget + time.Second)}
	if !run.retryBudgetSpent(2 * time.Second) {
		t.Fatal("budget must account for the pending wait")
	}
	if run.retryBudgetSpent(0) {
		t.Fatal("budget spent too early")
	}
}

// 流内 response.failed 交付体规整为标准错误对象，保留上游提示。
func TestSSEFailureBodyKeepsUpstreamError(t *testing.T) {
	failure := classifySSEFailure(map[string]any{"type": "response.failed", "response": map[string]any{"error": map[string]any{"code": "server_is_overloaded", "message": "Our servers are currently overloaded."}}})
	status, body := failure.clientProjection()
	if status != 503 || !strings.Contains(string(body), `"code":"server_error"`) || !strings.Contains(string(body), "currently overloaded") || strings.Contains(string(body), "response.failed") {
		t.Fatalf("status=%d body=%s", status, body)
	}
}

// 控制面排除的未同步账号不参与选号，其余账号照常接单。
func TestScopeExcludeAccountsSkipsUnsyncedAccounts(t *testing.T) {
	upstream, server := newScriptedUpstream(t, map[string][]func(http.ResponseWriter){
		"tok_a": {jsonReply(200, okResponse)},
		"tok_b": {jsonReply(200, okResponse)},
	})
	_, httpServer, cfg := newExecuteServer(t, server.URL, account("a", "tok_a"), account("b", "tok_b"))
	for i := 0; i < 3; i++ {
		response := signedExecute(t, cfg, httpServer.URL, Envelope{Dispatch: fmt.Sprintf("d_ex_%d", i), RequestID: fmt.Sprintf("r_ex_%d", i), Nonce: fmt.Sprintf("n_ex_%d", i), Operation: "responses", Protocol: "openai.responses", Model: "gpt-test", Body: json.RawMessage(`{"model":"gpt-test"}`), Scope: Scope{GroupIDs: []int64{1}, ExcludeAccounts: []string{"a"}}})
		_, _ = io.ReadAll(response.Body)
		response.Body.Close()
		if response.StatusCode != 200 {
			t.Fatalf("status=%d", response.StatusCode)
		}
	}
	if upstream.count("tok_a") != 0 || upstream.count("tok_b") != 3 {
		t.Fatalf("calls a=%d b=%d", upstream.count("tok_a"), upstream.count("tok_b"))
	}
}

// 并发修改与落盘不会写坏账号库，重新打开后与内存中的最新状态一致。
func TestConcurrentPersistKeepsStoreReadableAndLatest(t *testing.T) {
	withRuntimeFlushDelay(t, 10*time.Millisecond)
	gw, _, _ := newExecuteServer(t, "http://127.0.0.1:1", account("a", "tok_a"), account("b", "tok_b"), account("c", "tok_c"))
	var wg sync.WaitGroup
	for i := 0; i < 40; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			id := []string{"a", "b", "c"}[i%3]
			gw.store.UpdateQuota(id, map[string]any{"primary_window": map[string]any{"used_percent": float64(i), "window_minutes": 300.0}})
			gw.store.Dispose(id, "gpt-test", upstreamFailure{Category: categoryRateLimited}, time.Now())
		}(i)
	}
	wg.Wait()
	// 运行时状态合并延迟落盘；退出前与此处一样由 Flush 写出最新状态
	if err := gw.store.Flush(); err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenStore(gw.store.path)
	if err != nil {
		t.Fatalf("store unreadable after concurrent persists: %v", err)
	}
	for _, id := range []string{"a", "b", "c"} {
		want, _ := gw.store.Get(id)
		got, ok := reopened.Get(id)
		if !ok || got.RuntimeRevision != want.RuntimeRevision {
			t.Fatalf("%s revision on disk=%d memory=%d", id, got.RuntimeRevision, want.RuntimeRevision)
		}
	}
}

// 生产复现（2026-11-04）：上游在 response.failed（server_is_overloaded）之前先发出不含内容的结构事件
// （空推理输出项、rate_limits 等）。这些事件不是提交点，失败必须仍可重试，不能以 200 交付失败流。
func TestStreamOverloadAfterStructuralEventsIsRetried(t *testing.T) {
	overloaded := sseReply(
		`{"type":"response.created","response":{"id":"r1"}}`,
		`{"type":"response.in_progress","response":{"id":"r1"}}`,
		`{"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"rs_1","summary":[]}}`,
		`{"type":"response.failed","response":{"id":"r1","error":{"type":"server_error","code":"server_is_overloaded","message":"busy"}}}`,
	)
	upstream, server := newScriptedUpstream(t, map[string][]func(http.ResponseWriter){
		"tok_a": {overloaded},
		"tok_b": {sseReply(`{"type":"response.created","response":{"id":"r2"}}`, `{"type":"response.output_text.delta","delta":"hi"}`, `{"type":"response.completed","response":{"id":"r2","usage":{"input_tokens":2,"output_tokens":1}}}`)},
	})
	// a 权重更高、先被选中，确保走到流内过载后的重试路径
	first := account("a", "tok_a")
	first.Weight = 2
	_, httpServer, cfg := newExecuteServer(t, server.URL, first, account("b", "tok_b"))
	response, body := run(t, cfg, httpServer.URL, true)
	if response.StatusCode != 200 || strings.Contains(string(body), "response.failed") || strings.Contains(string(body), `"r1"`) || !strings.Contains(string(body), "response.completed") {
		t.Fatalf("status=%d body=%s", response.StatusCode, body)
	}
	// 流内过载同样先同号退避，用完后换号
	if upstream.count("tok_a") != 1+capacityRetryLimit || upstream.count("tok_b") != 1 {
		t.Fatalf("overload was not retried on another account: a=%d b=%d", upstream.count("tok_a"), upstream.count("tok_b"))
	}
}

func TestGeneratedContentEventMatchesFirstTokenRule(t *testing.T) {
	cases := []struct {
		event string
		want  bool
	}{
		{`{"type":"response.output_text.delta","delta":"h"}`, true},
		{`{"type":"response.reasoning_summary_text.delta","delta":""}`, false},
		{`{"type":"response.output_item.added","item":{"type":"reasoning","summary":[]}}`, false},
		{`{"type":"response.output_item.added","item":{"type":"function_call","name":"shell"}}`, true},
		{`{"type":"response.output_item.done","item":{"type":"message","content":[{"type":"output_text","text":"ok"}]}}`, true},
		{`{"type":"response.content_part.added","part":{"type":"output_text","text":""}}`, false},
		{`{"type":"codex.rate_limits"}`, false},
	}
	for _, tc := range cases {
		var event map[string]any
		if err := json.Unmarshal([]byte(tc.event), &event); err != nil {
			t.Fatal(err)
		}
		if got := generatedContentEvent(event); got != tc.want {
			t.Fatalf("%s: got %v want %v", tc.event, got, tc.want)
		}
	}
}

// cyber_policy：可安全重放并换号，同一会话后续请求排除被拒账号；全部被排除时返回 400 cyber_policy（未发送）。
func TestCyberPolicyRotatesAndExcludesWithinSession(t *testing.T) {
	upstream, server := newScriptedUpstream(t, map[string][]func(http.ResponseWriter){
		"tok_a": {jsonReply(400, `{"error":{"type":"invalid_request_error","code":"cyber_policy","message":"blocked"}}`)},
		"tok_b": {jsonReply(200, okResponse), jsonReply(200, okResponse)},
	})
	a := account("a", "tok_a")
	a.Weight = 10
	gw, httpServer, cfg := newExecuteServer(t, server.URL, a, account("b", "tok_b"))
	send := func(n int) *http.Response {
		response := signedExecute(t, cfg, httpServer.URL, Envelope{Dispatch: fmt.Sprintf("d_cy_%d", n), RequestID: fmt.Sprintf("r_cy_%d", n), Nonce: fmt.Sprintf("n_cy_%d", n), Operation: "responses", Protocol: "openai.responses", Model: "gpt-test", ClientScope: "key_1", Body: json.RawMessage(`{"model":"gpt-test","input":"hi"}`), Scope: Scope{GroupIDs: []int64{1}, SessionID: "sess_cy"}})
		_, _ = io.ReadAll(response.Body)
		response.Body.Close()
		return response
	}
	if response := send(1); response.StatusCode != 200 || upstream.count("tok_a") != 1 || upstream.count("tok_b") != 1 {
		t.Fatalf("cyber_policy should rotate: status=%d a=%d b=%d", response.StatusCode, upstream.count("tok_a"), upstream.count("tok_b"))
	}
	// b 的成功响应已清除本会话的排除；重新记录 a 的排除，验证下一次选号跳过 a
	gw.cyberPolicy.record((&dispatchRun{envelope: Envelope{ClientScope: "key_1", Body: json.RawMessage(`{}`), Scope: Scope{SessionID: "sess_cy"}}}).cyberPolicyKey(), "a", time.Now())
	if response := send(2); response.StatusCode != 200 || upstream.count("tok_a") != 1 {
		t.Fatalf("the excluded account was used again: status=%d a=%d", response.StatusCode, upstream.count("tok_a"))
	}
	key := (&dispatchRun{envelope: Envelope{ClientScope: "key_1", Body: json.RawMessage(`{}`), Scope: Scope{SessionID: "sess_cy"}}}).cyberPolicyKey()
	gw.cyberPolicy.record(key, "a", time.Now())
	gw.cyberPolicy.record(key, "b", time.Now())
	response := send(3)
	if response.StatusCode != 400 || response.Header.Get(sendStateHeader) != sendStateNotSent {
		t.Fatalf("all excluded should be a not-sent 400: status=%d state=%s", response.StatusCode, response.Header.Get(sendStateHeader))
	}
	// 续接请求不参与会话排除
	if (&dispatchRun{envelope: Envelope{Body: json.RawMessage(`{"previous_response_id":"resp_1"}`), Scope: Scope{SessionID: "s"}}}).cyberPolicyKey() != "" {
		t.Fatal("continuations must not use cyber policy session exclusions")
	}
}

// 同一调用方的同一客户端轮次 300 秒内已因 503 server_error 失败交付：重试时跳过同号退避直接交付；成功后清除。
func TestClientRetrySuppressionSkipsSameAccountBackoff(t *testing.T) {
	upstream, server := newScriptedUpstream(t, map[string][]func(http.ResponseWriter){
		"tok_a": {jsonReply(503, `{"error":{"code":"server_error"}}`), jsonReply(200, okResponse)},
	})
	gw, httpServer, cfg := newExecuteServer(t, server.URL, account("a", "tok_a"))
	envelope := func(n int) Envelope {
		return Envelope{Dispatch: fmt.Sprintf("d_cr_%d", n), RequestID: fmt.Sprintf("r_cr_%d", n), Nonce: fmt.Sprintf("n_cr_%d", n), Operation: "responses", Protocol: "openai.responses", Model: "gpt-test", ClientScope: "key_1", Headers: map[string]string{"x-codex-turn-metadata": `{"thread_id":"th_1","turn_id":"turn_1"}`}, Body: json.RawMessage(`{"model":"gpt-test","input":"hi"}`), Scope: Scope{GroupIDs: []int64{1}}}
	}
	key := (&dispatchRun{envelope: envelope(0)}).clientTurnKey()
	if key == "" {
		t.Fatal("thread and turn from turn metadata must form a key")
	}
	// 失败交付 503 server_error 时写入标记
	run := &dispatchRun{server: gw, envelope: envelope(0), clientTurn: key, attempts: []attemptRecord{{Account: "a"}}, lastFail: &upstreamFailure{Category: categoryUnavailable, Status: 503, Code: "server_error"}}
	run.deliverFailure(httptest.NewRecorder())
	if !gw.clientRetry.has(key, time.Now()) {
		t.Fatal("a delivered 503 server_error must mark the client turn")
	}
	response := signedExecute(t, cfg, httpServer.URL, envelope(1))
	_, _ = io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != 503 || upstream.count("tok_a") != 1 {
		t.Fatalf("the retried turn must skip same-account backoff: status=%d calls=%d", response.StatusCode, upstream.count("tok_a"))
	}
	gw.clientRetry.clear(key)
	response = signedExecute(t, cfg, httpServer.URL, envelope(2))
	_, _ = io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != 200 || gw.clientRetry.has(key, time.Now()) {
		t.Fatalf("status=%d marked=%v", response.StatusCode, gw.clientRetry.has(key, time.Now()))
	}
}

// 刷新请求对齐 CPR：JSON 正文不带 scope，画像 originator/UA；缺少的令牌字段保留原值，id_token 无效判失败；
// 开启恢复日志时令牌在落库前写入独立的 0600 文件。
func TestRefreshWireFormatAndRecoveryLog(t *testing.T) {
	var got map[string]string
	var header http.Header
	reply := `{"access_token":"tok_new","expires_in":3600}`
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		header = r.Header.Clone()
		_ = json.NewDecoder(r.Body).Decode(&got)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, reply)
	}))
	defer tokenServer.Close()
	cfg := Config{DataDir: t.TempDir(), InternalToken: "secret", OAuthTokenURL: tokenServer.URL, OAuthRecoveryLog: true}
	cfg.applyDefaults()
	gw, _ := NewServer(cfg)
	acct := account("a", "tok_old")
	acct.RefreshToken = "rt_keep"
	_, _ = gw.store.Upsert(acct)
	saved, err := gw.refreshAccount("a")
	if err != nil {
		t.Fatal(err)
	}
	if got["grant_type"] != "refresh_token" || got["refresh_token"] != "rt_keep" || got["client_id"] == "" || len(got) != 3 {
		t.Fatalf("refresh body=%v", got)
	}
	if header.Get("Content-Type") != "application/json" || header.Get("originator") == "" || header.Get("version") != "" {
		t.Fatalf("refresh headers=%v", header)
	}
	if saved.AccessToken != "tok_new" || saved.RefreshToken != "rt_keep" {
		t.Fatalf("missing refresh_token must keep the current value: %+v", publicAccount(saved))
	}
	entries, _ := os.ReadDir(filepath.Join(cfg.DataDir, oauthRecoveryDirName))
	if len(entries) != 1 {
		t.Fatalf("recovery log files=%d", len(entries))
	}
	info, _ := entries[0].Info()
	data, _ := os.ReadFile(filepath.Join(cfg.DataDir, oauthRecoveryDirName, entries[0].Name()))
	if info.Mode().Perm() != 0o600 || !strings.Contains(string(data), `"access_token":"tok_new"`) || !strings.Contains(string(data), `"operation":"refresh"`) {
		t.Fatalf("recovery log mode=%v data=%s", info.Mode().Perm(), data)
	}
	reply = `{"access_token":"tok_newer","id_token":"not-a-jwt"}`
	if _, err := gw.refreshAccount("a"); err == nil || !strings.Contains(err.Error(), "id_token") {
		t.Fatalf("an invalid id_token must fail the refresh: %v", err)
	}
}

// 回执 usage 去掉上游 attribution（随会话变长、无读取方），补发送档位，且不改动调用方的 usage
func TestReceiptUsageDropsAttributionAndAddsTier(t *testing.T) {
	upstream := map[string]any{
		"input_tokens": float64(1200), "output_tokens": float64(34),
		"attribution": map[string]any{"items": map[string]any{"msg_1": map[string]any{"input_tokens": float64(1)}}},
	}
	got, ok := receiptUsage(upstream, "priority").(map[string]any)
	if !ok || got["input_tokens"] != float64(1200) || got["output_tokens"] != float64(34) || got["service_tier"] != "priority" {
		t.Fatalf("receipt usage = %#v", got)
	}
	if _, present := got["attribution"]; present {
		t.Fatal("receipt usage must not carry attribution")
	}
	if _, present := upstream["attribution"]; !present {
		t.Fatal("caller usage must not be mutated")
	}
	plain := map[string]any{"input_tokens": float64(1), "service_tier": "default"}
	if out := receiptUsage(plain, "priority").(map[string]any); out["service_tier"] != "default" {
		t.Fatalf("upstream tier must win: %#v", out)
	}
	if out := receiptUsage(nil, "priority"); out != nil {
		t.Fatalf("nil usage stays nil: %#v", out)
	}
}
