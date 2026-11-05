package codexgateway

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func testProtectionPolicy() *ProtectionPolicy {
	return &ProtectionPolicy{
		Enabled: true, Threshold: 2, WindowMs: 600_000, DurationMs: 7_200_000, ProbeEnabled: true,
		ProbeModel:  strPtr("gpt-probe"),
		Fingerprint: "fp1",
		Rules: []ProtectionRule{{ID: "r1", Name: "账号风控", Conditions: []ProtectionCondition{
			{Field: "status", Operator: "equals", Values: []*string{strPtr("400")}},
			{Field: "message", Operator: "contains", Values: []*string{strPtr("ACCOUNT FLAGGED")}, IgnoreCase: true},
		}}},
	}
}

func runProtected(t *testing.T, cfg Config, url string, policy *ProtectionPolicy, body string) (*http.Response, []byte) {
	t.Helper()
	n := nonceSeq.Add(1)
	response := signedExecute(t, cfg, url, Envelope{Dispatch: fmt.Sprintf("d_%d", n), RequestID: fmt.Sprintf("r_%d", n), Nonce: fmt.Sprintf("n_%d", n), Operation: "responses", Protocol: "openai.responses", Model: "gpt-test", Body: json.RawMessage(body), Scope: Scope{GroupIDs: []int64{1}}, AccountProtection: policy})
	data, _ := io.ReadAll(response.Body)
	response.Body.Close()
	return response, data
}

func TestProtectionRuleMatching(t *testing.T) {
	policy := testProtectionPolicy()
	hit := upstreamFailure{Status: 400, Message: "your account flagged for review"}
	if got := policy.matchingRules(hit); len(got) != 1 || got[0].ID != "r1" {
		t.Fatalf("expected match, got %v", got)
	}
	if got := policy.matchingRules(upstreamFailure{Status: 401, Message: "account flagged"}); len(got) != 0 {
		t.Fatalf("status mismatch should not match: %v", got)
	}
	// message 只看前 8 KiB
	late := upstreamFailure{Status: 400, Message: strings.Repeat("x", protectionMessagePrefixBytes) + "account flagged"}
	if got := policy.matchingRules(late); len(got) != 0 {
		t.Fatalf("match beyond 8 KiB prefix: %v", got)
	}
	// equals null 匹配缺失字段
	missing := &ProtectionPolicy{Enabled: true, Rules: []ProtectionRule{{ID: "n", Name: "n", Conditions: []ProtectionCondition{
		{Field: "status", Operator: "equals", Values: []*string{strPtr("500")}},
		{Field: "code", Operator: "equals", Values: []*string{nil}},
	}}}}
	if len(missing.matchingRules(upstreamFailure{Status: 500})) != 1 || len(missing.matchingRules(upstreamFailure{Status: 500, Code: "x"})) != 0 {
		t.Fatal("null equals should only match a missing field")
	}
	if !protectionCountable([]byte(`{"model":"m"}`)) || protectionCountable([]byte(`{"generate":false}`)) || protectionCountable([]byte(`{"client_metadata":{"request_kind":"prewarm"}}`)) {
		t.Fatal("prewarm requests must not count")
	}
}

func TestProtectionFreezesAccountThenProbeRecovers(t *testing.T) {
	flagged := jsonReply(400, `{"error":{"type":"invalid_request_error","message":"Account flagged"}}`)
	upstream, server := newScriptedUpstream(t, map[string][]func(http.ResponseWriter){
		"tok_a": {flagged, jsonReply(200, okResponse), flagged, flagged, flagged, jsonReply(500, `{}`), sseReply(`{"type":"response.completed","response":{"id":"resp_probe"}}`)},
	})
	gw, httpServer, cfg := newExecuteServer(t, server.URL, account("a", "tok_a"))
	policy := testProtectionPolicy()

	runProtected(t, cfg, httpServer.URL, policy, `{"model":"gpt-test"}`)
	// 完整成功清除未冻结证据
	if response, _ := runProtected(t, cfg, httpServer.URL, policy, `{"model":"gpt-test"}`); response.StatusCode != 200 {
		t.Fatalf("status=%d", response.StatusCode)
	}
	if a, _ := gw.store.Get("a"); a.Protection == nil || a.Protection.Count != 0 {
		t.Fatalf("success should clear evidence: %+v", a.Protection)
	}
	// 预热失败不计数
	runProtected(t, cfg, httpServer.URL, policy, `{"model":"gpt-test","generate":false}`)
	if a, _ := gw.store.Get("a"); a.Protection.Count != 0 {
		t.Fatalf("prewarm counted: %+v", a.Protection)
	}
	runProtected(t, cfg, httpServer.URL, policy, `{"model":"gpt-test"}`)
	runProtected(t, cfg, httpServer.URL, policy, `{"model":"gpt-test"}`)
	a, _ := gw.store.Get("a")
	if !protectionFrozen(a, time.Now()) || !a.Protection.RequiresProbe || a.Protection.ProbeModel != "gpt-probe" || len(a.Protection.Rules) != 1 {
		t.Fatalf("account should be frozen: %+v", a.Protection)
	}
	calls := upstream.count("tok_a")
	if response, _ := runProtected(t, cfg, httpServer.URL, policy, `{"model":"gpt-test"}`); response.Header.Get(sendStateHeader) != sendStateNotSent || upstream.count("tok_a") != calls {
		t.Fatalf("frozen account must not be selected: send=%s", response.Header.Get(sendStateHeader))
	}

	// 未到期不探测；到期后探测失败顺延，再次探测成功解冻
	gw.recoverDueFreezes(context.Background(), time.Now())
	if upstream.count("tok_a") != calls {
		t.Fatal("probe ran before the freeze expired")
	}
	expire := func() {
		gw.store.mu.Lock()
		account := gw.store.accounts["a"]
		state := *account.Protection
		state.FrozenUntil = time.Now().Add(-time.Second)
		account.Protection = &state
		gw.store.accounts["a"] = account
		gw.store.mu.Unlock()
	}
	expire()
	if !protectionFrozen(mustGet(t, gw, "a"), time.Now()) {
		t.Fatal("expired freeze must wait for a successful probe")
	}
	gw.recoverDueFreezes(context.Background(), time.Now())
	a = mustGet(t, gw, "a")
	if !a.Protection.FrozenUntil.After(time.Now().Add(time.Hour)) || a.Protection.LastProbeError == "" {
		t.Fatalf("failed probe should postpone the freeze: %+v", a.Protection)
	}
	expire()
	gw.recoverDueFreezes(context.Background(), time.Now())
	a = mustGet(t, gw, "a")
	if protectionFrozen(a, time.Now()) || a.Protection.Count != 0 || strings.HasPrefix(a.LastError, "error_protection") {
		t.Fatalf("successful probe should unfreeze: %+v last_error=%q", a.Protection, a.LastError)
	}
}

func TestProtectionManualRecoverAndCredentialRevision(t *testing.T) {
	gw, _, _ := newExecuteServer(t, "http://127.0.0.1:1", account("a", "tok_a"))
	policy := testProtectionPolicy()
	failure := upstreamFailure{Status: 400, Message: "account flagged"}
	for i := 0; i < 2; i++ {
		gw.store.RecordProtectionFailure("a", policy, policy.matchingRules(failure), time.Now())
	}
	if !protectionFrozen(mustGet(t, gw, "a"), time.Now()) {
		t.Fatal("expected freeze")
	}
	if err := gw.store.Recover("a"); err != nil {
		t.Fatal(err)
	}
	if protectionFrozen(mustGet(t, gw, "a"), time.Now()) {
		t.Fatal("manual recover should clear the freeze")
	}
	for i := 0; i < 2; i++ {
		gw.store.RecordProtectionFailure("a", policy, policy.matchingRules(failure), time.Now())
	}
	gw.store.mu.Lock()
	account := gw.store.accounts["a"]
	account.CredentialRevision++
	gw.store.accounts["a"] = account
	gw.store.mu.Unlock()
	if protectionFrozen(mustGet(t, gw, "a"), time.Now()) {
		t.Fatal("a new credential revision starts a new protection epoch")
	}
}

func mustGet(t *testing.T, gw *Server, id string) Account {
	t.Helper()
	account, ok := gw.store.Get(id)
	if !ok {
		t.Fatalf("account %s missing", id)
	}
	return account
}
