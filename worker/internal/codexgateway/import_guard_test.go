package codexgateway

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// 投影不得回退本地凭据（R3 复审 N1）：共享凭据包同样拒绝更低的凭据代次；本地 BPS 令牌代次更高时保留本地 BPS 令牌
func TestImportNeverRegressesLocalCredentials(t *testing.T) {
	cfg := Config{InternalToken: "secret", CredentialBundleKey: "bundle-key", InstanceID: "gw-1"}
	s, httpServer, _ := newBPSExecuteServerWithConfig(t, cfg)
	local := bpsAccount("acct", "tok_local")
	local.CredentialRevision = 5
	local.BPS.TokenGeneration = 7
	local.BPS.RefreshToken = "bps_rt_newest"
	_, _ = s.store.Upsert(local)
	stale := local
	stale.AccessToken, stale.RefreshToken, stale.CredentialRevision = "tok_old", "rt_old", 4
	bundle, _ := s.sealCredentialBundle(stale)
	response, out := signedInternal(t, s.cfg, http.MethodPost, httpServer.URL+"/internal/v1/accounts/acct/import", map[string]any{
		"account":           map[string]any{"id": "acct", "credential_revision": 4},
		"credential_bundle": bundle,
	})
	if response.StatusCode != http.StatusConflict || out["error"].(map[string]any)["code"] != "credential_revision_stale" {
		t.Fatalf("status=%d out=%v", response.StatusCode, out)
	}
	// 拒绝时报告本地代次，控制面据此改以本实例为投影来源（R3 复审 M1）
	if account, _ := out["account"].(map[string]any); account == nil || account["credential_revision"] != float64(5) {
		t.Fatalf("stale rejection must report the local revision: %v", out)
	}
	// 原生代次更新、BPS 令牌代次更旧：原生令牌采用投影，BPS 令牌保留本地
	newer := local
	newer.AccessToken, newer.RefreshToken, newer.CredentialRevision = "tok_new", "rt_new", 6
	newer.BPS = &BPSGrant{AccessToken: "bps_old", RefreshToken: "bps_rt_old", Revision: local.BPS.Revision, TokenGeneration: 6}
	bundle, _ = s.sealCredentialBundle(newer)
	response, out = signedInternal(t, s.cfg, http.MethodPost, httpServer.URL+"/internal/v1/accounts/acct/import", map[string]any{
		"account":           map[string]any{"id": "acct", "credential_revision": 6, "bps": map[string]any{"revision": local.BPS.Revision, "token_generation": 6}},
		"credential_bundle": bundle,
	})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status=%d out=%v", response.StatusCode, out)
	}
	saved, _ := s.store.Get("acct")
	if saved.AccessToken != "tok_new" || saved.CredentialRevision != 6 || saved.BPS.RefreshToken != "bps_rt_newest" || saved.BPS.TokenGeneration != 7 {
		t.Fatalf("saved=%+v bps=%+v", publicAccount(saved), saved.BPS)
	}
}

// 新授权的代次取 max(本地, 控制面下限)+1，不与其他实例刷新出的代次撞号（R3 复审 N2）
func TestNewGrantsRespectTheControlPlaneRevisionFloor(t *testing.T) {
	cfg := Config{InternalToken: "secret", InstanceID: "gw-1"}
	s, _, _ := newBPSExecuteServerWithConfig(t, cfg)
	native := account("acct", "tok")
	native.CredentialRevision = 2
	native.ChatGPTAccountID = "chatgpt-acct"
	_, _ = s.store.Upsert(native)
	access, identity := excelTokens("chatgpt-acct", "user-acct", "acct@example.com", "pro")
	tokens := bpsTokens{AccessToken: access, IDToken: identity, RefreshToken: "bps_rt", ChatGPTAccountID: "chatgpt-acct"}
	if _, err := s.saveBPSGrant("acct", tokens, -1, 9); err != nil {
		t.Fatal(err)
	}
	saved, _ := s.store.Get("acct")
	if saved.BPS.TokenGeneration != 10 {
		t.Fatalf("token generation=%d, want floor+1", saved.BPS.TokenGeneration)
	}
}

func newBPSExecuteServerWithConfig(t *testing.T, cfg Config) (*Server, *httptest.Server, Config) {
	t.Helper()
	cfg.DataDir = t.TempDir()
	cfg.applyDefaults()
	server, err := NewServer(cfg)
	if err != nil {
		t.Fatal(err)
	}
	httpServer := httptest.NewServer(server.Handler())
	t.Cleanup(httpServer.Close)
	return server, httpServer, cfg
}
