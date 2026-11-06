package codexgateway

import (
	"net/http"
	"testing"
)

// 控制面永久删除账号：DELETE 移除账号与凭据并落盘，重启后不复现；再次删除明确回答 account_not_found
func TestDeleteAccountRemovesCredentialsAndPersists(t *testing.T) {
	cfg := Config{InternalToken: "secret", CredentialBundleKey: "bundle-key", InstanceID: "gw-1"}
	s, httpServer, cfg := newBPSExecuteServerWithConfig(t, cfg)
	if _, err := s.store.Upsert(account("acct", "tok_delete_me")); err != nil {
		t.Fatal(err)
	}
	if _, err := s.store.Upsert(account("other", "tok_keep")); err != nil {
		t.Fatal(err)
	}
	response, out := signedInternal(t, s.cfg, http.MethodDelete, httpServer.URL+"/internal/v1/accounts/acct", nil)
	if response.StatusCode != http.StatusOK || out["ok"] != true || out["deleted"] != "acct" {
		t.Fatalf("status=%d out=%v", response.StatusCode, out)
	}
	if _, ok := s.store.Get("acct"); ok {
		t.Fatal("deleted account is still in the store")
	}
	reopened, err := OpenSealedStore(cfg.AccountsPath(), cfg.CredentialBundleKey)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := reopened.Get("acct"); ok {
		t.Fatal("deleted account came back after reopening the store")
	}
	if kept, ok := reopened.Get("other"); !ok || kept.AccessToken != "tok_keep" {
		t.Fatalf("other account must stay: %+v", publicAccount(kept))
	}
	response, out = signedInternal(t, s.cfg, http.MethodDelete, httpServer.URL+"/internal/v1/accounts/acct", nil)
	if response.StatusCode != http.StatusNotFound || out["error"].(map[string]any)["code"] != "account_not_found" {
		t.Fatalf("second delete status=%d out=%v", response.StatusCode, out)
	}
}
