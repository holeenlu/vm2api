package codexgateway

import (
	"net/http/httptest"
	"testing"
)

// 新授权遵守控制面给出的凭据代次下限（授权、导入时控制面传入 min_credential_revision / min_bps_token_generation）
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
