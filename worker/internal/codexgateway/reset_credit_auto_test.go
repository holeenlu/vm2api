package codexgateway

import (
	"context"
	"strings"
	"testing"
	"time"
)

func autoResetServer(t *testing.T, state *whamServer) *Server {
	t.Helper()
	wham := newWham(t, state)
	acct := account("a", "tok_a")
	acct.ResetCreditAuto = true
	gw, _, _ := newExecuteServer(t, wham.URL+"/backend-api/codex", acct)
	gw.store.SetResetCreditPlan("a", &ResetCreditPlan{NextDiscoveryAt: time.Now().Add(-time.Minute)})
	return gw
}

// 到期前 lead 分钟内发现的卡片自动消费；结果确认后移出计划。
func TestResetCreditAutomationConsumesBeforeExpiry(t *testing.T) {
	state := &whamServer{expiresAt: time.Now().Add(5 * time.Minute).UTC().Format(time.RFC3339), consumeCode: "reset"}
	gw := autoResetServer(t, state)
	gw.reconcileResetCredit(context.Background(), "a", &ResetCreditPolicy{Enabled: true, LeadMinutes: 10}, time.Now())
	if len(state.consumed) != 1 || !strings.HasSuffix(state.consumed[0], "|credit_1") {
		t.Fatalf("consumed=%v", state.consumed)
	}
	saved, _ := gw.store.Get("a")
	plan := saved.ResetCreditPlan
	if plan == nil || plan.Pending != nil || len(plan.Credits) != 0 || plan.LastResult != "reset" || !plan.NextDiscoveryAt.After(time.Now()) {
		t.Fatalf("plan=%+v", plan)
	}
	// 卡片离到期还很远时只记录计划，不消费
	far := &whamServer{expiresAt: time.Now().Add(48 * time.Hour).UTC().Format(time.RFC3339)}
	gw = autoResetServer(t, far)
	gw.reconcileResetCredit(context.Background(), "a", &ResetCreditPolicy{Enabled: true, LeadMinutes: 10}, time.Now())
	saved, _ = gw.store.Get("a")
	if len(far.consumed) != 0 || len(saved.ResetCreditPlan.Credits) != 1 {
		t.Fatalf("a far credit must only be planned: consumed=%v plan=%+v", far.consumed, saved.ResetCreditPlan)
	}
	status := resetCreditStatus(saved, &ResetCreditPolicy{LeadMinutes: 10}, time.Now())
	if status["enabled"] != true || status["next_consume_at"] == nil {
		t.Fatalf("status=%v", status)
	}
}

// 幂等键在发送前落盘：结果不明时保留未决消费，重试沿用同一个 redeem_request_id。
func TestResetCreditAutomationReusesPendingRedeemID(t *testing.T) {
	state := &whamServer{failFirst: true, expiresAt: time.Now().Add(5 * time.Minute).UTC().Format(time.RFC3339), consumeCode: "reset"}
	gw := autoResetServer(t, state)
	policy := &ResetCreditPolicy{Enabled: true, LeadMinutes: 10}
	gw.reconcileResetCredit(context.Background(), "a", policy, time.Now())
	saved, _ := gw.store.Get("a")
	if saved.ResetCreditPlan.Pending == nil || saved.ResetCreditPlan.RetryAt.IsZero() {
		t.Fatalf("an unknown outcome must keep the pending consume: %+v", saved.ResetCreditPlan)
	}
	plan := saved.ResetCreditPlan.clone()
	plan.RetryAt = time.Now().Add(-time.Second)
	gw.store.SetResetCreditPlan("a", plan)
	gw.reconcileResetCredit(context.Background(), "a", policy, time.Now())
	if len(state.consumed) != 2 || state.consumed[0] != state.consumed[1] {
		t.Fatalf("retry must reuse the redeem id: %v", state.consumed)
	}
	if saved, _ = gw.store.Get("a"); saved.ResetCreditPlan.Pending != nil || saved.ResetCreditPlan.LastResult != "reset" {
		t.Fatalf("plan=%+v", saved.ResetCreditPlan)
	}
}

// 周额度剩余高于上限时暂缓，不建立未决消费；策略未下发给本实例时不执行。
func TestResetCreditAutomationWeeklyGateAndDesignation(t *testing.T) {
	state := &whamServer{expiresAt: time.Now().Add(5 * time.Minute).UTC().Format(time.RFC3339)}
	gw := autoResetServer(t, state)
	limit := 10
	gw.reconcileResetCredit(context.Background(), "a", &ResetCreditPolicy{Enabled: true, LeadMinutes: 10, MaxWeeklyRemainingPercent: &limit}, time.Now())
	saved, _ := gw.store.Get("a")
	if len(state.consumed) != 0 || saved.ResetCreditPlan.Pending != nil || saved.ResetCreditPlan.LastResult != "weekly_quota_above_threshold" {
		t.Fatalf("weekly gate: consumed=%v plan=%+v", state.consumed, saved.ResetCreditPlan)
	}
	other := &whamServer{expiresAt: time.Now().Add(5 * time.Minute).UTC().Format(time.RFC3339)}
	gw = autoResetServer(t, other)
	gw.runtime.setResetCredit(&ResetCreditPolicy{Enabled: false, LeadMinutes: 10})
	gw.runResetCreditAutomation(context.Background(), time.Now())
	if len(other.consumed) != 0 {
		t.Fatal("an instance without the designated policy must not consume")
	}
}
