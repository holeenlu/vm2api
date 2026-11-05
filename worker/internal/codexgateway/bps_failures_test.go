package codexgateway

import (
	"context"
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
	if !disposeBPSRateLimit(grant, nil, "gpt-test", failure, now) || grant.ScopedCooldowns["endpoint:attachments"].IsZero() {
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

const bpsCipherRequest = `{"model":"gpt-test","stream":true,"input":[` +
	`{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]},` +
	`{"type":"reasoning","id":"rs_1","summary":[],"encrypted_content":"ENC_R"},` +
	`{"type":"message","role":"assistant","content":[{"type":"output_text","text":"answer"}]},` +
	`{"type":"message","role":"user","content":[{"type":"input_text","text":"next"}]}]}`

// 对齐 sub2api forwardExcelBPS：BPS 读不了历史密文时与原生相同，在同一账号逐级缩减重发（每步一次、最多两步），
// 不转原生；两步之后仍被拒按普通失败交付。
func TestBPSEncryptedRejectionReducesHistoryOnTheSameAccount(t *testing.T) {
	rejected := jsonReply(400, `{"error":{"type":"invalid_request_error","code":"invalid_encrypted_content","message":"The encrypted content for item rs_1 could not be verified."}}`)
	upstream, server := newBPSUpstream(t, map[string][]func(http.ResponseWriter){"bps_tok_a": {rejected, bpsTextReply("r1", "recovered")}, "tok_a": {nativeReply("native")}})
	_, httpServer, cfg := newBPSExecuteServer(t, server.URL, bpsAccount("a", "tok_a"))
	response, body := runBody(t, cfg, httpServer.URL, bpsCipherRequest, bpsOn)
	if response.StatusCode != 200 || !strings.Contains(string(body), "recovered") || upstream.count("bps_tok_a") != 2 || upstream.count("tok_a") != 0 {
		t.Fatalf("status=%d bps=%d native=%d body=%s", response.StatusCode, upstream.count("bps_tok_a"), upstream.count("tok_a"), body)
	}
	if strings.Contains(string(upstream.bodies["bps_tok_a"]), "ENC_R") {
		t.Fatalf("retry must drop reasoning ciphertext: %s", upstream.bodies["bps_tok_a"])
	}

	// 第二步：仍被拒时替换 compaction，再在同一 BPS 账号重发
	compacted := `{"model":"gpt-test","stream":true,"input":[` +
		`{"type":"compaction","encrypted_content":"ENC_C"},` +
		`{"type":"reasoning","id":"rs_1","summary":[],"encrypted_content":"ENC_R"},` +
		`{"type":"message","role":"user","content":[{"type":"input_text","text":"next"}]}]}`
	second, server2 := newBPSUpstream(t, map[string][]func(http.ResponseWriter){"bps_tok_a": {rejected, rejected, bpsTextReply("r2", "after compaction")}, "tok_a": {nativeReply("native")}})
	_, httpServer2, cfg2 := newBPSExecuteServer(t, server2.URL, bpsAccount("a", "tok_a"))
	response, body = runBody(t, cfg2, httpServer2.URL, compacted, bpsOn)
	if response.StatusCode != 200 || !strings.Contains(string(body), "after compaction") || second.count("bps_tok_a") != 3 || second.count("tok_a") != 0 {
		t.Fatalf("status=%d bps=%d native=%d body=%s", response.StatusCode, second.count("bps_tok_a"), second.count("tok_a"), body)
	}
	if last := string(second.bodies["bps_tok_a"]); strings.Contains(last, "ENC_") {
		t.Fatalf("second reduction must replace the compaction: %s", last)
	}

	// 没有可再缩减的密文：不转原生，交付 BPS 的拒绝
	still, server3 := newBPSUpstream(t, map[string][]func(http.ResponseWriter){"bps_tok_a": {rejected, rejected}, "tok_a": {nativeReply("native")}})
	_, httpServer3, cfg3 := newBPSExecuteServer(t, server3.URL, bpsAccount("a", "tok_a"))
	response, body = runBody(t, cfg3, httpServer3.URL, bpsCipherRequest, bpsOn)
	if response.StatusCode == 200 || still.count("bps_tok_a") != 2 || still.count("tok_a") != 0 {
		t.Fatalf("status=%d bps=%d native=%d body=%s", response.StatusCode, still.count("bps_tok_a"), still.count("tok_a"), body)
	}
}

// 对齐 codex2api 原作者：BPS 429 未声明重置时间时按账号设置冷却（缺省 5 秒），Retry-After 优先并限制在 1–600 秒。
func TestBPSRateLimitCooldownFollowsTheAccountSetting(t *testing.T) {
	now := time.Now()
	limited := upstreamFailure{Category: categoryRateLimited, bps: true, Body: []byte(`{"error":{"type":"rate_limit_error"}}`)}
	grant := &BPSGrant{}
	if !disposeBPSRateLimit(grant, nil, "gpt-test", limited, now) || !grant.CooldownUntil.Equal(now.Add(5*time.Second)) {
		t.Fatalf("default cooldown=%v", grant.CooldownUntil.Sub(now))
	}
	grant = &BPSGrant{}
	disposeBPSRateLimit(grant, &BPSSettings{RateLimitCooldownSeconds: 30}, "gpt-test", limited, now)
	if !grant.CooldownUntil.Equal(now.Add(30 * time.Second)) {
		t.Fatalf("configured cooldown=%v", grant.CooldownUntil.Sub(now))
	}
	for retryAfter, want := range map[time.Duration]time.Duration{0: time.Second, 20 * time.Second: 20 * time.Second, time.Hour: 600 * time.Second} {
		grant = &BPSGrant{}
		hinted := limited
		hinted.HasRetryAfter, hinted.RetryAfter = true, retryAfter
		disposeBPSRateLimit(grant, &BPSSettings{RateLimitCooldownSeconds: 30}, "gpt-test", hinted, now)
		if !grant.CooldownUntil.Equal(now.Add(want)) {
			t.Fatalf("Retry-After %v: cooldown=%v want %v", retryAfter, grant.CooldownUntil.Sub(now), want)
		}
	}
}

// 模型无权冷却按恢复间隔复核 access 目录：目录重新列出该模型时提前解除，未列出的保持原到期时间。
func TestBPSModelCooldownRecoversWhenTheCatalogListsTheModel(t *testing.T) {
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		_, _ = w.Write([]byte(`{"allowed":true,"model_catalog":{"models":[{"id":"gpt-back","label":"Back"}],"restricted_models":["gpt-gone"]}}`))
	}))
	t.Cleanup(upstream.Close)
	s, _, _ := newBPSExecuteServer(t, upstream.URL, bpsAccount("a", "tok_a"))
	now := time.Now()
	_, _ = s.store.UpdateBPS("a", func(account *Account) bool {
		account.BPS.ModelCooldowns = map[string]time.Time{"gpt-back": now.Add(30 * time.Minute), "gpt-gone": now.Add(30 * time.Minute)}
		return true
	})
	s.recoverBPSModels(context.Background(), now)
	account, _ := s.store.Get("a")
	if _, cooled := account.BPS.ModelCooldowns["gpt-back"]; cooled || account.BPS.ModelCooldowns["gpt-gone"].IsZero() || calls != 1 {
		t.Fatalf("cooldowns=%v calls=%d", account.BPS.ModelCooldowns, calls)
	}
	s.recoverBPSModels(context.Background(), now.Add(10*time.Second))
	if calls != 1 {
		t.Fatalf("the catalog is re-read only after the recovery interval: calls=%d", calls)
	}
}

// 不能改走原生的请求（Key 只走 BPS、历史钉在 BPS）在 BPS 429 后不再立刻交付：其他账号的短冷却到期或并发空出后继续换号。
func TestBPSOnlyRequestWaitsForAnotherBPSAccountAfterRateLimit(t *testing.T) {
	limited := jsonReply(http.StatusTooManyRequests, `{"error":{"type":"rate_limit_error","code":"rate_limit_exceeded","message":"Rate limit exceeded"}}`)
	bpsOnly := SchedulingPolicy{BPSEnabled: true, RoutePolicy: routePolicyBPSOnly}

	t.Run("cooldown", func(t *testing.T) {
		upstream, server := newBPSUpstream(t, map[string][]func(http.ResponseWriter){"bps_tok_a": {limited}, "bps_tok_b": {bpsTextReply("resp_b", "hello")}})
		cooling := bpsAccount("b", "tok_b")
		cooling.BPS.CooldownUntil = time.Now().Add(600 * time.Millisecond)
		_, httpServer, cfg := newBPSExecuteServer(t, server.URL, bpsAccount("a", "tok_a"), cooling)
		response, body := runBody(t, cfg, httpServer.URL, bpsTextRequest, bpsOnly)
		if response.StatusCode != http.StatusOK || !strings.Contains(string(body), "hello") || upstream.count("bps_tok_a") != 1 || upstream.count("bps_tok_b") != 1 {
			t.Fatalf("status=%d a=%d b=%d body=%s", response.StatusCode, upstream.count("bps_tok_a"), upstream.count("bps_tok_b"), body)
		}
	})

	t.Run("capacity", func(t *testing.T) {
		upstream, server := newBPSUpstream(t, map[string][]func(http.ResponseWriter){"bps_tok_a": {limited}, "bps_tok_b": {bpsTextReply("resp_b", "hello")}})
		busy := bpsAccount("b", "tok_b")
		busy.MaxConcurrency = 1
		s, httpServer, cfg := newBPSExecuteServer(t, server.URL, busy)
		// 生产按默认每账号 10 个排队位（KIN_CODEX_GATEWAY_MAX_WAITING_PER_ACCOUNT 未设置）；测试配置默认关闭排队
		s.store.SetQueueLimits(-1, defaultMaxWaitingPerAcct, 0)
		if _, err := s.store.Select(Scope{GroupIDs: []int64{1}}, "gpt-test", nil); err != nil {
			t.Fatal(err)
		}
		if _, err := s.store.Upsert(bpsAccount("a", "tok_a")); err != nil {
			t.Fatal(err)
		}
		release := time.AfterFunc(300*time.Millisecond, func() { s.store.ReleaseLease("b", false, "") })
		defer release.Stop()
		response, body := runBody(t, cfg, httpServer.URL, bpsTextRequest, bpsOnly)
		if response.StatusCode != http.StatusOK || !strings.Contains(string(body), "hello") || upstream.count("bps_tok_a") != 1 || upstream.count("bps_tok_b") != 1 {
			t.Fatalf("status=%d a=%d b=%d body=%s", response.StatusCode, upstream.count("bps_tok_a"), upstream.count("bps_tok_b"), body)
		}
	})

	t.Run("native fallback still does not wait", func(t *testing.T) {
		upstream, server := newBPSUpstream(t, map[string][]func(http.ResponseWriter){"bps_tok_a": {limited}, "bps_tok_b": {bpsTextReply("resp_b", "hello")}, "tok_a": {nativeReply("native")}, "tok_b": {nativeReply("native")}})
		cooling := bpsAccount("b", "tok_b")
		cooling.BPS.CooldownUntil = time.Now().Add(time.Minute)
		_, httpServer, cfg := newBPSExecuteServer(t, server.URL, bpsAccount("a", "tok_a"), cooling)
		response, body := runBody(t, cfg, httpServer.URL, bpsTextRequest, bpsOn)
		if response.StatusCode != http.StatusOK || !strings.Contains(string(body), "native") || upstream.count("bps_tok_b") != 0 {
			t.Fatalf("status=%d bps_b=%d body=%s", response.StatusCode, upstream.count("bps_tok_b"), body)
		}
	})
}
