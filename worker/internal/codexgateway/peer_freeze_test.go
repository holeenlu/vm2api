package codexgateway

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// 其他 Worker 冻结的账号经心跳策略下发后本实例不再选用；集合中移除后恢复。本实例冻结随心跳上报。
func TestPeerFreezesFromHeartbeatPauseAccounts(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		_, _ = io.WriteString(w, `{"id":"resp_1"}`)
	}))
	defer upstream.Close()
	server, httpServer, cfg := newExecuteServer(t, upstream.URL, Account{ID: "a", Enabled: true, AccessToken: "tok", Groups: []string{"1"}})
	run := func(nonce string) int {
		response := signedExecute(t, cfg, httpServer.URL, Envelope{Dispatch: "d_" + nonce, RequestID: "r_" + nonce, Nonce: nonce, Operation: "responses", Protocol: "openai.responses", Model: "gpt-test", Body: json.RawMessage(`{"model":"gpt-test"}`), Scope: Scope{GroupIDs: []int64{1}}})
		response.Body.Close()
		return response.StatusCode
	}
	until := time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano)
	server.applyHeartbeatPolicy([]byte(`{"ok":true,"policy":{"account_freezes":[{"account_id":"a","frozen_until":"` + until + `","reason":"rule","source_instance":"gw_other"}]}}`))
	if account, _ := server.store.Get("a"); account.PeerFreeze == nil || account.PeerFreeze.Source != "gw_other" {
		t.Fatalf("peer freeze not applied: %+v", account.PeerFreeze)
	}
	if status := run("peer1"); status == http.StatusOK {
		t.Fatal("peer-frozen account still served the request")
	}
	server.applyHeartbeatPolicy([]byte(`{"ok":true,"policy":{"account_freezes":[]}}`))
	if status := run("peer2"); status != http.StatusOK {
		t.Fatalf("account not released after the peer freeze cleared: %d", status)
	}
	// 心跳未携带 account_freezes（旧控制面）时不改动
	server.applyHeartbeatPolicy([]byte(`{"ok":true,"policy":{"account_freezes":[{"account_id":"a","frozen_until":"` + until + `","source_instance":"gw_other"}]}}`))
	server.applyHeartbeatPolicy([]byte(`{"ok":true,"policy":{}}`))
	if account, _ := server.store.Get("a"); account.PeerFreeze == nil {
		t.Fatal("policy without account_freezes must keep the current set")
	}

	policy := &ProtectionPolicy{Enabled: true, Threshold: 1, WindowMs: 60000, DurationMs: 60000, Fingerprint: "fp"}
	server.store.RecordProtectionFailure("a", policy, []ProtectionMatch{{ID: "r", Name: "rule-a"}}, time.Now())
	local := server.store.localFreezes(time.Now())
	if len(local) != 1 || local[0]["account_id"] != "a" || local[0]["reason"] != "rule-a" {
		t.Fatalf("local freezes=%v", local)
	}
}
