package codexgateway

import (
	"crypto/ecdh"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"os"
	"testing"
)

func TestCustodyKeyPersistsAndOnlyItsInstanceOpensTheBundle(t *testing.T) {
	s, httpServer, cfg := newBPSExecuteServer(t, "http://127.0.0.1:1")
	public := s.custodyPublicKey()
	if len(public) != 43 {
		t.Fatalf("public key=%q", public)
	}
	again, err := loadCustodyKey(cfg.DataDir)
	if err != nil || again.PublicKey().Equal(s.custodyKey.PublicKey()) == false {
		t.Fatalf("custody key must persist across restarts: %v", err)
	}
	bundle := credentialBundle{AccessToken: "at_x", RefreshToken: "rt_x", IDToken: "id_x", BPSAccessToken: "bps_at", BPSRefreshToken: "bps_rt"}
	sealed, err := sealCustodyBundle(s.custodyKey.PublicKey(), s.cfg.InstanceID, "acct_x", 0, 0, bundle)
	if err != nil {
		t.Fatal(err)
	}
	if opened, err := s.openCustodyBundle(sealed, "acct_x", 0, 0); err != nil || opened != bundle {
		t.Fatalf("opened=%+v err=%v", opened, err)
	}
	// 换账号、换实例都打不开
	if _, err := s.openCustodyBundle(sealed, "acct_y", 0, 0); err == nil {
		t.Fatal("bundle must be bound to the account")
	}
	// 代次也绑定在附加认证数据里：元数据代次被改就解不开
	if _, err := s.openCustodyBundle(sealed, "acct_x", 1, 0); err == nil {
		t.Fatal("bundle must be bound to the account")
	}
	other, _ := loadCustodyKey(t.TempDir())
	foreign, _ := sealCustodyBundle(other.PublicKey(), s.cfg.InstanceID, "acct_x", 0, 0, bundle)
	if _, err := s.openCustodyBundle(foreign, "acct_x", 0, 0); err == nil {
		t.Fatal("bundle sealed for another instance must not open")
	}
	// 导入接口接受 custody_bundle：令牌写入本地账号，BPS 令牌随之导入
	response, out := signedInternal(t, cfg, http.MethodPost, httpServer.URL+"/internal/v1/accounts/acct_x/import", map[string]any{
		"account":        map[string]any{"id": "acct_x", "enabled": true, "auth_type": "oauth", "groups": []string{"1"}},
		"custody_bundle": sealed,
	})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("import status=%d out=%v", response.StatusCode, out)
	}
	saved, _ := s.store.Get("acct_x")
	if saved.AccessToken != "at_x" || saved.RefreshToken != "rt_x" || saved.BPS == nil || saved.BPS.RefreshToken != "bps_rt" {
		t.Fatalf("saved=%+v", saved)
	}
	// 本地已有更高代次时拒绝回退；封装代次与元数据不符时解不开
	_, _ = s.store.Upsert(Account{ID: "acct_z", Enabled: true, AccessToken: "local", CredentialRevision: 5, Groups: []string{"1"}})
	older, _ := sealCustodyBundle(s.custodyKey.PublicKey(), s.cfg.InstanceID, "acct_z", 3, 0, bundle)
	response, out = signedInternal(t, cfg, http.MethodPost, httpServer.URL+"/internal/v1/accounts/acct_z/import", map[string]any{
		"account":        map[string]any{"id": "acct_z", "credential_revision": 3},
		"custody_bundle": older,
	})
	if response.StatusCode != http.StatusConflict || out["error"].(map[string]any)["code"] != "credential_revision_stale" {
		t.Fatalf("regression status=%d out=%v", response.StatusCode, out)
	}
	mismatched, _ := sealCustodyBundle(s.custodyKey.PublicKey(), s.cfg.InstanceID, "acct_z", 6, 0, bundle)
	response, _ = signedInternal(t, cfg, http.MethodPost, httpServer.URL+"/internal/v1/accounts/acct_z/import", map[string]any{
		"account":        map[string]any{"id": "acct_z", "credential_revision": 7},
		"custody_bundle": mismatched,
	})
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("revision mismatch must not open: status=%d", response.StatusCode)
	}
	response, out = signedInternal(t, cfg, http.MethodPost, httpServer.URL+"/internal/v1/accounts/acct_y/import", map[string]any{
		"account":        map[string]any{"id": "acct_y"},
		"custody_bundle": foreign,
	})
	if response.StatusCode != http.StatusBadRequest || out["error"].(map[string]any)["code"] != "custody_bundle_invalid" {
		t.Fatalf("foreign bundle status=%d out=%v", response.StatusCode, out)
	}
}

// 控制面（JS）封装的共享夹具：两端格式逐字节一致
func TestCustodyAndCredentialBundlesFromTheControlPlaneOpen(t *testing.T) {
	raw, err := os.ReadFile("../../../test/fixtures/executor-contract/custody.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		InstanceID       string           `json:"instance_id"`
		AccountID        string           `json:"account_id"`
		PrivateKey       string           `json:"private_key"`
		PublicKey        string           `json:"public_key"`
		Bundle           credentialBundle `json:"bundle"`
		CustodyBundle    string           `json:"custody_bundle"`
		BundleKey        string           `json:"bundle_key"`
		CredentialBundle string           `json:"credential_bundle"`
		Revisions        struct {
			Credential    int64 `json:"credential_revision"`
			BPSGeneration int64 `json:"bps_generation"`
		} `json:"revisions"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	key, _ := base64.RawURLEncoding.DecodeString(fixture.PrivateKey)
	private, err := ecdh.X25519().NewPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{cfg: Config{InstanceID: fixture.InstanceID, CredentialBundleKey: fixture.BundleKey}, custodyKey: private}
	if s.custodyPublicKey() != fixture.PublicKey {
		t.Fatalf("public key mismatch")
	}
	if opened, err := s.openCustodyBundle(fixture.CustodyBundle, fixture.AccountID, fixture.Revisions.Credential, fixture.Revisions.BPSGeneration); err != nil || opened != fixture.Bundle {
		t.Fatalf("custody opened=%+v err=%v", opened, err)
	}
	if opened, err := s.openCredentialBundle(fixture.CredentialBundle, fixture.AccountID); err != nil || opened != fixture.Bundle {
		t.Fatalf("credential opened=%+v err=%v", opened, err)
	}
}
