package codexgateway

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
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

// 只指定账号（账号测试）且非续接：BPS 阶段 403 后与线上一致改走同一账号的原生通道，不换到其他账号；
// Key 只走 BPS 时仍交付 BPS 的错误，不碰原生
func TestPinnedAccountBPSFailureFallsBackToItsNativeChannel(t *testing.T) {
	blocked := jsonReply(403, `{"error":{"message":"This request was blocked by our usage policy.","type":"invalid_request_error","code":null}}`)
	run := func(t *testing.T, policy SchedulingPolicy) (*bpsUpstream, *http.Response, []byte) {
		upstream, server := newBPSUpstream(t, map[string][]func(http.ResponseWriter){
			"bps_tok_a": {blocked}, "tok_a": {nativeReply("native a")},
			"bps_tok_b": {bpsTextReply("rb", "from b")}, "tok_b": {nativeReply("native b")},
		})
		_, httpServer, cfg := newBPSExecuteServer(t, server.URL, bpsAccount("a", "tok_a"), bpsAccount("b", "tok_b"))
		n := nonceSeq.Add(1)
		response := signedExecute(t, cfg, httpServer.URL, Envelope{Dispatch: fmt.Sprintf("d_%d", n), RequestID: fmt.Sprintf("r_%d", n), Nonce: fmt.Sprintf("n_%d", n), Operation: "responses", Protocol: "openai.responses", Model: "gpt-test", Stream: true, Body: json.RawMessage(bpsTextRequest), Scope: Scope{RuntimeAccountID: "a"}, Scheduling: policy})
		data, _ := io.ReadAll(response.Body)
		response.Body.Close()
		return upstream, response, data
	}
	upstream, response, body := run(t, bpsOn)
	if response.StatusCode != 200 || !strings.Contains(string(body), "native a") || response.Header.Get(authModeHeader) != "native" {
		t.Fatalf("auto: status=%d body=%s", response.StatusCode, body)
	}
	if strings.Join(upstream.sequence, ",") != "bps_tok_a,tok_a" {
		t.Fatalf("auto: pinned test must stay on account a: %v", upstream.sequence)
	}
	upstream, response, body = run(t, SchedulingPolicy{BPSEnabled: true, RoutePolicy: routePolicyBPSOnly})
	if response.StatusCode != 503 || !strings.Contains(string(body), "basispoints_upstream_error") || strings.Join(upstream.sequence, ",") != "bps_tok_a" {
		t.Fatalf("bps_only: status=%d calls=%v body=%s", response.StatusCode, upstream.sequence, body)
	}
}

func TestBPSUsagePolicy403BacksOffTheAccountAndBlocksAfterSeveralSessions(t *testing.T) {
	blocked := jsonReply(403, `{"error":{"message":"This request was blocked by our usage policy.","type":"invalid_request_error","code":null}}`)
	_, server := newBPSUpstream(t, map[string][]func(http.ResponseWriter){"bps_tok_a": {blocked}, "bps_tok_b": {bpsTextReply("rb", "from b")}})
	s, httpServer, cfg := newBPSExecuteServer(t, server.URL, bpsAccount("a", "tok_a", "gpt-test", "gpt-other"), bpsAccount("b", "tok_b"))
	response, body := runBody(t, cfg, httpServer.URL, bpsTextRequest, SchedulingPolicy{BPSEnabled: true, Strategy: "round_robin"})
	if response.StatusCode != 200 || !strings.Contains(string(body), "from b") {
		t.Fatalf("status=%d body=%s", response.StatusCode, body)
	}
	// 被换号接住的 403 也要在尝试记录里留下上游原文，运维才能区分 usage policy 与其他 403
	var attempts []attemptRecord
	_ = json.Unmarshal([]byte(response.Header.Get(attemptsHeader)), &attempts)
	if len(attempts) != 2 || attempts[0].Status != 403 || attempts[0].Message != "This request was blocked by our usage policy." || attempts[1].Message != "" {
		t.Fatalf("attempts=%+v", attempts)
	}
	a, _ := s.store.Get("a")
	backoff := a.BPS.PolicyBackoff[bpsPolicyAccountKey]
	if a.BPS.State != "" || backoff.Strikes != 1 || len(backoff.Sessions) != 1 || backoff.Until.Sub(time.Now()) > 31*time.Second || backoff.Until.Sub(time.Now()) < 25*time.Second {
		t.Fatalf("first usage-policy 403 must back off the account: %+v", a.BPS)
	}
	// 退避按账号：名单里的其他模型同样暂停
	if bpsUsable(a, "gpt-other", bpsRequest{Supported: true}, time.Now()) {
		t.Fatal("usage-policy backoff must cover every model of the account")
	}
	failure := func(session string) upstreamFailure {
		return upstreamFailure{Category: categoryPermissionDenied, Status: 403, bps: true, bpsUsagePolicy: true, bpsSession: session}
	}
	first := backoff.Sessions[0]
	// 同一会话在冷却期内的并发失败不延长；到期后再次失败按 60 秒退避，仍只算一个会话
	s.store.DisposeBPS("a", "gpt-test", failure(first), time.Now())
	s.store.DisposeBPS("a", "gpt-test", failure(first), time.Now().Add(time.Minute))
	if a, _ = s.store.Get("a"); a.BPS.State != "" || a.BPS.PolicyBackoff[bpsPolicyAccountKey].Strikes != 2 || len(a.BPS.PolicyBackoff[bpsPolicyAccountKey].Sessions) != 1 {
		t.Fatalf("one session must not block the account: %+v", a.BPS)
	}
	// 成功清除退避与会话计数
	s.store.RecordBPSSuccess("a", "gpt-other")
	if a, _ = s.store.Get("a"); len(a.BPS.PolicyBackoff) != 0 {
		t.Fatalf("success must clear the backoff: %+v", a.BPS.PolicyBackoff)
	}
	// 连续命中来自 3 个不同会话（期间没有成功）：开启 403 自动停用时停用 BPS，交给恢复探测
	now := time.Now()
	for i, session := range []string{"s1", "s2", "s3"} {
		s.store.DisposeBPS("a", "gpt-test", failure(session), now.Add(time.Duration(i)*time.Second))
	}
	if a, _ = s.store.Get("a"); a.BPS.State != bpsStateBlocked || a.BPS.BlockedAt.IsZero() || a.BPS.LastError != "usage_policy" || len(a.BPS.PolicyBackoff) != 0 {
		t.Fatalf("three sessions must block the BPS grant: %+v", a.BPS)
	}
	// 未开启 403 自动停用：只退避，不停用
	c := bpsAccount("c", "tok_c")
	c.BPSSettings.AutoDisableOn403 = false
	_, _ = s.store.Upsert(c)
	for _, session := range []string{"s1", "s2", "s3", "s4"} {
		s.store.DisposeBPS("c", "gpt-test", failure(session), now)
	}
	if got, _ := s.store.Get("c"); got.BPS.State != "" || got.BPS.PolicyBackoff[bpsPolicyAccountKey].Strikes != 1 {
		t.Fatalf("without auto-disable the grant must only back off: %+v", got.BPS)
	}
}

// 流内的 usage-policy 拒绝（转换前是 403，转换后只剩通用错误码）：不重放到其他账号，照常记账号退避
func TestBPSStreamUsagePolicyIsNotReplayed(t *testing.T) {
	refused := sseReply(`{"type":"response.created","response":{"id":"r1"}}`, `{"type":"response.failed","response":{"id":"r1","status":"failed","error":{"message":"This request was blocked by our usage policy.","type":"invalid_request_error","code":null}}}`)
	upstream, server := newBPSUpstream(t, map[string][]func(http.ResponseWriter){"bps_tok_a": {refused}, "bps_tok_b": {bpsTextReply("rb", "from b")}, "tok_a": {nativeReply("native")}, "tok_b": {nativeReply("native")}})
	s, httpServer, cfg := newBPSExecuteServer(t, server.URL, bpsAccount("a", "tok_a"), bpsAccount("b", "tok_b"))
	_, body := runBody(t, cfg, httpServer.URL, bpsTextRequest, SchedulingPolicy{BPSEnabled: true, Strategy: "round_robin"})
	if len(upstream.sequence) != 1 || upstream.sequence[0] != "bps_tok_a" || !strings.Contains(string(body), "response.failed") {
		t.Fatalf("the refused request was replayed: calls=%v body=%s", upstream.sequence, body)
	}
	a, _ := s.store.Get("a")
	if a.BPS.PolicyBackoff[bpsPolicyAccountKey].Strikes != 1 || a.BPS.LastError != "usage_policy" {
		t.Fatalf("stream usage-policy refusal must back off the account: %+v", a.BPS)
	}
}

// 流内的模型无权与 5xx 仍换号（对齐 sub2api）：前者冷却该模型；5xx 先同号重试一次
func TestBPSStreamModelAccessAndServerErrorsRotate(t *testing.T) {
	for name, tc := range map[string]struct {
		event       string
		modelCooled bool
		calls       string
	}{
		"model_not_allowed": {`{"type":"response.failed","response":{"id":"r1","error":{"type":"permission_error","code":"model_not_allowed","message":"no access"}}}`, true, "bps_tok_a,bps_tok_b"},
		"server_error":      {`{"type":"error","error":{"type":"server_error","code":"internal_server_error","message":"boom"}}`, false, "bps_tok_a,bps_tok_a,bps_tok_b"},
	} {
		t.Run(name, func(t *testing.T) {
			upstream, server := newBPSUpstream(t, map[string][]func(http.ResponseWriter){"bps_tok_a": {sseReply(tc.event)}, "bps_tok_b": {bpsTextReply("rb", "from b")}})
			s, httpServer, cfg := newBPSExecuteServer(t, server.URL, bpsAccount("a", "tok_a"), bpsAccount("b", "tok_b"))
			response, body := runBody(t, cfg, httpServer.URL, bpsTextRequest, SchedulingPolicy{BPSEnabled: true, Strategy: "round_robin"})
			if response.StatusCode != 200 || !strings.Contains(string(body), "from b") || strings.Join(upstream.sequence, ",") != tc.calls {
				t.Fatalf("status=%d calls=%v body=%s", response.StatusCode, upstream.sequence, body)
			}
			a, _ := s.store.Get("a")
			if _, cooled := a.BPS.ModelCooldowns["gpt-test"]; cooled != tc.modelCooled {
				t.Fatalf("model cooldowns=%v", a.BPS.ModelCooldowns)
			}
		})
	}
}

// usage_policy 码与其他内容拒绝一样不重放（对齐 sub2api content_moderation_refusal）
func TestBPSUsagePolicyCodeIsAContentRefusal(t *testing.T) {
	refused := jsonReply(403, `{"error":{"message":"refused","type":"invalid_request_error","code":"usage_policy"}}`)
	upstream, server := newBPSUpstream(t, map[string][]func(http.ResponseWriter){"bps_tok_a": {refused}, "bps_tok_b": {bpsTextReply("rb", "from b")}, "tok_a": {nativeReply("native")}, "tok_b": {nativeReply("native")}})
	_, httpServer, cfg := newBPSExecuteServer(t, server.URL, bpsAccount("a", "tok_a"), bpsAccount("b", "tok_b"))
	response, body := runBody(t, cfg, httpServer.URL, bpsTextRequest, SchedulingPolicy{BPSEnabled: true, Strategy: "round_robin"})
	if response.StatusCode != 400 || !strings.Contains(string(body), "content_policy_violation") || len(upstream.sequence) != 1 {
		t.Fatalf("status=%d calls=%v body=%s", response.StatusCode, upstream.sequence, body)
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

// 被拒后刷新得到的 AT 再被 401 拒绝：授权转为 invalid（refreshed_access_token_rejected），不再循环刷新（对齐 sub2api）
func TestBPSRefreshedAccessTokenRejectedAgainInvalidatesTheGrant(t *testing.T) {
	unauthorized := jsonReply(401, `{"error":{"type":"authentication_error","code":"token_expired","message":"expired"}}`)
	_, server := newBPSUpstream(t, map[string][]func(http.ResponseWriter){"bps_tok_a": {unauthorized}, "bps_fresh": {unauthorized}, "tok_a": {nativeReply("native")}})
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "bps_fresh", "refresh_token": "bps_rt_2", "expires_in": 3600})
	}))
	t.Cleanup(tokenServer.Close)
	s, httpServer, cfg := newBPSExecuteServer(t, server.URL, bpsAccount("a", "tok_a"))
	s.cfg.OAuthTokenURL = tokenServer.URL
	runBody(t, cfg, httpServer.URL, bpsTextRequest, bpsOn)
	if a, _ := s.store.Get("a"); a.BPS.State != bpsStateInvalid || a.BPS.LastError != "refreshed_access_token_rejected" {
		t.Fatalf("grant=%+v", a.BPS)
	}
	// 普通刷新得到的 AT（未被拒过）第一次被 401：只标记待刷新，不判失效
	fresh := bpsAccount("b", "tok_b")
	_, _ = s.store.Upsert(fresh)
	s.store.DisposeBPS("b", "gpt-test", upstreamFailure{Category: categoryCredentialExpired, Status: 401, bps: true}, time.Now())
	if b, _ := s.store.Get("b"); b.BPS.State != "" || !b.BPS.AccessRejected {
		t.Fatalf("first rejection=%+v", b.BPS)
	}
}

// BPS 失败只按状态码与结构化错误码分类：错误文本里的“deactivated”“quota”“unauthorized”不升级账号状态
func TestBPSFailureTextDoesNotEscalateTheAccount(t *testing.T) {
	now := time.Now()
	for name, tc := range map[string]struct {
		status int
		body   string
		want   failureCategory
	}{
		"deactivated text":  {403, `{"error":{"type":"invalid_request_error","message":"Your account has been deactivated?"}}`, categoryPermissionDenied},
		"quota text":        {400, `{"error":{"type":"invalid_request_error","message":"quota for this sheet exceeded"}}`, categoryInvalidRequest},
		"unauthorized text": {403, `{"error":{"type":"invalid_request_error","message":"unauthorized range"}}`, categoryPermissionDenied},
		"banned code":       {403, `{"error":{"type":"invalid_request_error","code":"account_deactivated","message":"x"}}`, categoryBanned},
		"expired code":      {403, `{"error":{"type":"invalid_request_error","code":"token_revoked","message":"x"}}`, categoryCredentialExpired},
		"usage limit 429":   {429, `{"error":{"type":"usage_limit_reached","message":"x"}}`, categoryUsageLimit},
		"plain 429":         {429, `{"error":{"type":"rate_limit_error","message":"usage limit soon"}}`, categoryRateLimited},
	} {
		t.Run(name, func(t *testing.T) {
			if got := classifyBPSHTTPFailure(tc.status, http.Header{}, []byte(tc.body), now).Category; got != tc.want {
				t.Fatalf("category=%s want %s", got, tc.want)
			}
		})
	}
}

// 恢复探测取名单中第一个文本模型；只勾图片模型、账号停用或暂停时不探测
func TestBPSRecoveryProbeSkipsImageModelsAndDisabledAccounts(t *testing.T) {
	if got := bpsProbeModel([]string{"gpt-image-2", "gpt-test"}); got != "gpt-test" {
		t.Fatalf("probe model=%q", got)
	}
	if got := bpsProbeModel([]string{"gpt-image-2"}); got != "" {
		t.Fatalf("image-only probe model=%q", got)
	}
	upstream, server := newBPSUpstream(t, map[string][]func(http.ResponseWriter){"bps_tok_a": {bpsTextReply("probe", "pong")}, "bps_tok_b": {bpsTextReply("probe", "pong")}})
	blocked := func(id string, models ...string) Account {
		acct := bpsAccount(id, "tok_"+id, models...)
		acct.BPSSettings.AutoRecoverOn403, acct.BPSSettings.RecoveryIntervalMinutes = true, 1
		acct.BPS.State, acct.BPS.BlockedAt = bpsStateBlocked, time.Now().Add(-2*time.Minute)
		return acct
	}
	paused := blocked("a")
	paused.Paused = true
	gw, _, _ := newBPSExecuteServer(t, server.URL, paused, blocked("b", "gpt-image-2"))
	gw.probeBlockedBPS(context.Background(), time.Now())
	if upstream.count("bps_tok_a")+upstream.count("bps_tok_b") != 0 {
		t.Fatalf("probes sent: %v", upstream.sequence)
	}
	if b, _ := gw.store.Get("b"); b.bpsPause(time.Now())["bps_recovery"] != "off" {
		t.Fatalf("image-only grants have no recovery probe: %v", b.bpsPause(time.Now()))
	}
}

// 有会话标识时 BPS 请求的 prompt_cache_key 用会话身份（对齐 sub2api）；没有会话时不加
func TestBPSPromptCacheKeyFollowsTheSession(t *testing.T) {
	upstream, server := newBPSUpstream(t, map[string][]func(http.ResponseWriter){"bps_tok_a": {bpsTextReply("r", "ok")}})
	_, httpServer, cfg := newBPSExecuteServer(t, server.URL, bpsAccount("a", "tok_a"))
	runBody(t, cfg, httpServer.URL, bpsTextRequest, bpsOn)
	if strings.Contains(string(upstream.bodies["bps_tok_a"]), "prompt_cache_key") {
		t.Fatalf("no session, no cache key: %s", upstream.bodies["bps_tok_a"])
	}
	n := nonceSeq.Add(1)
	response := signedExecute(t, cfg, httpServer.URL, Envelope{Dispatch: fmt.Sprintf("d_%d", n), RequestID: fmt.Sprintf("r_%d", n), Nonce: fmt.Sprintf("n_%d", n), Operation: "responses", Protocol: "openai.responses", Model: "gpt-test", Stream: true, Body: json.RawMessage(bpsTextRequest), Scope: Scope{GroupIDs: []int64{1}, SessionID: "sess-1"}, Scheduling: bpsOn})
	_, _ = io.ReadAll(response.Body)
	response.Body.Close()
	if !strings.Contains(string(upstream.bodies["bps_tok_a"]), `"prompt_cache_key":"bps-`) {
		t.Fatalf("session requests carry a cache key: %s", upstream.bodies["bps_tok_a"])
	}
}

// 流内 429 按声明的范围与重置时间冷却（与 HTTP 429 一致）
func TestBPSStreamRateLimitKeepsItsScope(t *testing.T) {
	limited := sseReply(`{"type":"response.failed","response":{"id":"r1","error":{"type":"rate_limit_error","code":"rate_limit_exceeded","message":"slow","scope":"model","resets_in_seconds":120}}}`)
	_, server := newBPSUpstream(t, map[string][]func(http.ResponseWriter){"bps_tok_a": {limited}, "bps_tok_b": {bpsTextReply("rb", "from b")}})
	s, httpServer, cfg := newBPSExecuteServer(t, server.URL, bpsAccount("a", "tok_a"), bpsAccount("b", "tok_b"))
	runBody(t, cfg, httpServer.URL, bpsTextRequest, SchedulingPolicy{BPSEnabled: true, Strategy: "round_robin"})
	a, _ := s.store.Get("a")
	until := a.BPS.ScopedCooldowns[bpsCooldownKey("gpt-test", "")]
	if !a.BPS.CooldownUntil.IsZero() || until.Sub(time.Now()) < 100*time.Second {
		t.Fatalf("stream 429 must cool the declared model scope: %+v", a.BPS)
	}
}

// BPS 的 cyber_policy 拒绝不重放，并计入会话风控：同一会话的后续请求不再选这个账号
func TestBPSCyberPolicyMarksTheSession(t *testing.T) {
	refused := jsonReply(400, `{"error":{"type":"invalid_request_error","code":"cyber_policy","message":"no"}}`)
	upstream, server := newBPSUpstream(t, map[string][]func(http.ResponseWriter){"bps_tok_a": {refused}})
	s, httpServer, cfg := newBPSExecuteServer(t, server.URL, bpsAccount("a", "tok_a"))
	body := strings.Replace(bpsTextRequest, `"stream":true`, `"stream":true,"prompt_cache_key":"conv-cyber"`, 1)
	n := nonceSeq.Add(1)
	envelope := Envelope{Dispatch: fmt.Sprintf("d_%d", n), RequestID: fmt.Sprintf("r_%d", n), Nonce: fmt.Sprintf("n_%d", n), Operation: "responses", Protocol: "openai.responses", Model: "gpt-test", Stream: true, Body: json.RawMessage(body), Scope: Scope{GroupIDs: []int64{1}}, ClientScope: "key-1", Scheduling: bpsOn}
	response := signedExecute(t, cfg, httpServer.URL, envelope)
	data, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != 400 || !strings.Contains(string(data), "cyber_policy") || len(upstream.sequence) != 1 {
		t.Fatalf("status=%d calls=%v body=%s", response.StatusCode, upstream.sequence, data)
	}
	run := &dispatchRun{server: s, envelope: envelope}
	if !s.cyberPolicy.excluded(run.cyberPolicyKey(), time.Now())["a"] {
		t.Fatal("a BPS cyber_policy refusal must exclude the account for the session")
	}
}

// usage-policy 拒绝对调用方说明是使用政策，而不是“授权被拒”
func TestBPSUsagePolicyClientMessage(t *testing.T) {
	blocked := jsonReply(403, `{"error":{"message":"This request was blocked by our usage policy.","type":"invalid_request_error","code":null}}`)
	_, server := newBPSUpstream(t, map[string][]func(http.ResponseWriter){"bps_tok_a": {blocked}})
	_, httpServer, cfg := newBPSExecuteServer(t, server.URL, bpsAccount("a", "tok_a"))
	response, body := runBody(t, cfg, httpServer.URL, bpsTextRequest, SchedulingPolicy{BPSEnabled: true, RoutePolicy: routePolicyBPSOnly})
	if response.StatusCode != 503 || !strings.Contains(string(body), "usage policy") || strings.Contains(string(body), "authorization of the selected account") {
		t.Fatalf("status=%d body=%s", response.StatusCode, body)
	}
}
