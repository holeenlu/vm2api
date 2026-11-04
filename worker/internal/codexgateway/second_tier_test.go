package codexgateway

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"
)

// 入站头按 CPR 黑名单透传，身份头按优先级推导：会话/线程取正文、client_metadata 或 turn metadata；
// x-client-request-id 缺省依次取正文、线程、会话、网关请求 ID；正文字段投影为请求头，入站头优先。
func TestUpstreamInboundHeadersDeriveIdentity(t *testing.T) {
	run := &dispatchRun{envelope: Envelope{RequestID: "req_gw", Headers: map[string]string{
		"Authorization": "Bearer caller", "user-agent": "caller/1", "x-forwarded-for": "1.2.3.4", "x-kin-secret": "1",
		"accept-language": "zh-CN", "x-codex-window-id": "win_header",
	}, Body: json.RawMessage(`{"client_metadata":{"session_id":"sess_meta","x-openai-subagent":"review"},"turn_metadata":"{\"thread_id\":\"th_turn\"}","codexWindowId":"win_body","betaFeatures":"f1","includeTimingMetrics":"true"}`)}}
	got := run.upstreamInboundHeaders()
	for _, blocked := range []string{"authorization", "user-agent", "x-forwarded-for", "x-kin-secret"} {
		if _, ok := got[blocked]; ok {
			t.Fatalf("%s must not pass through: %v", blocked, got)
		}
	}
	want := map[string]string{
		"accept-language": "zh-CN", "session-id": "sess_meta", "thread-id": "th_turn", "x-codex-turn-metadata": `{"thread_id":"th_turn"}`,
		"x-codex-window-id": "win_header", "x-codex-beta-features": "f1", "x-responsesapi-include-timing-metrics": "true",
		"x-openai-subagent": "review", "x-client-request-id": "th_turn",
	}
	for name, value := range want {
		if got[name] != value {
			t.Errorf("%s=%q want %q", name, got[name], value)
		}
	}
	bare := &dispatchRun{envelope: Envelope{RequestID: "req_gw", Body: json.RawMessage(`{}`)}}
	if bare.upstreamInboundHeaders()["x-client-request-id"] != "req_gw" {
		t.Fatal("x-client-request-id must fall back to the gateway request id")
	}
}

// 具名额度桶（响应头与 /wham/usage）只作展示事实；套餐泛化值不覆盖具体 SKU，unknown 不写入。
func TestNamedQuotaBucketsAndPlanAliases(t *testing.T) {
	now := time.Now()
	evidence := parseQuotaHeaders(http.Header{
		"X-Codex-Primary-Used-Percent":           {"10"},
		"X-Codex-Bengalfox-Primary-Used-Percent": {"60"},
		"X-Codex-Bengalfox-Limit-Name":           {"GPT-5.3-Codex-Spark"},
		"X-Codex-Bengalfox-Limit-Reached":        {"false"},
	}, now)
	bucket := evidence.Buckets["codex_bengalfox"]
	if bucket == nil || bucket["limit_name"] != "GPT-5.3-Codex-Spark" || bucket["limit_reached"] != false || evidence.Buckets["codex"] != nil {
		t.Fatalf("buckets=%v", evidence.Buckets)
	}
	usage := quotaFromUsage(map[string]any{"rate_limit": map[string]any{"allowed": true}, "additional_rate_limits": []any{map[string]any{"limit_id": "spark", "limit_name": "Spark", "rate_limit": map[string]any{"primary_window": map[string]any{"used_percent": 30.0}}}}}, now)
	if buckets, _ := usage["buckets"].(map[string]map[string]any); buckets["spark"]["limit_name"] != "Spark" {
		t.Fatalf("usage buckets=%v", usage["buckets"])
	}
	account := Account{Plan: "self_serve_business_prolite"}
	adoptPlan(&account, map[string]any{"plan_type": "team"})
	adoptPlan(&account, map[string]any{"plan_type": "unknown"})
	if account.Plan != "self_serve_business_prolite" {
		t.Fatalf("a generalized plan must not override the SKU: %s", account.Plan)
	}
	adoptPlan(&account, map[string]any{"plan_type": "Pro"})
	if account.Plan != "pro" {
		t.Fatalf("plan=%s", account.Plan)
	}
}

// 恢复操作重置全部凭据状态；额度拒绝后的回读只更新展示，不解除耗尽；停用账号同样进入刷新候选。
func TestRecoverReadbackAndDisabledRefresh(t *testing.T) {
	store, _ := OpenStore(t.TempDir() + "/accounts.json")
	acct := account("a", "tok")
	acct.CredentialState = "banned"
	_, _ = store.Upsert(acct)
	if err := store.Recover("a"); err != nil {
		t.Fatal(err)
	}
	if saved, _ := store.Get("a"); saved.CredentialState != "" {
		t.Fatalf("recover must reset the credential state: %q", saved.CredentialState)
	}
	store.Dispose("a", "", upstreamFailure{Category: categoryUsageLimit, ResetsAt: time.Now().Add(time.Hour)}, time.Now())
	store.ReplaceQuotaDisplay("a", map[string]any{"access": quotaAccessAllowed, "primary_window": map[string]any{"used_percent": 5.0}})
	saved, _ := store.Get("a")
	if !quotaExhaustedFact(saved) || saved.Quota["primary_window"] == nil {
		t.Fatalf("a display readback must not release the exhaustion: %+v", saved)
	}
	disabled := account("d", "tok")
	disabled.Enabled = false
	disabled.RefreshToken = "rt"
	disabled.ExpiresAt = time.Now().Add(time.Minute)
	if !refreshDue(disabled, time.Now()) {
		t.Fatal("disabled accounts stay refresh candidates")
	}
}

// 推理响应声明新的目录版本时清空客户端目录缓存；同一版本只触发一次。API Key 账号也带画像身份头。
func TestModelsETagAndAPIKeyProfileHeaders(t *testing.T) {
	cfg := Config{DataDir: t.TempDir(), InternalToken: "secret", UpstreamBaseURL: "http://127.0.0.1:1"}
	cfg.applyDefaults()
	gw, _ := NewServer(cfg)
	gw.catalog.entries["x"] = catalogEntry{fetched: time.Now()}
	gw.observeModelsETag(`"v1"`)
	if len(gw.catalog.entries) != 0 || gw.catalog.etag != `"v1"` {
		t.Fatal("a new models etag must invalidate the catalog cache")
	}
	gw.catalog.mu.Lock()
	gw.catalog.entries["y"] = catalogEntry{fetched: time.Now()}
	gw.catalog.mu.Unlock()
	gw.observeModelsETag(`"v1"`)
	if len(gw.catalog.entries) != 1 {
		t.Fatal("the same etag must only trigger once")
	}
	header := http.Header{}
	applyProfileIdentity(header, Account{APIKey: "sk", ChatGPTAccountID: "c", InstallationID: "inst"}, gw.globalProfile())
	if header.Get("Authorization") != "Bearer sk" || header.Get("originator") == "" || header.Get("version") == "" || header.Get("x-codex-installation-id") != "inst" || header.Get("chatgpt-account-id") != "" {
		t.Fatalf("api key headers=%v", header)
	}
}
