package codexgateway

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func quotaAt(used float64, minutes float64, reset time.Time) map[string]any {
	return map[string]any{"used_percent": used, "window_minutes": minutes, "reset_at": reset.UTC().Format(time.RFC3339Nano)}
}

func TestQuotaSchedulerFollowsCPRCadence(t *testing.T) {
	q := newQuotaScheduler()
	now := time.Now()
	reset := now.Add(-20 * time.Second)
	exhausted := Account{ID: "x", Enabled: true, AccessToken: "t", Quota: map[string]any{"secondary_window": quotaAt(100, 10080, reset), "updated_at": "now"}}
	idle := Account{ID: "idle", Enabled: true, AccessToken: "t", Quota: map[string]any{"primary_window": quotaAt(0, 300, now.Add(-time.Hour)), "updated_at": "now"}}
	used := Account{ID: "used", Enabled: true, AccessToken: "t", Quota: map[string]any{"primary_window": quotaAt(40, 300, now.Add(-3*time.Minute)), "updated_at": "now"}}
	fresh := Account{ID: "fresh", Enabled: true, AccessToken: "t", Quota: map[string]any{"primary_window": quotaAt(40, 300, now.Add(time.Hour)), "updated_at": "now"}}
	got := ids(q.reservePeriodic([]Account{exhausted, idle, used, fresh}, now))
	if got != "x,used" {
		t.Fatalf("first round=%s", got)
	}
	// 已耗尽账号 reset 后 5 分钟内每 30 秒复核；有用量窗口过期的账号按 30 分钟节流
	if got := ids(q.reservePeriodic([]Account{exhausted, used}, now.Add(31*time.Second))); got != "x" {
		t.Fatalf("fast recheck=%s", got)
	}
	if got := ids(q.reservePeriodic([]Account{exhausted, used}, now.Add(10*time.Minute))); got != "x" {
		t.Fatalf("after fast window=%s", got)
	}
	if got := ids(q.reservePeriodic([]Account{exhausted, used}, now.Add(12*time.Minute))); got != "" {
		t.Fatalf("5-minute retry interval not applied: %s", got)
	}
	// reset 后 10 秒内不复核
	early := Account{ID: "early", Enabled: true, AccessToken: "t", Quota: map[string]any{"secondary_window": quotaAt(100, 10080, now.Add(-5*time.Second))}}
	if got := ids(q.reservePeriodic([]Account{early}, now)); got != "" {
		t.Fatalf("grace not respected: %s", got)
	}
	// 首查：无快照账号在随机延迟后才到期，每轮最多 100 个
	var pending []Account
	for i := 0; i < 150; i++ {
		pending = append(pending, Account{ID: fmt.Sprintf("n%d", i), Enabled: true, AccessToken: "t"})
	}
	// 首次进入候选时抽取随机到期时刻；到期前不查询
	if n := len(q.reserveInitial(pending, now)); n > initialQuotaSyncBatch/2 {
		t.Fatalf("initial refresh ignored its random delay: %d", n)
	}
	if n := len(q.reserveInitial(pending, now.Add(initialQuotaSyncMaxDelay))); n != initialQuotaSyncBatch {
		t.Fatalf("initial batch=%d", n)
	}
}

func ids(accounts []Account) string {
	var out []string
	for _, account := range accounts {
		out = append(out, account.ID)
	}
	return strings.Join(out, ",")
}

func TestWarmupPolicyClaimsEachLocalSlotOnce(t *testing.T) {
	p := loadRuntimePolicy(t.TempDir() + "/runtime.json")
	p.setWarmup(&WarmupPolicy{Enabled: true, Times: []string{"08:30"}, Model: "gpt-5.5"})
	at := time.Date(2026, 11, 3, 0, 30, 10, 0, time.UTC) // UTC+8 08:30
	if model, ok := p.claimWarmup(at); !ok || model != "gpt-5.5" {
		t.Fatalf("slot not claimed: %q %v", model, ok)
	}
	if _, ok := p.claimWarmup(at.Add(20 * time.Second)); ok {
		t.Fatal("same slot claimed twice")
	}
	if _, ok := p.claimWarmup(at.Add(time.Minute)); ok {
		t.Fatal("non-scheduled minute claimed")
	}
	reloaded := loadRuntimePolicy(p.path)
	if _, ok := reloaded.claimWarmup(at); ok {
		t.Fatal("claimed slot must survive restart")
	}
	now := time.Now()
	if !warmupSkip(map[string]any{"secondary_window": quotaAt(100, 10080, now.Add(time.Hour))}, now) {
		t.Fatal("weekly-exhausted account should be skipped")
	}
	if !warmupSkip(map[string]any{"primary_window": quotaAt(5, 300, now.Add(2*time.Hour))}, now) {
		t.Fatal("active 5h window should be skipped")
	}
	if warmupSkip(map[string]any{"primary_window": quotaAt(5, 300, now.Add(10*time.Minute))}, now) {
		t.Fatal("5h window close to reset should be warmed")
	}
}

func TestWarmupSendsMinimalRequestAndSyncsQuota(t *testing.T) {
	var bodies []map[string]any
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(data, &body)
		bodies = append(bodies, body)
		w.Header().Set("x-codex-primary-used-percent", "1")
		w.Header().Set("x-codex-primary-window-minutes", "300")
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"w\",\"status\":\"completed\"}}\n\n")
	}))
	t.Cleanup(upstream.Close)
	gw, _, _ := newExecuteServer(t, upstream.URL, account("a", "tok_a"), Account{ID: "k", Enabled: true, APIKey: "sk", Groups: []string{"1"}})
	gw.runWarmup(context.Background(), "gpt-5.5")
	if len(bodies) != 1 || bodies[0]["service_tier"] != "default" || bodies[0]["store"] != false || bodies[0]["model"] != "gpt-5.5" {
		t.Fatalf("warmup bodies=%v", bodies)
	}
	if window, _ := mustGet(t, gw, "a").Quota["primary_window"].(map[string]any); window["used_percent"] != float64(1) {
		t.Fatalf("quota not synced: %v", mustGet(t, gw, "a").Quota)
	}
}

func TestAccountEligibilityAndPlanCatalog(t *testing.T) {
	gw, _, _ := newExecuteServer(t, "http://127.0.0.1:1")
	now := time.Now()
	plus := Account{ID: "p", Plan: "Plus", AccessToken: "t"}
	free := Account{ID: "f", Plan: "free", AccessToken: "t"}
	restricted := Account{ID: "r", Plan: "plus", AccessToken: "t", Models: []string{"gpt-5.5"}}
	if gw.accountEligible(plus, "responses", "grok-4", now) {
		t.Fatal("OAuth account must not serve grok")
	}
	if gw.accountEligible(free, "images.generations", "gpt-image-1", now) || !gw.accountEligible(free, "responses", "gpt-5.5", now) {
		t.Fatal("free plan only excluded from images")
	}
	if gw.accountEligible(restricted, "search", "", now) || !gw.accountEligible(plus, "search", "", now) {
		t.Fatal("unnamed search must use unrestricted accounts")
	}
	gw.plans.entries["plus"] = planCatalog{observedAt: now, models: map[string]bool{"gpt-5.5": true}}
	if gw.accountEligible(plus, "responses", "gpt-5.4-mini", now) || !gw.accountEligible(plus, "responses", "gpt-5.5", now) {
		t.Fatal("fresh plan catalog should gate models")
	}
	if !gw.accountEligible(free, "responses", "gpt-5.4-mini", now) {
		t.Fatal("plans without a catalog stay eligible")
	}
	// CPR 09b22a95：账号白名单精确列出的模型 ID 不受套餐目录排除，交给上游验证
	listed := Account{ID: "l", Plan: "Plus", AccessToken: "t", Models: []string{"gpt-5.4-mini"}}
	if !gw.accountEligible(listed, "responses", "gpt-5.4-mini", now) || gw.accountEligible(listed, "responses", "gpt-5.3", now) {
		t.Fatal("allowlisted model must bypass the plan catalog only for the exact ID")
	}
	gw.plans.entries["plus"] = planCatalog{observedAt: now.Add(-planCatalogMaxAge), models: map[string]bool{}}
	if !gw.accountEligible(plus, "responses", "gpt-5.4-mini", now) {
		t.Fatal("stale catalog must not exclude")
	}
	models := parsePlanCatalog([]byte(`{"models":[{"slug":"gpt-5.5","service_tiers":[{"id":"priority","name":"Fast","description":""}]},{"slug":"gpt-5.4"}]}`))
	if !models["gpt-5.5"] || models["gpt-5.4"] {
		t.Fatalf("catalog=%v", models)
	}
}

func TestFastPolicy(t *testing.T) {
	cases := []struct {
		body, mode string
		priority   bool
		want       string
	}{
		{`{"model":"m"}`, "enabled", true, `{"model":"m","service_tier":"priority"}`},
		{`{"model":"m","service_tier":"default"}`, "enabled", true, `{"model":"m","service_tier":"priority"}`},
		{`{"model":"m"}`, "enabled", false, `{"model":"m"}`},
		{`{"model":"m","service_tier":"flex"}`, "enabled", true, `{"model":"m","service_tier":"flex"}`},
		{`{"model":"m","service_tier":"Fast"}`, "disabled", true, `{"model":"m","service_tier":"default"}`},
		{`{"model":"m","service_tier":"priority"}`, "default", true, `{"model":"m","service_tier":"priority"}`},
	}
	for _, c := range cases {
		if got := string(applyFastPolicy([]byte(c.body), c.mode, c.priority)); got != c.want {
			t.Fatalf("%s %s: got %s want %s", c.body, c.mode, got, c.want)
		}
	}
}

func TestWSSessionBudgetFallsBackToHTTP(t *testing.T) {
	b := newWSSessionBudget()
	now := time.Now()
	for i := 0; i <= wsRecoveryLimit; i++ {
		if b.usesHTTP("k", now) {
			t.Fatalf("switched to HTTP after %d failures", i)
		}
		b.recordFailure("k", now)
	}
	if !b.usesHTTP("k", now) {
		t.Fatal("budget exhausted but still WS")
	}
	if b.usesHTTP("k", now.Add(wsSessionIdleRetention+time.Second)) {
		t.Fatal("idle session must be released")
	}
	b.disable("k2", now)
	b.succeeded("k2")
	if b.usesHTTP("k2", now) {
		t.Fatal("success should clear the session state")
	}
}

func TestProxySlotEvictsIdleConnectionWhenFull(t *testing.T) {
	fake := &fakeWSUpstream{}
	gw, _, _ := newWSGateway(t, fake, account("a", "tok_a"))
	pool := gw.ws
	if err := pool.acquireProxySlot(context.Background(), "proxy-1", 1); err != nil {
		t.Fatal(err)
	}
	conn, _, err := gw.dialWS(context.Background(), Account{AccessToken: "tok_a"}, nil, "", nil, attemptState{})
	if err != nil {
		t.Fatal(err)
	}
	idle := &wsConn{conn: conn, account: "a", idleKey: "a", proxyKey: "proxy-1", lastUsed: time.Now()}
	pool.put("", idle, time.Now())
	// 满额：回收同代理的空闲连接后取得名额
	if err := pool.acquireProxySlot(context.Background(), "proxy-1", 1); err != nil {
		t.Fatalf("eviction failed: %v", err)
	}
	if !idle.released.Load() || len(pool.idle["a"]) != 0 {
		t.Fatal("idle connection was not evicted")
	}
	// 没有可回收连接时等待名额；归还后立即取得
	var acquired atomic.Bool
	go func() {
		if pool.acquireProxySlot(context.Background(), "proxy-1", 1) == nil {
			acquired.Store(true)
		}
	}()
	time.Sleep(50 * time.Millisecond)
	if acquired.Load() {
		t.Fatal("slot acquired beyond the limit")
	}
	pool.releaseProxySlot("proxy-1")
	deadline := time.Now().Add(2 * time.Second)
	for !acquired.Load() && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if !acquired.Load() {
		t.Fatal("waiter not woken after release")
	}
}

func TestHeartbeatResponseCarriesBackgroundPolicy(t *testing.T) {
	gw, _, _ := newExecuteServer(t, "http://127.0.0.1:1")
	gw.applyHeartbeatPolicy([]byte(`{"ok":true,"policy":{"account_protection":{"enabled":true,"threshold":3,"windowMs":600000,"durationMs":3600000,"probeEnabled":true,"rules":[{"id":"r","name":"r","conditions":[{"field":"status","operator":"equals","values":["403"]}]}],"fingerprint":"fp"},"warmup":{"enabled":true,"times":["08:00"],"model":"gpt-5.5"}}}`))
	if policy := gw.protection.current(); policy == nil || policy.Fingerprint != "fp" {
		t.Fatalf("protection=%+v", policy)
	}
	if gw.runtime.Warmup == nil || gw.runtime.Warmup.Model != "gpt-5.5" {
		t.Fatalf("warmup=%+v", gw.runtime.Warmup)
	}
}
