package codexgateway

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	oauthSessionTTL = 10 * time.Minute
	// oauthClaimTTL：同一会话的完成请求互斥认领时长（CPR 90s claim），失败时释放
	oauthClaimTTL = 90 * time.Second
	// oauthCallbackMaxBytes：回调 URL 上限（CPR 16KiB）
	oauthCallbackMaxBytes = 16 << 10
)

type OAuthSession struct {
	SessionID        string         `json:"session_id"`
	State            string         `json:"state"`
	CodeVerifier     string         `json:"code_verifier"`
	DraftID          string         `json:"draft_id,omitempty"`
	AccountResource  string         `json:"account_resource_id,omitempty"`
	RuntimeAccountID string         `json:"runtime_account_id,omitempty"`
	ProxyURL         string         `json:"proxy_url,omitempty"`
	IdempotencyKey   string         `json:"idempotency_key,omitempty"`
	Status           string         `json:"status"`
	ExpiresAt        time.Time      `json:"expires_at"`
	Result           map[string]any `json:"result,omitempty"`
	// InstallationID 是该次授权绑定的账号安装身份：重授权沿用账号原值，新开户在开始时生成并在完成时写入账号
	InstallationID string `json:"installation_id,omitempty"`
	// ClaimedUntil 是完成请求的互斥认领截止
	ClaimedUntil time.Time `json:"claimed_until,omitempty"`
}

func randomURLToken(size int) (string, error) {
	buf := make([]byte, size)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// oauthStableID 是授权 URL 的 source_surface_stable_id / codex_origin_stable_id（CPR credential/oauth.rs）：
// sha256("openai/codex-desktop/surface-stable-id/v1\0" ‖ 安装 UUID 的 16 字节) 取前 16 字节并按 UUIDv4 置位。
func oauthStableID(installationID string) string {
	raw, err := hex.DecodeString(strings.ReplaceAll(installationID, "-", ""))
	if err != nil || len(raw) != 16 {
		return ""
	}
	sum := sha256.Sum256(append([]byte("openai/codex-desktop/surface-stable-id/v1\x00"), raw...))
	b := sum[:16]
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// oauthAppVersion：授权 URL 的 codex_app_version 取运行时 Desktop 画像的版本（CPR profile.desktop_version），
// 画像不可用时回退配置值。
func (s *Server) oauthAppVersion() string {
	if version := s.globalProfile().DesktopVersion; version != "" {
		return version
	}
	if profile, err := s.resolveProfile(nil, ProfileDeployment{}); err == nil && profile.DesktopVersion != "" {
		return profile.DesktopVersion
	}
	return s.cfg.OAuthAppVersion
}

func (s *Server) oauthURL(session OAuthSession) string {
	return oauthURL(s.cfg, session, s.oauthAppVersion())
}

func oauthURL(cfg Config, session OAuthSession, appVersion string) string {
	challenge := sha256.Sum256([]byte(session.CodeVerifier))
	inner, err := url.Parse(cfg.OAuthAuthorizeURL)
	if err != nil {
		inner = &url.URL{Scheme: "https", Host: "auth.openai.com", Path: "/oauth/authorize"}
	}
	query := inner.Query()
	query.Set("response_type", "code")
	query.Set("client_id", cfg.ClientID)
	query.Set("redirect_uri", cfg.OAuthRedirectURI)
	query.Set("scope", cfg.OAuthScope)
	query.Set("code_challenge", base64.RawURLEncoding.EncodeToString(challenge[:]))
	query.Set("code_challenge_method", "S256")
	query.Set("id_token_add_organizations", "true")
	query.Set("codex_cli_simplified_flow", "true")
	query.Set("state", session.State)
	query.Set("originator", cfg.OAuthOriginator)
	query.Set("codex_app_version", appVersion)
	if stable := oauthStableID(session.InstallationID); stable != "" {
		query.Set("source_surface_stable_id", stable)
		query.Set("codex_origin_stable_id", stable)
	}
	query.Set("codex_streamlined_login", "true")
	inner.RawQuery = query.Encode()
	outer, err := url.Parse(cfg.OAuthDesktopAuthURL)
	if err != nil {
		return inner.String()
	}
	outerQuery := outer.Query()
	outerQuery.Set("authorize_url", inner.String())
	outerQuery.Set("codex_streamlined_login", "true")
	outerQuery.Set("no_universal_links", "1")
	outer.RawQuery = outerQuery.Encode()
	return outer.String()
}

// parseOAuthCallback 解析完整回调 URL（CPR）：必须是 URL，最多 16KiB，code 与 state 各恰好出现一次。
func parseOAuthCallback(raw string) (string, string, error) {
	text := strings.TrimSpace(raw)
	if text == "" || len(text) > oauthCallbackMaxBytes {
		return "", "", errors.New("a complete OAuth callback URL is required")
	}
	parsed, err := url.Parse(text)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", "", errors.New("a complete OAuth callback URL is required")
	}
	query := parsed.Query()
	if len(query["code"]) != 1 || len(query["state"]) != 1 {
		return "", "", errors.New("the OAuth callback must carry exactly one code and one state")
	}
	code, state := strings.TrimSpace(query.Get("code")), strings.TrimSpace(query.Get("state"))
	if code == "" || state == "" {
		return "", "", errors.New("the OAuth callback must carry exactly one code and one state")
	}
	return code, state, nil
}

func loadOAuthSessions(path string) (map[string]OAuthSession, error) {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return map[string]OAuthSession{}, nil
	}
	if err != nil {
		return nil, err
	}
	var sessions map[string]OAuthSession
	if err := json.Unmarshal(data, &sessions); err != nil {
		return nil, err
	}
	if sessions == nil {
		sessions = map[string]OAuthSession{}
	}
	now := time.Now()
	for id, session := range sessions {
		if !session.ExpiresAt.After(now) {
			delete(sessions, id)
		}
	}
	return sessions, nil
}

func saveOAuthSessions(path string, sessions map[string]OAuthSession) error {
	data, err := json.MarshalIndent(sessions, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(data, '\n'), 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

func (s *Server) oauthStartRequest(body map[string]any) (map[string]any, error) {
	state, err := randomURLToken(32)
	if err != nil {
		return nil, err
	}
	verifier, err := randomURLToken(32)
	if err != nil {
		return nil, err
	}
	sessionID, err := randomURLToken(18)
	if err != nil {
		return nil, err
	}
	accountResource := strings.TrimSpace(stringValue(body["account_resource_id"]))
	runtimeID := strings.TrimSpace(stringValue(body["runtime_account_id"]))
	if runtimeID == "" && accountResource != "" {
		runtimeID = "gwacct_" + accountResource
	}
	installation := newUUIDv4()
	if existing, ok := s.store.Get(runtimeID); ok && existing.InstallationID != "" {
		installation = existing.InstallationID
	}
	session := OAuthSession{SessionID: sessionID, State: state, CodeVerifier: verifier, DraftID: stringValue(body["draft_id"]), AccountResource: accountResource, RuntimeAccountID: runtimeID, ProxyURL: stringValue(body["proxy_url"]), IdempotencyKey: stringValue(body["idempotency_key"]), Status: "pending", ExpiresAt: time.Now().Add(oauthSessionTTL), InstallationID: installation}
	s.oauthMu.Lock()
	defer s.oauthMu.Unlock()
	for id, old := range s.oauthSessions {
		if !old.ExpiresAt.After(time.Now()) {
			delete(s.oauthSessions, id)
		}
		if session.IdempotencyKey != "" && old.IdempotencyKey == session.IdempotencyKey && old.Status == "pending" {
			return map[string]any{"session_id": old.SessionID, "auth_url": s.oauthURL(old), "expires_at": old.ExpiresAt.UTC().Format(time.RFC3339Nano), "draft_id": old.DraftID, "account_resource_id": old.AccountResource}, nil
		}
	}
	s.oauthSessions[sessionID] = session
	if err := saveOAuthSessions(s.cfg.OAuthSessionsPath(), s.oauthSessions); err != nil {
		return nil, err
	}
	stateHash := sha256.Sum256([]byte(session.State))
	return map[string]any{"session_id": sessionID, "auth_url": s.oauthURL(session), "expires_at": session.ExpiresAt.UTC().Format(time.RFC3339Nano), "draft_id": session.DraftID, "account_resource_id": session.AccountResource, "state_hash": fmt.Sprintf("%x", stateHash[:]), "flavor": "codex"}, nil
}

func (s *Server) oauthCompleteRequest(body map[string]any) (map[string]any, error) {
	sessionID := strings.TrimSpace(stringValue(body["session_id"]))
	if sessionID == "" {
		return nil, errors.New("session_id is required")
	}
	s.oauthMu.Lock()
	session, ok := s.oauthSessions[sessionID]
	if !ok || !session.ExpiresAt.After(time.Now()) {
		if ok {
			delete(s.oauthSessions, sessionID)
			_ = saveOAuthSessions(s.cfg.OAuthSessionsPath(), s.oauthSessions)
		}
		s.oauthMu.Unlock()
		return nil, errors.New("oauth session expired")
	}
	if session.Status == "completed" {
		result := session.Result
		s.oauthMu.Unlock()
		return result, nil
	}
	code, state, err := parseOAuthCallback(stringValue(body["callback"]))
	if err != nil {
		s.oauthMu.Unlock()
		return nil, err
	}
	if len(state) != len(session.State) || subtle.ConstantTimeCompare([]byte(state), []byte(session.State)) != 1 {
		s.oauthMu.Unlock()
		return nil, errors.New("oauth state mismatch")
	}
	if draft := stringValue(body["draft_id"]); draft != "" && session.DraftID != "" && draft != session.DraftID {
		s.oauthMu.Unlock()
		return nil, errors.New("oauth draft mismatch")
	}
	// 同一会话同时只允许一个完成请求（CPR 90s claim），失败时释放
	if session.ClaimedUntil.After(time.Now()) {
		s.oauthMu.Unlock()
		return nil, errors.New("oauth flow is already being completed")
	}
	session.ClaimedUntil = time.Now().Add(oauthClaimTTL)
	s.oauthSessions[sessionID] = session
	s.oauthMu.Unlock()
	completed := false
	defer func() {
		if completed {
			return
		}
		s.oauthMu.Lock()
		if current, ok := s.oauthSessions[sessionID]; ok && current.Status != "completed" {
			current.ClaimedUntil = time.Time{}
			s.oauthSessions[sessionID] = current
		}
		s.oauthMu.Unlock()
	}()
	expected := int64Number(body["expected_credential_revision"])
	token, err := s.exchangeOAuthCode(session, code)
	if err != nil {
		return nil, err
	}
	s.recordOAuthRecovery("authorization_code", session.RuntimeAccountID, token.AccessToken, token.RefreshToken)
	account, previous := Account{}, Account{}
	if existing, exists := s.store.Get(session.RuntimeAccountID); exists {
		previous = existing
	}
	// 重授权必须仍是授权开始时的安装身份（CPR）
	if previous.InstallationID != "" && session.InstallationID != "" && previous.InstallationID != session.InstallationID {
		return nil, errors.New("oauth installation identity changed; restart authorization")
	}
	account = previous
	account.ID = session.RuntimeAccountID
	if account.ID == "" {
		return nil, errors.New("runtime account id is required")
	}
	account.AuthType = "oauth"
	account.AccessToken = token.AccessToken
	account.RefreshToken = token.RefreshToken
	account.IDToken = token.IDToken
	account.Email = firstString(token.Email, previous.Email)
	account.ChatGPTAccountID = firstString(token.ChatGPTAccountID, previous.ChatGPTAccountID)
	account.Plan = firstString(token.Plan, previous.Plan)
	// Reauthorization changes credentials, not the operator's scheduling state.
	if previous.ID == "" {
		account.Enabled = true
		account.Paused = false
	}
	account.ProxyURL = session.ProxyURL
	if account.InstallationID == "" {
		account.InstallationID = session.InstallationID
	}
	if token.ExpiresAt > 0 {
		account.ExpiresAt = time.Unix(token.ExpiresAt, 0).UTC()
	}
	if account.CredentialRevision == 0 {
		account.CredentialRevision = 1
	}
	if previous.CredentialRevision > 0 {
		if expected >= 0 && expected != previous.CredentialRevision {
			return nil, fmt.Errorf("credential revision conflict: expected %d, got %d", expected, previous.CredentialRevision)
		}
		account.CredentialRevision = previous.CredentialRevision + 1
	}
	if _, err := s.store.UpsertCAS(account, func() int64 {
		if previous.ID == "" {
			return -1
		}
		return previous.CredentialRevision
	}()); err != nil {
		return nil, err
	}
	result := map[string]any{"ok": true, "gateway_instance_id": s.cfg.InstanceID, "account": publicAccount(account), "credential_revision": account.CredentialRevision, "identity": map[string]any{"email": account.Email, "chatgpt_account_id": account.ChatGPTAccountID, "plan": account.Plan, "runtime_account_id": account.ID}}
	s.oauthMu.Lock()
	completed = true
	session.Status = "completed"
	session.Result = result
	session.ClaimedUntil = time.Time{}
	s.oauthSessions[sessionID] = session
	_ = saveOAuthSessions(s.cfg.OAuthSessionsPath(), s.oauthSessions)
	s.oauthMu.Unlock()
	return result, nil
}

type oauthToken struct {
	AccessToken      string
	RefreshToken     string
	IDToken          string
	ExpiresAt        int64
	Email            string
	ChatGPTAccountID string
	Plan             string
}

func (s *Server) exchangeOAuthCode(session OAuthSession, code string) (oauthToken, error) {
	form := url.Values{"grant_type": {"authorization_code"}, "code": {code}, "client_id": {s.cfg.ClientID}, "redirect_uri": {s.cfg.OAuthRedirectURI}, "code_verifier": {session.CodeVerifier}}
	req, err := http.NewRequest(http.MethodPost, s.cfg.OAuthTokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return oauthToken{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	client, err := s.clientFor(Account{ProxyURL: session.ProxyURL})
	if err != nil {
		return oauthToken{}, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return oauthToken{}, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return oauthToken{}, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return oauthToken{}, fmt.Errorf("oauth token exchange returned %d", resp.StatusCode)
	}
	var raw struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		IDToken      string `json:"id_token"`
		ExpiresIn    int64  `json:"expires_in"`
	}
	if err := json.Unmarshal(data, &raw); err != nil || raw.AccessToken == "" {
		return oauthToken{}, errors.New("oauth token response missing access_token")
	}
	token := oauthToken{AccessToken: raw.AccessToken, RefreshToken: raw.RefreshToken, IDToken: raw.IDToken, ExpiresAt: time.Now().Add(time.Duration(raw.ExpiresIn) * time.Second).Unix()}
	claims := jwtClaims(raw.IDToken)
	access := jwtClaims(raw.AccessToken)
	auth, _ := claims["https://api.openai.com/auth"].(map[string]any)
	accessAuth, _ := access["https://api.openai.com/auth"].(map[string]any)
	profile, _ := access["https://api.openai.com/profile"].(map[string]any)
	token.Email = firstString(claims["email"], claims["preferred_username"], claims["user_email"], profile["email"])
	token.ChatGPTAccountID = firstString(auth["chatgpt_account_id"], accessAuth["chatgpt_account_id"], claims["chatgpt_account_id"], claims["account_id"])
	token.Plan = firstString(auth["chatgpt_plan_type"], accessAuth["chatgpt_plan_type"], claims["plan"], claims["plan_type"])
	return token, nil
}

// jwtParsable：令牌的 payload 段可按 JWT 解析（不验签）。
func jwtParsable(token string) bool {
	parts := strings.Split(token, ".")
	if len(parts) < 2 {
		return false
	}
	data, err := base64.RawURLEncoding.DecodeString(parts[1])
	var claims map[string]any
	return err == nil && json.Unmarshal(data, &claims) == nil && claims != nil
}

func jwtClaims(token string) map[string]any {
	parts := strings.Split(token, ".")
	if len(parts) < 2 {
		return map[string]any{}
	}
	data, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return map[string]any{}
	}
	var claims map[string]any
	if json.Unmarshal(data, &claims) != nil || claims == nil {
		return map[string]any{}
	}
	return claims
}

func firstString(values ...any) string {
	for _, value := range values {
		if text, ok := value.(string); ok && strings.TrimSpace(text) != "" {
			return strings.TrimSpace(text)
		}
	}
	return ""
}

func stringValue(value any) string {
	if text, ok := value.(string); ok {
		return strings.TrimSpace(text)
	}
	return ""
}
func int64Number(value any) int64 {
	switch number := value.(type) {
	case float64:
		return int64(number)
	case int64:
		return number
	case int:
		return int64(number)
	}
	return -1
}
