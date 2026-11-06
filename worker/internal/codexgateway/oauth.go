package codexgateway

import (
	"context"
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
	"strings"
	"time"
)

const (
	// oauthCallbackMaxBytes：回调 URL 上限（CPR 16KiB）
	oauthCallbackMaxBytes = 16 << 10
)

// OAuthSession 是一次授权会话（统一控制面重构 P3.7，设计 6.3）：会话（state、PKCE verifier、草稿）由控制面生成并保存，
// 开始与完成时随请求传入；Worker 只构造授权链接、补上账号安装身份，并在完成时用授权码换票，不再落盘保存会话。
// 同一会话的完成请求由控制面按草稿串行处理（替代过去的 90 秒认领）。
type OAuthSession struct {
	SessionID        string    `json:"session_id"`
	State            string    `json:"state"`
	CodeVerifier     string    `json:"code_verifier"`
	DraftID          string    `json:"draft_id,omitempty"`
	AccountResource  string    `json:"account_resource_id,omitempty"`
	RuntimeAccountID string    `json:"runtime_account_id,omitempty"`
	ProxyURL         string    `json:"proxy_url,omitempty"`
	ExpiresAt        time.Time `json:"expires_at"`
	// InstallationID 是该次授权绑定的账号安装身份：重授权沿用账号原值，新开户在开始时生成并在完成时写入账号
	InstallationID string `json:"installation_id,omitempty"`
	// Grant 是授权类型：空为原生 Codex OAuth，bps 为 Excel（Basispoints）授权
	Grant string `json:"grant,omitempty"`
}

var errOAuthSessionRequired = errors.New("the control plane must supply the OAuth session (state and PKCE verifier)")

// oauthSessionFrom 读取控制面传入的会话；state 与 verifier 至少 32 个字符（base64url 24 字节以上）。
func oauthSessionFrom(value any) (OAuthSession, error) {
	raw, err := json.Marshal(value)
	if err != nil || value == nil {
		return OAuthSession{}, errOAuthSessionRequired
	}
	var session OAuthSession
	if err := json.Unmarshal(raw, &session); err != nil {
		return OAuthSession{}, errOAuthSessionRequired
	}
	if session.SessionID == "" || len(session.State) < 32 || len(session.CodeVerifier) < 32 || session.ExpiresAt.IsZero() {
		return OAuthSession{}, errOAuthSessionRequired
	}
	return session, nil
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
	if session.Grant == grantBPS {
		return bpsOAuthURL(s.cfg, session)
	}
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

func (s *Server) oauthStartRequest(body map[string]any) (map[string]any, error) {
	session, err := oauthSessionFrom(body["session"])
	if err != nil {
		return nil, err
	}
	if !session.ExpiresAt.After(time.Now()) {
		return nil, errors.New("oauth session expired")
	}
	accountResource := strings.TrimSpace(stringValue(body["account_resource_id"]))
	runtimeID := strings.TrimSpace(stringValue(body["runtime_account_id"]))
	if runtimeID == "" && accountResource != "" {
		runtimeID = "gwacct_" + accountResource
	}
	grant := ""
	switch stringValue(body["grant"]) {
	case "", "codex":
	case grantBPS:
		grant = grantBPS
	default:
		return nil, errors.New("unsupported oauth grant")
	}
	installation := newUUIDv4()
	existing, exists := s.store.Get(runtimeID)
	if exists && existing.InstallationID != "" {
		installation = existing.InstallationID
	}
	// BPS 是 OAuth 账号上的附加授权：账号须已完成原生授权
	if grant == grantBPS && (!exists || existing.AccessToken == "") {
		return nil, errBPSNeedsNativeAuthorization
	}
	session.DraftID, session.AccountResource, session.RuntimeAccountID = stringValue(body["draft_id"]), accountResource, runtimeID
	session.ProxyURL, session.InstallationID, session.Grant = stringValue(body["proxy_url"]), installation, grant
	stateHash := sha256.Sum256([]byte(session.State))
	// 会话原样交回控制面保存（含安装身份），完成时随请求传回
	return map[string]any{"session_id": session.SessionID, "auth_url": s.oauthURL(session), "expires_at": session.ExpiresAt.UTC().Format(time.RFC3339Nano), "draft_id": session.DraftID, "account_resource_id": session.AccountResource, "state_hash": fmt.Sprintf("%x", stateHash[:]), "flavor": firstString(grant, "codex"), "session": session}, nil
}

func (s *Server) oauthCompleteRequest(body map[string]any) (map[string]any, error) {
	session, err := oauthSessionFrom(body["session"])
	if err != nil {
		return nil, err
	}
	if id := strings.TrimSpace(stringValue(body["session_id"])); id != "" && id != session.SessionID {
		return nil, errors.New("oauth session mismatch")
	}
	if !session.ExpiresAt.After(time.Now()) {
		return nil, errors.New("oauth session expired")
	}
	code, state, err := parseOAuthCallback(stringValue(body["callback"]))
	if err != nil {
		return nil, err
	}
	if len(state) != len(session.State) || subtle.ConstantTimeCompare([]byte(state), []byte(session.State)) != 1 {
		return nil, errors.New("oauth state mismatch")
	}
	if draft := stringValue(body["draft_id"]); draft != "" && session.DraftID != "" && draft != session.DraftID {
		return nil, errors.New("oauth draft mismatch")
	}
	expected := int64Number(body["expected_credential_revision"])
	// 控制面给出的代次下限（凭据库、各实例绑定、租约表里已知的最大值）：本实例副本落后时，新授权的代次也不会与其他实例撞号（R3 复审 N2）
	floor := max(int64Number(body["min_credential_revision"]), 0)
	token, err := s.exchangeOAuthCode(session, code)
	if err != nil {
		return nil, err
	}
	s.recordOAuthRecovery("authorization_code", session.RuntimeAccountID, token.AccessToken, token.RefreshToken)
	if session.Grant == grantBPS {
		return s.saveBPSGrant(session.RuntimeAccountID, bpsTokens{AccessToken: token.AccessToken, RefreshToken: token.RefreshToken, IDToken: token.IDToken, ExpiresAt: token.ExpiresAt, ChatGPTAccountID: token.ChatGPTAccountID}, int64Number(body["expected_bps_revision"]), max(int64Number(body["min_bps_token_generation"]), 0))
	}
	account, previous := Account{}, Account{}
	if existing, exists := s.store.Get(session.RuntimeAccountID); exists {
		previous = existing
	}
	// 重授权必须仍是授权开始时的安装身份（CPR）
	if previous.InstallationID != "" && session.InstallationID != "" && previous.InstallationID != session.InstallationID {
		return nil, errors.New("oauth installation identity changed; restart authorization")
	}
	account = previous
	// 新凭据不能继承旧凭据的终态与诊断，否则重授权后仍被判“凭证过期”而不可选
	resetCredentialRuntime(&account)
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
	if previous.CredentialRevision > 0 && expected >= 0 && expected != previous.CredentialRevision {
		return nil, fmt.Errorf("credential revision conflict: expected %d, got %d", expected, previous.CredentialRevision)
	}
	account.CredentialRevision = max(previous.CredentialRevision, floor) + 1
	if _, err := s.store.UpsertCAS(account, func() int64 {
		if previous.ID == "" {
			return -1
		}
		return previous.CredentialRevision
	}()); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true, "gateway_instance_id": s.cfg.InstanceID, "account": publicAccount(account), "credential_revision": account.CredentialRevision, "identity": map[string]any{"email": account.Email, "chatgpt_account_id": account.ChatGPTAccountID, "plan": account.Plan, "runtime_account_id": account.ID}}, nil
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
	clientID, redirectURI := s.cfg.ClientID, s.cfg.OAuthRedirectURI
	if session.Grant == grantBPS {
		clientID, redirectURI = s.cfg.BPSClientID, s.cfg.BPSRedirectURI
	}
	form := url.Values{"grant_type": {"authorization_code"}, "code": {code}, "client_id": {clientID}, "redirect_uri": {redirectURI}, "code_verifier": {session.CodeVerifier}}
	ctx, cancel := context.WithTimeout(context.Background(), refreshRequestTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.cfg.OAuthTokenURL, strings.NewReader(form.Encode()))
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
	if session.Grant == grantBPS {
		// Excel 授权的令牌必须签发给 Excel 客户端，且是付费套餐（BPS 不支持 Free）
		if issued := firstString(access["client_id"], access["azp"]); issued != "" && issued != clientID {
			return oauthToken{}, errors.New("BPS authorization returned a token for another client")
		}
		if strings.EqualFold(token.Plan, "free") {
			return oauthToken{}, errors.New("BPS requires a paid ChatGPT plan")
		}
	}
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
