package codexgateway

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestOAuthReauthorizePreservesSchedulingAndReadsNamespacedIdentity(t *testing.T) {
	claims := base64.RawURLEncoding.EncodeToString([]byte(`{"email":"test@example.test","https://api.openai.com/auth":{"chatgpt_account_id":"chatgpt-123","chatgpt_plan_type":"plus"}}`))
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil || r.Form.Get("code_verifier") == "" || r.Form.Get("grant_type") != "authorization_code" {
			t.Error("missing PKCE token exchange parameters")
			w.WriteHeader(400)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "fixture-access", "refresh_token": "fixture-refresh", "id_token": "header." + claims + ".signature", "expires_in": 3600})
	}))
	defer provider.Close()
	cfg := Config{DataDir: t.TempDir(), InternalToken: "secret", OAuthTokenURL: provider.URL}
	cfg.applyDefaults()
	server, err := NewServer(cfg)
	if err != nil {
		t.Fatal(err)
	}
	_, err = server.store.Upsert(Account{ID: "paused", Enabled: false, Paused: true, Groups: []string{"12"}, MaxConcurrency: 9, CredentialRevision: 3})
	if err != nil {
		t.Fatal(err)
	}
	started, err := server.oauthStartRequest(map[string]any{"draft_id": "reauth", "runtime_account_id": "paused"})
	if err != nil {
		t.Fatal(err)
	}
	session := server.oauthSessions[started["session_id"].(string)]
	body := map[string]any{"session_id": session.SessionID, "draft_id": "reauth", "callback": "http://localhost:1455/auth/callback?code=fixture&state=" + session.State, "expected_credential_revision": 3}
	_, err = server.oauthCompleteRequest(body)
	if err != nil {
		t.Fatal(err)
	}
	account, _ := server.store.Get("paused")
	if account.Enabled || !account.Paused || account.MaxConcurrency != 9 || len(account.Groups) != 1 {
		t.Fatalf("reauthorize changed scheduling: %+v", publicAccount(account))
	}
	if account.CredentialRevision != 4 || account.ChatGPTAccountID != "chatgpt-123" || account.Plan != "plus" || account.Email != "test@example.test" {
		t.Fatalf("unexpected identity: %+v", publicAccount(account))
	}
	if _, err := server.oauthCompleteRequest(body); err != nil {
		t.Fatal(err)
	}
	again, _ := server.store.Get("paused")
	if again.CredentialRevision != 4 {
		t.Fatal("duplicate completion changed revision")
	}
}

func TestOAuthStartPersistsProtectedSession(t *testing.T) {
	dir := t.TempDir()
	cfg := Config{DataDir: dir, InternalToken: "secret"}
	cfg.applyDefaults()
	server, err := NewServer(cfg)
	if err != nil {
		t.Fatal(err)
	}
	result, err := server.oauthStartRequest(map[string]any{"draft_id": "draft_1", "runtime_account_id": "acct_1", "idempotency_key": "idem_1"})
	if err != nil {
		t.Fatal(err)
	}
	if result["session_id"] == "" || !strings.Contains(result["auth_url"].(string), "code_challenge") {
		t.Fatalf("unexpected OAuth result: %#v", result)
	}
	info, err := os.Stat(filepath.Join(dir, "oauth-sessions.json"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("session file mode=%o", info.Mode().Perm())
	}
}
