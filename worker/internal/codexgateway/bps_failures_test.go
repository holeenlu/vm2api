package codexgateway

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestParseBPSRateLimitScope(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	cases := map[string]struct {
		body  string
		key   string
		reset time.Duration
		ok    bool
	}{
		"no scope":            {`{"error":{"type":"rate_limit_error"}}`, "", 0, true},
		"account":             {`{"error":{"scope":"account","resets_in_seconds":90}}`, "", 90 * time.Second, true},
		"model":               {`{"error":{"scope":"model","model":"gpt-test","resets_at":1800000120}}`, "model:gpt-test", 120 * time.Second, true},
		"model other target":  {`{"error":{"scope":"model","model":"gpt-other"}}`, "", 0, false},
		"endpoint object":     {`{"error":{"scope":{"type":"endpoint","endpoint":"https://bps.openai.com/basispoints/api/responses"}}}`, "endpoint:responses", 0, true},
		"model endpoint":      {`{"error":{"scope":"model_endpoint","endpoint":"/basispoints/api/responses"}}`, "model:gpt-test|endpoint:responses", 0, true},
		"endpoint mismatch":   {`{"error":{"scope":"endpoint","endpoint":"/basispoints/api/attachments"}}`, "", 0, false},
		"unknown scope":       {`{"error":{"scope":"planet","resets_in_seconds":60}}`, "", 0, true},
		"stream terminal err": {`{"type":"response.failed","response":{"error":{"scope":"model","code":"rate_limit_exceeded"}}}`, "model:gpt-test", 0, true},
	}
	for name, c := range cases {
		key, reset, ok := parseBPSRateLimit([]byte(c.body), "gpt-test", bpsEndpointResponses, now)
		var gotReset time.Duration
		if !reset.IsZero() {
			gotReset = reset.Sub(now)
		}
		if key != c.key || ok != c.ok || gotReset != c.reset {
			t.Fatalf("%s: key=%q ok=%v reset=%s", name, key, ok, gotReset)
		}
	}
}

func TestBPSScopedRateLimitOnlyCoolsTheDeclaredModel(t *testing.T) {
	limited := jsonReply(429, `{"error":{"type":"rate_limit_error","scope":"model","model":"gpt-test","resets_in_seconds":600}}`)
	_, server := newBPSUpstream(t, map[string][]func(http.ResponseWriter){"bps_tok_a": {limited}, "bps_tok_b": {bpsTextReply("rb", "from b")}})
	s, httpServer, cfg := newBPSExecuteServer(t, server.URL, bpsAccount("a", "tok_a", "gpt-test", "gpt-other"), bpsAccount("b", "tok_b"))
	response, body := runBody(t, cfg, httpServer.URL, bpsTextRequest, SchedulingPolicy{BPSEnabled: true, Strategy: "round_robin"})
	if response.StatusCode != 200 {
		t.Fatalf("status=%d body=%s", response.StatusCode, body)
	}
	a, _ := s.store.Get("a")
	if !a.BPS.CooldownUntil.IsZero() || a.BPS.ScopedCooldowns["model:gpt-test"].Sub(time.Now()) < 9*time.Minute {
		t.Fatalf("grant=%+v", a.BPS)
	}
	now := time.Now()
	if bpsUsable(a, "gpt-test", bpsRequest{Supported: true}, now) || !bpsUsable(a, "gpt-other", bpsRequest{Supported: true}, now) {
		t.Fatal("a model-scoped 429 must only cool that model")
	}
}

func TestBPSAttachmentEndpointCooldownOnlyAffectsImageRequests(t *testing.T) {
	grant := &BPSGrant{}
	failure := upstreamFailure{Category: categoryRateLimited, bps: true, bpsEndpoint: bpsEndpointAttachments, Body: []byte(`{"error":{"scope":"endpoint"}}`)}
	now := time.Now()
	if !disposeBPSRateLimit(grant, "gpt-test", failure, now) || grant.ScopedCooldowns["endpoint:attachments"].IsZero() {
		t.Fatalf("grant=%+v", grant)
	}
	account := bpsAccount("a", "tok_a")
	account.BPS.ScopedCooldowns = grant.ScopedCooldowns
	if !bpsUsable(account, "gpt-test", bpsRequest{Supported: true}, now) || bpsUsable(account, "gpt-test", bpsRequest{Supported: true, Images: true}, now) {
		t.Fatal("attachment cooldown must only skip requests that upload images")
	}
}

func TestBPSUsagePolicy403BacksOffWithoutBlocking(t *testing.T) {
	blocked := jsonReply(403, `{"error":{"message":"This request was blocked by our usage policy.","type":"invalid_request_error","code":null}}`)
	_, server := newBPSUpstream(t, map[string][]func(http.ResponseWriter){"bps_tok_a": {blocked}, "bps_tok_b": {bpsTextReply("rb", "from b")}})
	s, httpServer, cfg := newBPSExecuteServer(t, server.URL, bpsAccount("a", "tok_a"), bpsAccount("b", "tok_b"))
	response, body := runBody(t, cfg, httpServer.URL, bpsTextRequest, SchedulingPolicy{BPSEnabled: true, Strategy: "round_robin"})
	if response.StatusCode != 200 || !strings.Contains(string(body), "from b") {
		t.Fatalf("status=%d body=%s", response.StatusCode, body)
	}
	a, _ := s.store.Get("a")
	backoff := a.BPS.PolicyBackoff["gpt-test"]
	if a.BPS.State != "" || backoff.Strikes != 1 || backoff.Until.Sub(time.Now()) > 31*time.Second || backoff.Until.Sub(time.Now()) < 25*time.Second {
		t.Fatalf("usage-policy 403 must back off the model, not block the account: %+v", a.BPS)
	}
	// 冷却期内的并发失败不延长；到期后再次失败按 60 秒退避；成功清除
	failure := upstreamFailure{Category: categoryPermissionDenied, Status: 403, bps: true, bpsUsagePolicy: true}
	s.store.DisposeBPS("a", "gpt-test", failure, time.Now())
	if a, _ = s.store.Get("a"); a.BPS.PolicyBackoff["gpt-test"].Strikes != 1 {
		t.Fatalf("concurrent failure extended the backoff: %+v", a.BPS.PolicyBackoff)
	}
	s.store.DisposeBPS("a", "gpt-test", failure, time.Now().Add(time.Minute))
	if a, _ = s.store.Get("a"); a.BPS.PolicyBackoff["gpt-test"].Strikes != 2 || a.BPS.PolicyBackoff["gpt-test"].Until.Sub(time.Now()) < 110*time.Second {
		t.Fatalf("second strike=%+v", a.BPS.PolicyBackoff)
	}
	s.store.RecordBPSSuccess("a", "gpt-test")
	if a, _ = s.store.Get("a"); len(a.BPS.PolicyBackoff) != 0 {
		t.Fatalf("success must clear the backoff: %+v", a.BPS.PolicyBackoff)
	}
}

func TestBPSUnauthorizedRefreshesAndRetriesOnTheSameAccount(t *testing.T) {
	unauthorized := jsonReply(401, `{"error":{"type":"authentication_error","code":"token_expired","message":"expired"}}`)
	upstream, server := newBPSUpstream(t, map[string][]func(http.ResponseWriter){"bps_tok_a": {unauthorized}, "bps_fresh": {bpsTextReply("r", "refreshed")}, "bps_tok_b": {bpsTextReply("rb", "from b")}})
	refreshes := 0
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		refreshes++
		_ = r.ParseForm()
		if r.Form.Get("refresh_token") != "bps_rt_tok_a" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "bps_fresh", "refresh_token": "bps_rt_2", "expires_in": 3600})
	}))
	t.Cleanup(tokenServer.Close)
	s, httpServer, cfg := newBPSExecuteServer(t, server.URL, bpsAccount("a", "tok_a"), bpsAccount("b", "tok_b"))
	s.cfg.OAuthTokenURL = tokenServer.URL
	response, body := runBody(t, cfg, httpServer.URL, bpsTextRequest, SchedulingPolicy{BPSEnabled: true, Strategy: "round_robin"})
	if response.StatusCode != 200 || !strings.Contains(string(body), "refreshed") || refreshes != 1 || upstream.count("bps_tok_b") != 0 {
		t.Fatalf("status=%d refreshes=%d b=%d body=%s", response.StatusCode, refreshes, upstream.count("bps_tok_b"), body)
	}
	if a, _ := s.store.Get("a"); a.BPS.AccessToken != "bps_fresh" || a.BPS.RefreshToken != "bps_rt_2" || a.BPS.State != "" {
		t.Fatalf("grant=%+v", a.BPS)
	}
}

func TestBPSInvalidEncryptedContentIsNotRetried(t *testing.T) {
	rejected := jsonReply(400, `{"error":{"type":"invalid_request_error","code":"invalid_encrypted_content","message":"bad state"}}`)
	upstream, server := newBPSUpstream(t, map[string][]func(http.ResponseWriter){"bps_tok_a": {rejected}, "bps_tok_b": {bpsTextReply("rb", "from b")}, "tok_a": {nativeReply("native")}, "tok_b": {nativeReply("native")}})
	s, httpServer, cfg := newBPSExecuteServer(t, server.URL, bpsAccount("a", "tok_a"), bpsAccount("b", "tok_b"))
	response, body := runBody(t, cfg, httpServer.URL, bpsTextRequest, SchedulingPolicy{BPSEnabled: true, Strategy: "round_robin"})
	if response.StatusCode != 400 || !strings.Contains(string(body), "invalid_encrypted_content") || !strings.Contains(string(body), "plaintext history") {
		t.Fatalf("status=%d body=%s", response.StatusCode, body)
	}
	if total := upstream.count("bps_tok_a") + upstream.count("bps_tok_b") + upstream.count("tok_a") + upstream.count("tok_b"); total != 1 {
		t.Fatalf("rejected ciphertext must not be retried, switched or sent native: calls=%d", total)
	}
	for _, id := range []string{"a", "b"} {
		if account, _ := s.store.Get(id); account.BPS.LastError != "" || !account.BPS.CooldownUntil.IsZero() {
			t.Fatalf("account state changed: %+v", account.BPS)
		}
	}
}
