package codexgateway

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
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
	// 旧凭据已被判过期：终态、刷新失败诊断与旧代次 Cookie 都不能带进新凭据
	_, err = server.store.Upsert(Account{ID: "paused", Enabled: false, Paused: true, Groups: []string{"12"}, MaxConcurrency: 9, CredentialRevision: 3,
		CredentialState: "expired", LastError: "credential_expired", LastRefreshFailure: &RefreshFailure{Operation: "refresh", Code: "refresh_token_expired"},
		Cookies: []StoredCookie{{Name: "__cf_bm", Value: "old", Domain: "chatgpt.com", Path: "/"}}})
	if err != nil {
		t.Fatal(err)
	}
	started, err := server.oauthStartRequest(map[string]any{"draft_id": "reauth", "runtime_account_id": "paused", "session": testOAuthSession()})
	if err != nil {
		t.Fatal(err)
	}
	session := started["session"].(OAuthSession)
	body := map[string]any{"session": session, "session_id": session.SessionID, "draft_id": "reauth", "callback": "http://localhost:1455/auth/callback?code=fixture&state=" + session.State, "expected_credential_revision": 3}
	_, err = server.oauthCompleteRequest(body)
	if err != nil {
		t.Fatal(err)
	}
	account, _ := server.store.Get("paused")
	if account.Enabled || !account.Paused || account.MaxConcurrency != 9 || len(account.Groups) != 1 {
		t.Fatalf("reauthorize changed scheduling: %+v", publicAccount(account))
	}
	if account.CredentialState != "" || account.LastRefreshFailure != nil || account.Cookies != nil || !credentialUsable(account, time.Now()) {
		t.Fatalf("reauthorize kept stale credential state: %+v", account)
	}
	if states := server.store.credentialStates(); len(states) != 0 {
		t.Fatalf("heartbeat still reports stale credential state: %+v", states)
	}
	if account.CredentialRevision != 4 || account.ChatGPTAccountID != "chatgpt-123" || account.Plan != "plus" || account.Email != "test@example.test" {
		t.Fatalf("unexpected identity: %+v", publicAccount(account))
	}
	// 重复完成由控制面按草稿串行并缓存结果；即使重复到达 Worker，期望代次已过时也会被拒绝，不会再推进代次
	if _, err := server.oauthCompleteRequest(body); err == nil || !strings.Contains(err.Error(), "revision conflict") {
		t.Fatalf("duplicate completion err=%v", err)
	}
	again, _ := server.store.Get("paused")
	if again.CredentialRevision != 4 {
		t.Fatal("duplicate completion changed revision")
	}
}

// testOAuthSession 模拟控制面生成的授权会话（P3.7）
func testOAuthSession() map[string]any {
	state, _ := randomURLToken(32)
	verifier, _ := randomURLToken(32)
	id, _ := randomURLToken(18)
	return map[string]any{"session_id": id, "state": state, "code_verifier": verifier, "expires_at": time.Now().Add(10 * time.Minute).UTC().Format(time.RFC3339Nano)}
}

// 授权会话由控制面提供，Worker 不落盘；旧版本留下的会话文件在启动时删除
func TestOAuthSessionComesFromTheControlPlaneAndIsNotPersisted(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "oauth-sessions.json"), []byte(`{"old":{"code_verifier":"secret"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := Config{DataDir: dir, InternalToken: "secret"}
	cfg.applyDefaults()
	server, err := NewServer(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "oauth-sessions.json")); !os.IsNotExist(err) {
		t.Fatal("the legacy session file must be removed")
	}
	if _, err := server.oauthStartRequest(map[string]any{"draft_id": "draft_1", "runtime_account_id": "acct_1"}); err == nil {
		t.Fatal("a session must be supplied by the control plane")
	}
	supplied := testOAuthSession()
	result, err := server.oauthStartRequest(map[string]any{"draft_id": "draft_1", "runtime_account_id": "acct_1", "session": supplied})
	if err != nil {
		t.Fatal(err)
	}
	session := result["session"].(OAuthSession)
	if result["session_id"] != supplied["session_id"] || session.InstallationID == "" || session.DraftID != "draft_1" || !strings.Contains(result["auth_url"].(string), "code_challenge") {
		t.Fatalf("unexpected OAuth result: %#v", result)
	}
	if _, err := os.Stat(filepath.Join(dir, "oauth-sessions.json")); !os.IsNotExist(err) {
		t.Fatal("sessions must not be persisted by the Worker")
	}
	// 过期会话与篡改的 state 被拒绝
	session.ExpiresAt = time.Now().Add(-time.Second)
	if _, err := server.oauthCompleteRequest(map[string]any{"session": session, "callback": "http://localhost:1455/auth/callback?code=c&state=" + session.State}); err == nil {
		t.Fatal("expired session must be rejected")
	}
	session.ExpiresAt = time.Now().Add(time.Minute)
	if _, err := server.oauthCompleteRequest(map[string]any{"session": session, "callback": "http://localhost:1455/auth/callback?code=c&state=wrong"}); err == nil || !strings.Contains(err.Error(), "state mismatch") {
		t.Fatalf("state mismatch err=%v", err)
	}
}

// 授权 URL 与回调对齐 CPR：127.0.0.1 回调、两个 stable_id、内外层 streamlined；回调必须带 code 与 state 的完整 URL。
func TestOAuthURLAndCallbackValidation(t *testing.T) {
	cfg := Config{DataDir: t.TempDir(), InternalToken: "secret"}
	cfg.applyDefaults()
	session := OAuthSession{State: "st", CodeVerifier: "v", InstallationID: "11111111-2222-4333-8444-555555555555"}
	outer, _ := url.Parse(oauthURL(cfg, session, "26.1.0"))
	inner, _ := url.Parse(outer.Query().Get("authorize_url"))
	query := inner.Query()
	if query.Get("redirect_uri") != "http://127.0.0.1:1455/auth/callback" || query.Get("codex_app_version") != "26.1.0" || query.Get("codex_streamlined_login") != "true" {
		t.Fatalf("inner=%v", query)
	}
	if stable := query.Get("source_surface_stable_id"); stable == "" || stable != query.Get("codex_origin_stable_id") || stable != oauthStableID(session.InstallationID) || stable[14] != '4' {
		t.Fatalf("stable ids=%v", query)
	}
	if outer.Query().Get("codex_streamlined_login") != "true" {
		t.Fatalf("outer=%v", outer.Query())
	}
	for _, bad := range []string{"fixture", "?code=a&state=b", "http://127.0.0.1/cb?code=a", "http://127.0.0.1/cb?code=a&code=b&state=s"} {
		if _, _, err := parseOAuthCallback(bad); err == nil {
			t.Errorf("callback %q must be rejected", bad)
		}
	}
	if code, state, err := parseOAuthCallback("http://127.0.0.1:1455/auth/callback?code=c&state=s"); err != nil || code != "c" || state != "s" {
		t.Fatalf("code=%q state=%q err=%v", code, state, err)
	}
}
