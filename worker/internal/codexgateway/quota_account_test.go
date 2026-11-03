package codexgateway

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestQuotaHeadersParseCreditsAndAreNotForwarded(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("x-codex-primary-used-percent", "40")
		w.Header().Set("x-codex-primary-window-minutes", "10080")
		w.Header().Set("x-codex-secondary-used-percent", "10")
		w.Header().Set("x-codex-secondary-window-minutes", "300")
		w.Header().Set("x-codex-credits-has-credits", "true")
		w.Header().Set("x-codex-credits-unlimited", "false")
		w.Header().Set("x-codex-credits-balance", "12.5")
		w.Header().Set("x-codex-plan-type", "plus")
		w.Header().Set("x-codex-active-limit", "codex")
		w.Header().Set("x-ratelimit-remaining-requests", "99")
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, okResponse)
	}))
	defer upstream.Close()
	gw, httpServer, cfg := newExecuteServer(t, upstream.URL, account("a", "tok"))
	response, _ := run(t, cfg, httpServer.URL, false)
	for key := range response.Header {
		if isCodexQuotaHeader(key) {
			t.Fatalf("quota header %s leaked to the caller", key)
		}
	}
	if response.Header.Get("X-Ratelimit-Remaining-Requests") != "99" {
		t.Fatal("generic rate-limit headers must still be forwarded")
	}
	saved, _ := gw.store.Get("a")
	credits, _ := saved.Quota["credits"].(map[string]any)
	if credits["has_credits"] != true || credits["balance"] != "12.5" || saved.Quota["plan_type"] != "plus" {
		t.Fatalf("quota=%v", saved.Quota)
	}
}

func TestRateLimitsEventMergesIntoQuota(t *testing.T) {
	limits := parseRateLimitsEvent(map[string]any{"type": "codex.rate_limits", "rate_limits": map[string]any{
		"primary":   map[string]any{"used_percent": float64(100), "window_minutes": float64(10080), "resets_at": float64(time.Now().Add(time.Hour).Unix())},
		"secondary": map[string]any{"used_percent": float64(5), "window_minutes": float64(300)},
		"credits":   map[string]any{"has_credits": false, "unlimited": false},
	}}, time.Now())
	if limits["confidence"] != "complete" || limits["credits"] == nil {
		t.Fatalf("limits=%v", limits)
	}
	store, _ := OpenStore(t.TempDir() + "/accounts.json")
	_, _ = store.Upsert(account("a", "tok"))
	store.MergeQuota("a", limits)
	saved, _ := store.Get("a")
	if !saved.CooldownUntil.After(time.Now()) || saved.CooldownReason != string(categoryUsageLimit) {
		t.Fatalf("exhausted window must cool the account: %+v", publicAccount(saved))
	}
}

type whamServer struct {
	mu        sync.Mutex
	consumed  []string
	auth      []string
	failFirst bool
}

func newWham(t *testing.T, state *whamServer) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/backend-api/wham/usage", func(w http.ResponseWriter, r *http.Request) {
		state.mu.Lock()
		state.auth = append(state.auth, r.Header.Get("Authorization")+"|"+r.Header.Get("chatgpt-account-id")+"|"+r.Header.Get("originator"))
		state.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"plan_type":"pro","email":"u@example.com","credits":{"has_credits":true,"unlimited":false,"balance":"3"},"rate_limit":{"primary_window":{"used_percent":20,"limit_window_seconds":604800,"reset_after_seconds":3600},"secondary_window":{"used_percent":100,"limit_window_seconds":18000,"reset_after_seconds":600}}}`)
	})
	mux.HandleFunc("/backend-api/wham/rate-limit-reset-credits", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"available_count":1,"credits":[{"id":"credit_1","expires_at":"2027-01-01T00:00:00Z","status":"available","reset_type":"codex_rate_limits"}]}`)
	})
	mux.HandleFunc("/backend-api/wham/rate-limit-reset-credits/consume", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		state.mu.Lock()
		state.consumed = append(state.consumed, body["redeem_request_id"]+"|"+body["credit_id"])
		fail := state.failFirst
		state.failFirst = false
		state.mu.Unlock()
		if fail {
			// 模拟发送后连接中断，结果不明
			hijacker, _ := w.(http.Hijacker)
			conn, _, _ := hijacker.Hijack()
			_ = conn.Close()
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"code":"ok","windows_reset":2}`)
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return server
}

func accountActionRequest(t *testing.T, cfg Config, baseURL, path string, payload any) (*http.Response, map[string]any) {
	t.Helper()
	body, _ := json.Marshal(payload)
	timestamp := time.Now().UTC().Format(time.RFC3339Nano)
	nonce := "acct-" + path + "-" + timestamp
	req, _ := http.NewRequest(http.MethodPost, baseURL+path, bytes.NewReader(body))
	req.Header.Set("x-kin-gateway-timestamp", timestamp)
	req.Header.Set("x-kin-gateway-nonce", nonce)
	req.Header.Set("x-kin-gateway-body-sha256", BodyHash(body))
	req.Header.Set("x-kin-gateway-signature", Sign(cfg.InternalToken, timestamp, nonce, BodyHash(body), body))
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(response.Body).Decode(&out)
	return response, out
}

func TestTestActionQueriesWhamUsageAndResetCredits(t *testing.T) {
	state := &whamServer{}
	wham := newWham(t, state)
	acct := account("a", "tok_a")
	acct.ChatGPTAccountID = "chatgpt_a"
	gw, httpServer, cfg := newExecuteServer(t, wham.URL+"/backend-api/codex", acct)
	response, out := accountActionRequest(t, cfg, httpServer.URL, "/internal/v1/accounts/a/test", map[string]any{})
	if response.StatusCode != 200 || out["plan_type"] != "pro" {
		t.Fatalf("status=%d out=%v", response.StatusCode, out)
	}
	reset, _ := out["reset_credits"].(map[string]any)
	if reset["available_count"] != float64(1) {
		t.Fatalf("reset credits=%v", out["reset_credits"])
	}
	if len(state.auth) != 1 || state.auth[0] != "Bearer tok_a|chatgpt_a|" {
		t.Fatalf("account request identity=%v", state.auth)
	}
	saved, _ := gw.store.Get("a")
	secondary, _ := saved.Quota["secondary_window"].(map[string]any)
	if secondary["window_minutes"] != float64(300) || saved.CooldownReason != string(categoryUsageLimit) {
		t.Fatalf("quota=%v account=%+v", saved.Quota, publicAccount(saved))
	}
}

func TestResetCreditConsumeReusesRedeemIDAfterUnknownOutcome(t *testing.T) {
	state := &whamServer{failFirst: true}
	wham := newWham(t, state)
	gw, httpServer, cfg := newExecuteServer(t, wham.URL+"/backend-api/codex", account("a", "tok_a"))
	gw.store.Dispose("a", "", upstreamFailure{Category: categoryUsageLimit, ResetsAt: time.Now().Add(time.Hour)}, time.Now())
	first, out := accountActionRequest(t, cfg, httpServer.URL, "/internal/v1/accounts/a/reset-credits", map[string]any{"credit_id": "credit_1"})
	redeem, _ := out["redeem_request_id"].(string)
	if first.StatusCode != http.StatusBadGateway || out["outcome"] != "unknown" || len(redeem) != 36 {
		t.Fatalf("first status=%d out=%v", first.StatusCode, out)
	}
	second, out := accountActionRequest(t, cfg, httpServer.URL, "/internal/v1/accounts/a/reset-credits", map[string]any{"credit_id": "credit_1", "redeem_request_id": redeem})
	if second.StatusCode != 200 || out["code"] != "ok" {
		t.Fatalf("second status=%d out=%v", second.StatusCode, out)
	}
	if len(state.consumed) != 2 || state.consumed[0] != state.consumed[1] || !strings.HasPrefix(state.consumed[0], redeem) {
		t.Fatalf("redeem ids=%v", state.consumed)
	}
}

// 心跳携带额度快照：启动后首次上报全部，控制面确认后只上报变化的账号；心跳失败不丢弃待报内容
func TestHeartbeatReportsChangedAccountQuotas(t *testing.T) {
	gw, _, _ := newExecuteServer(t, "http://127.0.0.1:1", account("a", "tok_a"), account("b", "tok_b"))
	gw.store.UpdateQuota("a", map[string]any{"primary_window": map[string]any{"used_percent": 81.0, "window_minutes": 10080.0}, "confidence": "partial", "updated_at": "2026-11-03T05:00:00Z"})
	var mu sync.Mutex
	var reports [][]quotaReport
	fail := false
	control := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload struct {
			AccountQuotas []quotaReport `json:"account_quotas"`
		}
		_ = json.NewDecoder(r.Body).Decode(&payload)
		mu.Lock()
		defer mu.Unlock()
		reports = append(reports, payload.AccountQuotas)
		if fail {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer control.Close()
	gw.cfg.ControlPlaneURL = control.URL
	beat := func() []quotaReport {
		t.Helper()
		ctx, cancel := context.WithCancel(context.Background())
		mu.Lock()
		before := len(reports)
		mu.Unlock()
		done := make(chan struct{})
		go func() { gw.registrationLoop(ctx); close(done) }()
		for deadline := time.Now().Add(2 * time.Second); time.Now().Before(deadline); time.Sleep(5 * time.Millisecond) {
			mu.Lock()
			n := len(reports)
			mu.Unlock()
			if n > before {
				break
			}
		}
		cancel()
		<-done
		mu.Lock()
		defer mu.Unlock()
		if len(reports) <= before {
			t.Fatal("no heartbeat")
		}
		return reports[before]
	}
	first := beat()
	if len(first) != 1 || first[0].AccountID != "a" || first[0].Quota["primary_window"].(map[string]any)["used_percent"] != 81.0 {
		t.Fatalf("first=%+v", first)
	}
	if again := beat(); len(again) != 0 {
		t.Fatalf("unchanged quota reported again: %+v", again)
	}
	gw.store.MergeQuota("a", map[string]any{"primary_window": map[string]any{"used_percent": 100.0, "window_minutes": 10080.0}})
	mu.Lock()
	fail = true
	mu.Unlock()
	if failed := beat(); len(failed) != 1 {
		t.Fatalf("changed quota not reported: %+v", failed)
	}
	mu.Lock()
	fail = false
	mu.Unlock()
	if retried := beat(); len(retried) != 1 || retried[0].Quota["primary_window"].(map[string]any)["used_percent"] != 100.0 {
		t.Fatalf("failed heartbeat must not drop the report: %+v", retried)
	}
}
