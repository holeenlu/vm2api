package codexgateway

import (
	"strings"
	"testing"
	"time"
)

func TestRecoverClearsCooldownWithoutResumingPausedAccount(t *testing.T) {
	store, err := OpenStore(t.TempDir() + "/accounts.json")
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.Upsert(Account{ID: "paused", Enabled: false, Paused: true, CooldownUntil: time.Now().Add(time.Hour), LastError: "upstream_capacity"})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Recover("paused"); err != nil {
		t.Fatal(err)
	}
	account, _ := store.Get("paused")
	if account.Enabled || !account.Paused || !account.CooldownUntil.IsZero() || account.LastError != "" {
		t.Fatalf("unexpected recovered account: %+v", publicAccount(account))
	}
}

func TestStoreCASAndRPMAdmission(t *testing.T) {
	store, err := OpenStore(t.TempDir() + "/accounts.json")
	if err != nil {
		t.Fatal(err)
	}
	account := Account{ID: "acct", Enabled: true, MaxConcurrency: 2, MaxRPM: 1, Groups: []string{"1"}, Models: []string{"gpt-test"}, CredentialRevision: 1}
	if _, err := store.Upsert(account); err != nil {
		t.Fatal(err)
	}
	if _, err := store.UpsertCAS(Account{ID: "acct", Enabled: true, CredentialRevision: 2}, 0); err == nil || !strings.Contains(err.Error(), "credential revision conflict") {
		t.Fatalf("expected CAS conflict, got %v", err)
	}
	if _, err := store.Select(Scope{GroupIDs: []int64{1}, Model: "gpt-test"}, "gpt-test", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Select(Scope{GroupIDs: []int64{1}, Model: "gpt-test"}, "gpt-test", nil); err == nil {
		t.Fatal("expected RPM admission to reject the second request")
	}
}
