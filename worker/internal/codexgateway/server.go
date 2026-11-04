package codexgateway

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type Server struct {
	cfg   Config
	store *Store
	// provenance 记录响应历史来自哪条通道（route_provenance.go）
	provenance *routeProvenance
	// bps 是 BPS 账号的工具回放与会话目录缓存（bps.go）
	bps           bpsState
	mu            sync.RWMutex
	draining      bool
	drained       bool
	drainDeadline time.Time
	nonces        map[string]time.Time
	cancels       map[string]context.CancelFunc
	// drainForced 记录因 Drain 截止时间被强制取消的 dispatch，Receipt 据此标注原因
	drainForced map[string]bool
	drainEpoch  int64
	active      int64
	// peak 是自上次心跳以来的最大在途数；心跳只采样瞬时值会漏掉两次心跳之间的并发高峰
	peak            int64
	receiptSequence int64
	oauthMu         sync.Mutex
	oauthSessions   map[string]OAuthSession
	refresher       *refresher
	ws              *wsPool
	catalog         catalogCache
	clientsMu       sync.Mutex
	clients         map[string]*http.Client
	// upstreamRoots 为空时使用系统根证书；测试注入自签 CA
	upstreamRoots *x509.CertPool
	// customCA：配置了 CODEX_CA_CERTIFICATE / SSL_CERT_FILE，HTTP 改用 rustls + HTTP/2 指纹
	customCA       bool
	protection     *protectionPolicies
	guardian       *guardianRouting
	turnStates     *turnStateProofs
	cyberPolicy    *cyberPolicyExclusions
	resetLocks     resetCreditLocks
	clientRetry    *clientRetryFailures
	oauthRecovery  *oauthRecoveryLog
	avatarMu       sync.Mutex
	avatarSources  map[string]avatarSourceEntry
	runtime        *runtimePolicy
	quotas         *quotaScheduler
	plans          *planCatalogs
	warmupRunning  atomic.Bool
	wsSessions     *wsSessionBudget
	live           *liveRegistry
	releases       *releaseStore
	profilePolicy  *profilePolicy
	privacy        *privacyCache
	releaseFetcher *releaseFetcher
	quotaReports   *quotaReporter
}

func NewServer(cfg Config) (*Server, error) {
	// 账号库以凭据 bundle 密钥派生的独立密钥加密落盘；未配置该密钥（不接控制面的本机调试）时保持明文
	store, err := OpenSealedStore(cfg.AccountsPath(), cfg.CredentialBundleKey)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(cfg.ReceiptDir(), 0o700); err != nil {
		return nil, err
	}
	oauthSessions, _ := loadOAuthSessions(cfg.OAuthSessionsPath())
	store.SetDefaultConcurrency(cfg.AccountConcurrency)
	store.SetQueueLimits(cfg.GuardianConcurrency, cfg.MaxWaitingPerAcct, time.Duration(cfg.SessionTTLHours)*time.Hour)
	server := &Server{cfg: cfg, store: store, nonces: map[string]time.Time{}, cancels: map[string]context.CancelFunc{}, drainForced: map[string]bool{}, oauthSessions: oauthSessions, refresher: newRefresher(), ws: newWSPool(), catalog: catalogCache{entries: map[string]catalogEntry{}}, clients: map[string]*http.Client{}, protection: loadProtectionPolicies(filepath.Join(cfg.DataDir, "account_protection_policy.json")), guardian: newGuardianRouting(), turnStates: newTurnStateProofs(), cyberPolicy: newCyberPolicyExclusions(), clientRetry: newClientRetryFailures(), oauthRecovery: newOAuthRecoveryLog(cfg), avatarSources: map[string]avatarSourceEntry{}, runtime: loadRuntimePolicy(filepath.Join(cfg.DataDir, "runtime_policy.json")), quotas: newQuotaScheduler(), plans: &planCatalogs{entries: map[string]planCatalog{}}, wsSessions: newWSSessionBudget(), live: newLiveRegistry(), releases: newReleaseStore(filepath.Join(cfg.DataDir, "client_releases.json")), profilePolicy: &profilePolicy{}, privacy: newPrivacyCache(), releaseFetcher: newReleaseFetcher(), quotaReports: newQuotaReporter()}
	store.eligible = server.accountEligible
	// BPS 工具回放与会话目录跨重启保留（bps_state.go）
	server.bps.disk = newBPSDiskState(filepath.Join(cfg.DataDir, "bps_state.json"), store)
	server.provenance = newRouteProvenance(filepath.Join(cfg.DataDir, "route_provenance.json"), store)
	if roots, err := loadCustomCA(); err != nil {
		return nil, err
	} else if roots != nil {
		server.upstreamRoots, server.customCA = roots, true
	}
	return server, nil
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/internal/v1/health", s.health)
	mux.HandleFunc("/internal/v1/capabilities", s.capabilities)
	mux.HandleFunc("/internal/v1/register", s.register)
	mux.HandleFunc("/internal/v1/heartbeat", s.heartbeat)
	mux.HandleFunc("/internal/v1/drain", s.drain)
	mux.HandleFunc("/internal/v1/resume", s.resume)
	mux.HandleFunc("/internal/v1/accounts", s.accounts)
	mux.HandleFunc("/internal/v1/accounts/project", s.projectAccount)
	mux.HandleFunc("/internal/v1/accounts/", s.accountAction)
	mux.HandleFunc("/internal/v1/execute", s.execute)
	mux.HandleFunc("/internal/v1/execute/", s.executeAction)
	mux.HandleFunc("/internal/v1/models", s.models)
	mux.HandleFunc("/internal/v1/profile/preview", s.profilePreview)
	mux.HandleFunc("/internal/v1/profile/releases", s.profileReleases)
	mux.HandleFunc("/internal/v1/privacy/preview", s.privacyPreview)
	mux.HandleFunc("/internal/v1/ws/frame", s.wsFrame)
	mux.HandleFunc("/internal/v1/ws/close", s.wsClose)
	mux.HandleFunc("/internal/v1/live/hangup", s.liveHangup)
	mux.HandleFunc("/internal/v1/live/sideband", s.liveSideband)
	mux.HandleFunc("/internal/v1/receipts/replay", s.receiptsReplay)
	mux.HandleFunc("/internal/v1/receipts/ack", s.receiptsAck)
	mux.HandleFunc("/internal/v1/oauth/start", s.oauthStart)
	mux.HandleFunc("/internal/v1/oauth/complete", s.oauthComplete)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := s.authenticate(r); err != nil {
			writeError(w, http.StatusUnauthorized, "invalid_internal_auth", err.Error())
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func (s *Server) authenticate(r *http.Request) error {
	if s.cfg.RequireMTLS {
		if r.TLS == nil || len(r.TLS.PeerCertificates) == 0 {
			return errors.New("mTLS client certificate is required")
		}
		if s.cfg.InternalToken == "" {
			return nil
		}
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 64<<20))
	if err != nil {
		return err
	}
	r.Body = io.NopCloser(bytes.NewReader(body))
	if r.URL.Path == "/internal/v1/live/sideband" {
		// WebSocket 升级没有正文：签名覆盖 X-Kin-Gateway-Live 中的 sideband 参数
		body = []byte(r.Header.Get("X-Kin-Gateway-Live"))
	}
	if err := Verify(
		s.cfg.InternalToken,
		r.Header.Get("X-Kin-Gateway-Timestamp"),
		r.Header.Get("X-Kin-Gateway-Nonce"),
		r.Header.Get("X-Kin-Gateway-Body-Sha256"),
		r.Header.Get("X-Kin-Gateway-Signature"),
		body,
		time.Now(),
		s.cfg.ClockSkew,
	); err != nil {
		return err
	}
	if s.seenNonce(r.Header.Get("X-Kin-Gateway-Nonce")) {
		return errors.New("request nonce already used")
	}
	return nil
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	s.mu.RLock()
	draining := s.draining
	drained := s.drained
	deadline := s.drainDeadline
	s.mu.RUnlock()
	drainState := "accepting"
	if draining {
		drainState = "draining"
	}
	if drained {
		drainState = "drained"
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "service": "kin-codex-gateway", "id": s.cfg.InstanceID, "boot_id": s.cfg.BootID, "region": s.cfg.Region, "version": s.cfg.Version, "protocol_version": 1, "health_state": "healthy", "drain_state": drainState, "draining": draining, "drain_deadline": func() any {
		if deadline.IsZero() {
			return nil
		}
		return deadline.UTC().Format(time.RFC3339Nano)
	}(), "active_concurrency": atomic.LoadInt64(&s.active), "account_count": len(s.store.List())})
}

func (s *Server) capabilities(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"version": 1, "service": "kin-codex-gateway", "operations": []string{"responses", "chat", "images", "images.generations", "images.edits", "search", "models", "cancel", "oauth", "receipts", "projection", "live"}, "protocols": []string{"openai.responses", "openai.chat", "openai.images", "openai.search"}, "websocket": true, "upstream_websocket": true, "responses_ws_bridge": true, "mtls": s.cfg.RequireMTLS})
}

func (s *Server) register(w http.ResponseWriter, r *http.Request)  { s.health(w, r) }
func (s *Server) heartbeat(w http.ResponseWriter, r *http.Request) { s.health(w, r) }

func (s *Server) drain(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Deadline string `json:"deadline"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 8<<10)).Decode(&body)
	s.mu.Lock()
	s.draining = true
	s.drained = false
	if body.Deadline != "" {
		if parsed, err := time.Parse(time.RFC3339Nano, body.Deadline); err == nil {
			s.drainDeadline = parsed
		}
	}
	if atomic.LoadInt64(&s.active) == 0 {
		s.draining = false
		s.drained = true
	}
	draining := s.draining
	drained := s.drained
	deadline := s.drainDeadline
	s.drainEpoch++
	epoch := s.drainEpoch
	s.mu.Unlock()
	if draining && !deadline.IsZero() {
		go s.enforceDrainDeadline(deadline, epoch)
	}
	state := "draining"
	if drained {
		state = "drained"
	}
	result := map[string]any{"ok": true, "draining": draining, "drain_state": state, "active_concurrency": atomic.LoadInt64(&s.active)}
	if !deadline.IsZero() {
		result["drain_deadline"] = deadline.UTC().Format(time.RFC3339Nano)
	}
	writeJSON(w, http.StatusOK, result)
}
func (s *Server) resume(w http.ResponseWriter, _ *http.Request) {
	s.mu.Lock()
	s.draining = false
	s.drained = false
	s.drainDeadline = time.Time{}
	s.drainEpoch++
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "draining": false, "drain_state": "accepting", "drain_deadline": nil})
}

// enforceDrainDeadline 到截止时间仍在排空时取消全部在途请求；Resume 或新的 Drain 会使旧计时失效。
func (s *Server) enforceDrainDeadline(deadline time.Time, epoch int64) {
	timer := time.NewTimer(time.Until(deadline))
	defer timer.Stop()
	<-timer.C
	s.mu.Lock()
	if s.drainEpoch != epoch || !s.draining {
		s.mu.Unlock()
		return
	}
	cancels := make([]context.CancelFunc, 0, len(s.cancels))
	for dispatch, cancel := range s.cancels {
		s.drainForced[dispatch] = true
		cancels = append(cancels, cancel)
	}
	s.mu.Unlock()
	for _, cancel := range cancels {
		cancel()
	}
}

func (s *Server) takeDrainForced(dispatch string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	forced := s.drainForced[dispatch]
	delete(s.drainForced, dispatch)
	return forced
}

func (s *Server) accounts(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		writeJSON(w, http.StatusOK, map[string]any{"items": s.store.List()})
		return
	}
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed")
		return
	}
	var account Account
	if err := json.NewDecoder(io.LimitReader(r.Body, 8<<20)).Decode(&account); err != nil {
		writeError(w, 400, "invalid_json", err.Error())
		return
	}
	s.recordOAuthRecovery("import", account.ID, account.AccessToken, account.RefreshToken)
	saved, err := s.store.Upsert(account)
	if err != nil {
		writeError(w, 400, "account_invalid", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"account": publicAccount(saved), "fingerprint": Fingerprint(saved)})
}

func (s *Server) projectAccount(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed")
		return
	}
	s.accounts(w, r)
}

func (s *Server) accountAction(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.Trim(strings.TrimPrefix(r.URL.Path, "/internal/v1/accounts/"), "/"), "/")
	if len(parts) == 0 || parts[0] == "" {
		writeError(w, http.StatusNotFound, "account_not_found", "account not found")
		return
	}
	accountID := parts[0]
	if len(parts) == 1 && r.Method == http.MethodPatch {
		var patch map[string]any
		if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&patch); err != nil {
			writeError(w, 400, "invalid_json", err.Error())
			return
		}
		account, err := s.store.Patch(accountID, patch)
		if err != nil {
			writeError(w, 404, "account_not_found", "account not found")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"account": publicAccount(account)})
		return
	}
	if len(parts) == 2 && parts[1] == "credentials" && r.Method == http.MethodGet {
		// 运营导出账号文件（控制面审计）：明文返回原生与 BPS 授权令牌，供迁移到其他部署后重新导入
		account, ok := s.store.Get(accountID)
		if !ok {
			writeError(w, http.StatusNotFound, "account_not_found", "account not found")
			return
		}
		credentials := map[string]any{"access_token": account.AccessToken, "refresh_token": account.RefreshToken, "id_token": account.IDToken, "chatgpt_account_id": account.ChatGPTAccountID, "email": account.Email}
		if !account.ExpiresAt.IsZero() {
			credentials["expires_at"] = account.ExpiresAt.Unix()
		}
		out := map[string]any{"ok": true, "credentials": credentials}
		if grant := account.BPS; grant != nil && grant.AccessToken != "" {
			bps := map[string]any{"access_token": grant.AccessToken, "refresh_token": grant.RefreshToken, "id_token": grant.IDToken, "chatgpt_account_id": bpsChatGPTAccountID(account)}
			if !grant.ExpiresAt.IsZero() {
				bps["expires_at"] = grant.ExpiresAt.Unix()
			}
			out["bps_credentials"] = bps
		}
		writeJSON(w, http.StatusOK, out)
		return
	}
	if len(parts) == 2 && parts[1] == "export" && (r.Method == http.MethodGet || r.Method == http.MethodPost) {
		account, ok := s.store.Get(accountID)
		if !ok {
			writeError(w, http.StatusNotFound, "account_not_found", "account not found")
			return
		}
		bundle, err := s.sealCredentialBundle(account)
		if err != nil {
			writeError(w, 500, "credential_export_failed", err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "account": publicAccount(account), "credential_bundle": bundle})
		return
	}
	if len(parts) == 2 && parts[1] == "projection" && r.Method == http.MethodGet {
		account, ok := s.store.Get(accountID)
		if !ok {
			writeError(w, http.StatusNotFound, "account_not_found", "account not found")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "account": publicAccount(account), "projection_revision": account.RuntimeRevision, "credential_revision": account.CredentialRevision})
		return
	}
	if len(parts) == 2 && parts[1] == "import" && r.Method == http.MethodPost {
		var payload map[string]json.RawMessage
		if err := json.NewDecoder(io.LimitReader(r.Body, 8<<20)).Decode(&payload); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_json", err.Error())
			return
		}
		var account Account
		if raw := payload["account"]; len(raw) > 0 {
			_ = json.Unmarshal(raw, &account)
		} else {
			flat, _ := json.Marshal(payload)
			_ = json.Unmarshal(flat, &account)
		}
		if raw := payload["credential_bundle"]; len(raw) > 0 {
			var bundle string
			_ = json.Unmarshal(raw, &bundle)
			if bundle != "" {
				secrets, err := s.openCredentialBundle(bundle, accountID)
				if err != nil {
					writeError(w, 400, "credential_bundle_invalid", err.Error())
					return
				}
				account.AccessToken = secrets.AccessToken
				account.RefreshToken = secrets.RefreshToken
				account.IDToken = secrets.IDToken
				account.APIKey = secrets.APIKey
				account.ProxyURL = secrets.ProxyURL
				// 公开字段只带 BPS 状态与代次，令牌来自凭据包
				if secrets.BPSAccessToken != "" {
					if account.BPS == nil {
						account.BPS = &BPSGrant{Revision: 1}
					}
					account.BPS.AccessToken, account.BPS.RefreshToken, account.BPS.IDToken = secrets.BPSAccessToken, secrets.BPSRefreshToken, secrets.BPSIDToken
				} else {
					account.BPS = nil
				}
			}
		}
		account.ID = accountID
		saved, err := s.store.Upsert(account)
		if err != nil {
			writeError(w, http.StatusBadRequest, "account_invalid", err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "account": publicAccount(saved), "fingerprint": Fingerprint(saved)})
		return
	}
	if s.accountBPSAction(w, r, accountID, parts) {
		return
	}
	if len(parts) == 2 && s.accountInsight(w, r, accountID, parts[1]) {
		return
	}
	if len(parts) != 2 || r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed")
		return
	}
	switch parts[1] {
	case "pause":
		_, err := s.store.Patch(accountID, map[string]any{"paused": true})
		if err != nil {
			writeError(w, 404, "account_not_found", "account not found")
			return
		}
	case "recover":
		if err := s.store.Recover(accountID); err != nil {
			writeError(w, 404, "account_not_found", "account not found")
			return
		}
	case "resume":
		_, err := s.store.Patch(accountID, map[string]any{"paused": false, "enabled": true})
		if err != nil {
			writeError(w, 404, "account_not_found", "account not found")
			return
		}
	case "refresh":
		account, err := s.refreshAccount(accountID)
		if err != nil {
			writeError(w, http.StatusBadGateway, "credential_refresh_failed", err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "account": publicAccount(account), "action": parts[1]})
		return
	case "reauthorize":
		var patch map[string]any
		_ = json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&patch)
		if len(patch) == 0 {
			account, ok := s.store.Get(accountID)
			if !ok {
				writeError(w, 404, "account_not_found", "account not found")
				return
			}
			if account.RefreshToken == "" {
				writeError(w, http.StatusNotImplemented, "oauth_provider_not_configured", "reauthorize requires provider credentials")
				return
			}
			refreshed, err := s.refreshAccount(accountID)
			if err != nil {
				writeError(w, http.StatusBadGateway, "credential_refresh_failed", err.Error())
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "account": publicAccount(refreshed), "action": parts[1]})
			return
		}
		account, err := s.store.Patch(accountID, patch)
		if err != nil {
			writeError(w, 404, "account_not_found", "account not found")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "account": publicAccount(account), "action": parts[1]})
		return
	case "status":
		// 只读：账号运行态（冷却、错误保护冻结与探测结果、自动重置卡计划），不触发上游请求
		account, ok := s.store.Get(accountID)
		if !ok {
			writeError(w, 404, "account_not_found", "account not found")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "account": publicAccount(account), "action": parts[1], "reset_credit": resetCreditStatus(account, s.runtime.resetCreditPolicy(), time.Now())})
		return
	case "test", "quota":
		// 测试即真实查询上游额度：同时验证凭据、代理出口与账号可用性
		ctx, cancel := context.WithTimeout(r.Context(), accountRequestTimeout)
		defer cancel()
		result, status, err := s.queryQuota(ctx, accountID)
		if errors.Is(err, errAccountNotFound) {
			writeError(w, 404, "account_not_found", "account not found")
			return
		}
		if err != nil {
			writeError(w, status, "quota_query_failed", err.Error())
			return
		}
		account, _ := s.store.Get(accountID)
		result["ok"] = true
		result["account"] = publicAccount(account)
		result["action"] = parts[1]
		writeJSON(w, http.StatusOK, result)
		return
	case "reset-credits":
		var body struct {
			CreditID        string `json:"credit_id"`
			RedeemRequestID string `json:"redeem_request_id"`
		}
		_ = json.NewDecoder(io.LimitReader(r.Body, 16<<10)).Decode(&body)
		ctx, cancel := context.WithTimeout(r.Context(), 2*accountRequestTimeout)
		defer cancel()
		result, status, err := s.consumeResetCredit(ctx, accountID, body.CreditID, body.RedeemRequestID)
		if errors.Is(err, errAccountNotFound) {
			writeError(w, 404, "account_not_found", "account not found")
			return
		}
		if err != nil {
			writeJSON(w, status, map[string]any{"ok": false, "error": map[string]any{"code": "reset_credit_failed", "message": err.Error()}, "redeem_request_id": result["redeem_request_id"], "outcome": result["outcome"]})
			return
		}
		account, _ := s.store.Get(accountID)
		result["ok"] = true
		result["account"] = publicAccount(account)
		writeJSON(w, http.StatusOK, result)
		return
	default:
		writeError(w, 404, "unsupported_account_action", "unsupported account action")
		return
	}
	account, _ := s.store.Get(accountID)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "account": publicAccount(account), "action": parts[1]})
}

func (s *Server) executeAction(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.Trim(strings.TrimPrefix(r.URL.Path, "/internal/v1/execute/"), "/"), "/")
	if len(parts) != 2 || parts[1] != "cancel" || r.Method != http.MethodPost {
		writeError(w, http.StatusNotFound, "not_found", "execute action not found")
		return
	}
	s.mu.RLock()
	cancel := s.cancels[parts[0]]
	s.mu.RUnlock()
	if cancel != nil {
		cancel()
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "dispatch_id": parts[0], "status": "accepted"})
}

func (s *Server) execute(w http.ResponseWriter, r *http.Request) {
	s.mu.RLock()
	draining := s.draining || s.drained
	s.mu.RUnlock()
	if draining {
		// 排空期间不接单：请求未发出，控制面可换实例（drain 到下次心跳之间仍可能被选中）
		w.Header().Set(sendStateHeader, sendStateNotSent)
		writeError(w, http.StatusServiceUnavailable, "gateway_worker_draining", "gateway worker is draining")
		return
	}
	var envelope Envelope
	body, err := io.ReadAll(io.LimitReader(r.Body, 64<<20))
	if err != nil {
		writeError(w, 400, "invalid_body", err.Error())
		return
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		writeError(w, 400, "invalid_envelope", err.Error())
		return
	}
	if err := envelope.Validate(time.Now(), s.cfg.ClockSkew); err != nil {
		writeError(w, 400, "invalid_envelope", err.Error())
		return
	}
	if s.seenNonce(envelope.Nonce) {
		writeError(w, 409, "replayed_envelope", "envelope nonce already used")
		return
	}
	target, err := s.upstreamURL(envelope.Operation)
	if err != nil {
		writeError(w, 400, "unsupported_operation", err.Error())
		return
	}
	if !s.acquireCapacity() {
		w.Header().Set(sendStateHeader, "not_sent")
		writeError(w, http.StatusServiceUnavailable, "gateway_worker_capacity_exhausted", "gateway worker capacity exhausted")
		return
	}
	defer func() {
		atomic.AddInt64(&s.active, -1)
		s.finishDrainIfIdle()
	}()
	// RequestTimeout 只约束提交前（排队、重试、换号与等待上游响应头）；提交后的流式正文不设总时长，
	// 由上游正文空闲超时判定中断（CPR 不限制流总时长，只有 300s 空闲超时）
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	preCommit := time.AfterFunc(s.cfg.RequestTimeout, cancel)
	defer preCommit.Stop()
	s.mu.Lock()
	s.cancels[envelope.Dispatch] = cancel
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.cancels, envelope.Dispatch)
		delete(s.drainForced, envelope.Dispatch)
		s.mu.Unlock()
	}()
	run := &dispatchRun{server: s, envelope: envelope, target: target, body: envelope.Body, protection: s.protection.observe(envelope.AccountProtection), countable: protectionCountable(envelope.Body), preCommit: preCommit}
	if len(run.body) == 0 {
		run.body = []byte("{}")
	}
	profile, err := s.resolveProfile(envelope.ClientProfile, envelope.ProfileDeployment)
	if err != nil {
		w.Header().Set(sendStateHeader, sendStateNotSent)
		if errors.Is(err, errProfileReleaseUnavailable) {
			writeError(w, http.StatusServiceUnavailable, "client_profile_unavailable", err.Error())
		} else {
			writeError(w, http.StatusBadRequest, "client_profile_invalid", err.Error())
		}
		return
	}
	run.profile = profile
	if envelope.RequestLocation != nil {
		if location, err := envelope.RequestLocation.normalized(); err == nil {
			run.requestLocation = &location
		}
	}
	if run.privacy, err = s.privacy.forRequest(envelope.Privacy); err != nil {
		w.Header().Set(sendStateHeader, sendStateNotSent)
		writePrivacyRejectedBody(w)
		return
	}
	var parsedBody map[string]any
	_ = json.Unmarshal(run.body, &parsedBody)
	run.guardian = isGuardianRequest(envelope, parsedBody)
	run.followOnly = followsSession(envelope.Headers, parsedBody)
	run.clientTurn = run.clientTurnKey()
	run.retrySuppressed = s.clientRetry.has(run.clientTurn, time.Now())
	if previousID, _ := parsedBody["previous_response_id"].(string); previousID != "" && s.expandBPSContinuation(run, previousID) {
		// BPS 产生的上一轮：按快照展开完整历史并钉住原账号（bps_continuation.go）
	} else if previousID != "" && envelope.ConnectionKey != "" {
		// 连接内续接：上游 store=false，previous_response_id 只在原上游 WS 上有效（CPR WS→WS）。
		// 原连接仍在且属于同一账号时原生续接；否则改发控制面展开的完整历史，二者都没有则要求客户端重放。
		if accountID, _, ok := s.ws.continuation(envelope.ConnectionKey, previousID); ok {
			run.nativeContinuation = true
			run.envelope.Scope.RuntimeAccountID = accountID
			run.envelope.Scope.CredentialRevision = 0
		} else if len(envelope.ReplayBody) > 0 {
			run.body = envelope.ReplayBody
		} else {
			w.Header().Set(sendStateHeader, sendStateNotSent)
			w.Header().Set(continuationReasonHeader, "connection_unavailable")
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": map[string]any{"type": "invalid_request_error", "code": "previous_response_not_found", "param": "previous_response_id", "message": "Previous response is not available on this connection; resend the full input history without previous_response_id."}})
			return
		}
	}
	run.execute(ctx, w)
}

func (s *Server) acquireCapacity() bool {
	for {
		current := atomic.LoadInt64(&s.active)
		if current >= int64(s.cfg.MaxConcurrency) {
			return false
		}
		if atomic.CompareAndSwapInt64(&s.active, current, current+1) {
			for peak := atomic.LoadInt64(&s.peak); current+1 > peak && !atomic.CompareAndSwapInt64(&s.peak, peak, current+1); peak = atomic.LoadInt64(&s.peak) {
			}
			return true
		}
	}
}

// copyFlushing 逐块写出并 Flush，保证 SSE 事件不被 ResponseWriter 缓冲。
func copyFlushing(w http.ResponseWriter, src io.Reader) (int64, error) {
	flusher, _ := w.(http.Flusher)
	buf := make([]byte, 32<<10)
	var written int64
	for {
		n, readErr := src.Read(buf)
		if n > 0 {
			m, writeErr := w.Write(buf[:n])
			written += int64(m)
			if writeErr != nil {
				return written, writeErr
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if readErr == io.EOF {
			return written, nil
		}
		if readErr != nil {
			return written, readErr
		}
	}
}

// egressKey 是客户端与 TLS 会话的隔离键（CPR egress_key）：配置了代理的账号按“账号 + 代理”各自独立，
// 不与同代理的其他账号共用 keep-alive 连接和会话票据；直连账号共用一个客户端。
func egressKey(account Account) string {
	if account.ProxyURL == "" {
		return "direct"
	}
	return account.ID + "\x00" + account.ProxyURL
}

// clientFor 按出口隔离键缓存客户端以复用连接；不继承环境代理。
// OAuth 账号的请求再包一层账号 Cookie 的回放与采集。
func (s *Server) clientFor(account Account) (*http.Client, error) {
	client, err := s.cachedClient("http\x00"+egressKey(account), func() (*http.Client, error) {
		transport, err := s.newUpstreamTransport(account.ProxyURL)
		if err != nil {
			return nil, err
		}
		// 不设 http.Client.Timeout：它连流式正文一起计时，会截断超过时限的长推理流
		return &http.Client{Transport: &idleTimeoutTransport{base: transport, header: s.cfg.RequestTimeout, idle: upstreamStreamIdleTimeout}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, nil
	})
	if err != nil || account.ID == "" || account.APIKey != "" {
		return client, err
	}
	wrapped := *client
	wrapped.Transport = &accountCookieTransport{base: client.Transport, store: s.store, account: account.ID, revision: account.CredentialRevision}
	return &wrapped, nil
}

const maxCachedClients = 256

// upstreamStreamIdleTimeout 是上游响应正文单次读取的最长等待（CPR UPSTREAM_STREAM_IDLE_TIMEOUT）；
// 只要上游持续有数据，流不受总时长限制。
const upstreamStreamIdleTimeout = 300 * time.Second

var (
	errUpstreamHeaderTimeout = errors.New("upstream response header timeout")
	errUpstreamStreamIdle    = errors.New("upstream stream idle timeout")
)

// idleTimeoutTransport 限制等待响应头的时长，并对响应正文做读取空闲超时；不限制正文总时长。
type idleTimeoutTransport struct {
	base   http.RoundTripper
	header time.Duration
	idle   time.Duration
}

func (t *idleTimeoutTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	ctx, cancel := context.WithCancelCause(req.Context())
	headerTimer := time.AfterFunc(t.header, func() { cancel(errUpstreamHeaderTimeout) })
	resp, err := t.base.RoundTrip(req.WithContext(ctx))
	headerTimer.Stop()
	if err != nil {
		cause := context.Cause(ctx)
		cancel(nil)
		if errors.Is(cause, errUpstreamHeaderTimeout) {
			return nil, cause
		}
		return nil, err
	}
	body := &idleTimeoutBody{body: resp.Body, ctx: ctx, cancel: cancel, idle: t.idle}
	body.timer = time.AfterFunc(t.idle, func() { cancel(errUpstreamStreamIdle) })
	body.timer.Stop()
	resp.Body = body
	return resp, nil
}

type idleTimeoutBody struct {
	body   io.ReadCloser
	ctx    context.Context
	cancel context.CancelCauseFunc
	idle   time.Duration
	timer  *time.Timer
}

func (b *idleTimeoutBody) Read(p []byte) (int, error) {
	b.timer.Reset(b.idle)
	n, err := b.body.Read(p)
	b.timer.Stop()
	if err != nil && err != io.EOF {
		if cause := context.Cause(b.ctx); errors.Is(cause, errUpstreamStreamIdle) || errors.Is(cause, errUpstreamHeaderTimeout) {
			return n, cause
		}
	}
	return n, err
}

func (b *idleTimeoutBody) Close() error {
	b.timer.Stop()
	err := b.body.Close()
	b.cancel(nil)
	return err
}

func (s *Server) cachedClient(key string, build func() (*http.Client, error)) (*http.Client, error) {
	s.clientsMu.Lock()
	defer s.clientsMu.Unlock()
	if client, ok := s.clients[key]; ok {
		return client, nil
	}
	client, err := build()
	if err != nil {
		return nil, err
	}
	if len(s.clients) >= maxCachedClients {
		for k, old := range s.clients {
			old.CloseIdleConnections()
			delete(s.clients, k)
		}
	}
	s.clients[key] = client
	return client, nil
}

func (s *Server) oauthStart(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", err.Error())
		return
	}
	result, err := s.oauthStartRequest(body)
	if err != nil {
		writeError(w, http.StatusBadRequest, "oauth_start_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, result)
}
func (s *Server) oauthComplete(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", err.Error())
		return
	}
	result, err := s.oauthCompleteRequest(body)
	if err != nil {
		status := http.StatusBadRequest
		code := "oauth_complete_failed"
		if strings.Contains(err.Error(), "revision conflict") {
			status = http.StatusConflict
			code = "credential_revision_conflict"
		}
		writeError(w, status, code, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) receiptsReplay(w http.ResponseWriter, _ *http.Request) {
	entries, _ := os.ReadDir(s.cfg.ReceiptDir())
	items := make([]any, 0, len(entries))
	for _, entry := range entries {
		if filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		data, err := os.ReadFile(filepath.Join(s.cfg.ReceiptDir(), entry.Name()))
		if err == nil {
			var value any
			if json.Unmarshal(data, &value) == nil {
				items = append(items, value)
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (s *Server) receiptsAck(w http.ResponseWriter, r *http.Request) {
	var body struct {
		DispatchID string `json:"dispatch_id"`
		ReceiptID  string `json:"receipt_id"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&body); err != nil {
		writeError(w, 400, "invalid_json", err.Error())
		return
	}
	if strings.TrimSpace(body.DispatchID) == "" {
		writeError(w, 400, "dispatch_required", "dispatch_id is required")
		return
	}
	if err := os.Remove(filepath.Join(s.cfg.ReceiptDir(), body.DispatchID+".json")); err != nil && !os.IsNotExist(err) {
		writeError(w, 500, "receipt_ack_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "dispatch_id": body.DispatchID, "receipt_id": body.ReceiptID})
}

func (s *Server) upstreamURL(operation string) (string, error) {
	base := strings.TrimRight(s.cfg.UpstreamBaseURL, "/")
	switch operation {
	case "responses", "chat":
		return base + "/responses", nil
	case "images", "images.generations":
		return base + "/images/generations", nil
	case "images.edits":
		return base + "/images/edits", nil
	case "search":
		return base + "/alpha/search", nil
	case "live":
		return base + "/realtime/calls?" + liveCallsQuery, nil
	default:
		return "", fmt.Errorf("unsupported operation %q", operation)
	}
}

type credentialBundle struct {
	AccessToken  string `json:"access_token,omitempty"`
	RefreshToken string `json:"refresh_token,omitempty"`
	IDToken      string `json:"id_token,omitempty"`
	APIKey       string `json:"api_key,omitempty"`
	ProxyURL     string `json:"proxy_url,omitempty"`
	// BPS 附加授权的令牌（多实例投影时随原生凭据一起迁移）
	BPSAccessToken  string `json:"bps_access_token,omitempty"`
	BPSRefreshToken string `json:"bps_refresh_token,omitempty"`
	BPSIDToken      string `json:"bps_id_token,omitempty"`
}

func (s *Server) bundleKey() ([]byte, error) {
	material := strings.TrimSpace(s.cfg.CredentialBundleKey)
	if material == "" {
		return nil, errors.New("credential_bundle_key is not configured")
	}
	sum := sha256.Sum256([]byte(material))
	return sum[:], nil
}

func (s *Server) sealCredentialBundle(account Account) (string, error) {
	key, err := s.bundleKey()
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	bundle := credentialBundle{AccessToken: account.AccessToken, RefreshToken: account.RefreshToken, IDToken: account.IDToken, APIKey: account.APIKey, ProxyURL: account.ProxyURL}
	if account.BPS != nil {
		bundle.BPSAccessToken, bundle.BPSRefreshToken, bundle.BPSIDToken = account.BPS.AccessToken, account.BPS.RefreshToken, account.BPS.IDToken
	}
	payload, err := json.Marshal(bundle)
	if err != nil {
		return "", err
	}
	sealed := gcm.Seal(nil, nonce, payload, []byte(account.ID))
	return base64.RawURLEncoding.EncodeToString(append(nonce, sealed...)), nil
}

func (s *Server) openCredentialBundle(encoded, accountID string) (credentialBundle, error) {
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(encoded))
	if err != nil {
		return credentialBundle{}, err
	}
	key, err := s.bundleKey()
	if err != nil {
		return credentialBundle{}, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return credentialBundle{}, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return credentialBundle{}, err
	}
	if len(raw) < gcm.NonceSize() {
		return credentialBundle{}, errors.New("credential bundle is truncated")
	}
	payload, err := gcm.Open(nil, raw[:gcm.NonceSize()], raw[gcm.NonceSize():], []byte(accountID))
	if err != nil {
		return credentialBundle{}, err
	}
	var bundle credentialBundle
	if err := json.Unmarshal(payload, &bundle); err != nil {
		return credentialBundle{}, err
	}
	return bundle, nil
}

func (s *Server) seenNonce(nonce string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	for key, at := range s.nonces {
		if now.Sub(at) > 10*time.Minute {
			delete(s.nonces, key)
		}
	}
	if _, ok := s.nonces[nonce]; ok {
		return true
	}
	s.nonces[nonce] = now
	return false
}

func (s *Server) finishDrainIfIdle() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.draining && atomic.LoadInt64(&s.active) == 0 {
		s.draining = false
		s.drained = true
	}
}

func (s *Server) writeReceipt(dispatch string, value map[string]any) error {
	// 先往返一次成为纯 map/切片：结构体字段（如 attempts）按声明顺序编码，而控制面按递归排序的键
	// 计算 payload hash，必须让所有层级的键都按字典序输出
	value, err := canonicalReceipt(value)
	if err != nil {
		return err
	}
	data, err := marshalJSON(value)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(data)
	value["payload_hash"] = hex.EncodeToString(sum[:])
	data, err = marshalJSON(value)
	if err != nil {
		return err
	}
	path := filepath.Join(s.cfg.ReceiptDir(), dispatch+".json")
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(data, '\n'), 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if s.cfg.ReceiptURL != "" {
		go s.sendReceipt(data)
	}
	return nil
}

func canonicalReceipt(value map[string]any) (map[string]any, error) {
	raw, err := marshalJSON(value)
	if err != nil {
		return nil, err
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var out map[string]any
	if err := decoder.Decode(&out); err != nil {
		return nil, err
	}
	return out, nil
}

func marshalJSON(value any) ([]byte, error) {
	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte{'\n'}), nil
}

func (s *Server) sendReceipt(data []byte) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.cfg.ReceiptURL, bytes.NewReader(data))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	if s.cfg.ReceiptToken != "" {
		req.Header.Set("X-Kin-Gateway-Token", s.cfg.ReceiptToken)
		timestamp := time.Now().UTC().Format(time.RFC3339Nano)
		nonce, _ := randomURLToken(18)
		hash := BodyHash(data)
		req.Header.Set("X-Kin-Gateway-Timestamp", timestamp)
		req.Header.Set("X-Kin-Gateway-Nonce", nonce)
		req.Header.Set("X-Kin-Gateway-Body-Sha256", hash)
		req.Header.Set("X-Kin-Gateway-Signature", Sign(s.cfg.ReceiptToken, timestamp, nonce, hash, data))
	}
	client := &http.Client{Timeout: 10 * time.Second}
	if tlsConfig, tlsErr := s.controlTLSConfig(); tlsErr == nil && tlsConfig != nil {
		client.Transport = &http.Transport{TLSClientConfig: tlsConfig}
	}
	resp, err := client.Do(req)
	if err == nil {
		_ = resp.Body.Close()
	}
}

// upstreamHeaderName 返回允许从调用方透传到上游的请求头。认证、originator、User-Agent、
// version、安装 ID 与账号路由覆盖一律由 Worker 按账号和部署配置重建，不能透传调用方指纹；
// trace 头与 x-openai-fedramp 按 CPR 2016bda0 作为客户端业务头透传。
func safeResponseHeader(key string) bool {
	lower := strings.ToLower(key)
	return lower != "set-cookie" && lower != "authorization" && lower != "x-api-key"
}
func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{"ok": false, "error": map[string]string{"code": code, "message": message}})
}

func (s *Server) Serve(ctx context.Context) error {
	server := &http.Server{Addr: s.cfg.Listen, Handler: s.Handler()}
	if s.cfg.ControlPlaneURL != "" {
		go s.registrationLoop(ctx)
	}
	go s.refreshLoop(ctx)
	go s.protectionLoop(ctx)
	go s.backgroundLoop(ctx)
	go s.resetCreditLoop(ctx)
	go s.ws.sweepLoop(ctx)
	// 退出：等待在途请求结束（上限 shutdownGrace，控制面托管 10 秒后强杀），再写出延迟落盘的运行时状态
	stopped := make(chan struct{})
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownGrace)
		_ = server.Shutdown(shutdownCtx)
		cancel()
		_ = s.store.Close()
		if s.bps.disk != nil {
			_ = s.bps.disk.Flush()
		}
		_ = s.provenance.Flush()
		close(stopped)
	}()
	var err error
	if s.cfg.RequireMTLS {
		tlsConfig, tlsErr := s.serverTLSConfig()
		if tlsErr != nil {
			return tlsErr
		}
		listener, listenErr := net.Listen("tcp", s.cfg.Listen)
		if listenErr != nil {
			return listenErr
		}
		err = server.Serve(tls.NewListener(listener, tlsConfig))
	} else {
		if !s.cfg.AllowInsecure && strings.HasPrefix(strings.ToLower(s.cfg.AdvertiseURL), "https://") {
			return errors.New("https advertise_url requires require_mtls")
		}
		err = server.ListenAndServe()
	}
	if errors.Is(err, http.ErrServerClosed) {
		<-stopped
		return ctx.Err()
	}
	return err
}

// shutdownGrace 是收到退出信号后等待在途请求的上限，短于控制面托管的强杀宽限（10 秒）
const shutdownGrace = 8 * time.Second

func (s *Server) registrationLoop(ctx context.Context) {
	rejected := false
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	register := func() {
		s.mu.RLock()
		draining := s.draining
		drained := s.drained
		deadline := s.drainDeadline
		s.mu.RUnlock()
		drainState := "accepting"
		if draining {
			drainState = "draining"
		}
		if drained {
			drainState = "drained"
		}
		var drainDeadline any
		if (draining || drained) && !deadline.IsZero() {
			drainDeadline = deadline.UTC().Format(time.RFC3339Nano)
		}
		payload := map[string]any{"drain_deadline": drainDeadline, "id": s.cfg.InstanceID, "name": s.cfg.InstanceID, "base_url": s.cfg.AdvertiseURL, "transport": map[bool]string{true: "https", false: "http"}[s.cfg.RequireMTLS], "region": s.cfg.Region, "version": s.cfg.Version, "boot_id": s.cfg.BootID, "protocol_version": 1, "capabilities": map[string]any{"operations": []string{"responses", "chat", "images", "images.generations", "images.edits", "search", "models", "cancel", "oauth", "receipts", "projection", "live"}, "websocket": true, "upstream_websocket": true, "responses_ws_bridge": true, "mtls": s.cfg.RequireMTLS}, "health_state": "healthy", "drain_state": drainState, "active_concurrency": atomic.LoadInt64(&s.active), "last_heartbeat_at": time.Now().UTC().Format(time.RFC3339Nano), "protection_freezes": s.store.localFreezes(time.Now())}
		// 并发：瞬时在途、本周期峰值（上报后从当前在途重新计）与各账号在途
		active := atomic.LoadInt64(&s.active)
		peak := atomic.SwapInt64(&s.peak, active)
		payload["peak_concurrency"] = max(peak, active)
		payload["account_inflight"] = s.store.inflight()
		payload["account_credentials"] = s.store.credentialStates()
		payload["account_revisions"] = s.store.accountRevisions()
		// 账号额度快照随心跳同步给控制面（后台 /wham/usage、请求响应头与流内 rate_limits 的结果）
		quotaReports, quotaFingerprints := s.quotaReports.pending(s.store.snapshot())
		if len(quotaReports) > 0 {
			payload["account_quotas"] = quotaReports
		}
		// BPS 403 恢复探测记录（控制面记入账号探测记录，不进使用记录）
		probes := s.pendingBPSProbes()
		if len(probes) > 0 {
			payload["bps_probes"] = probes
		}
		data, err := marshalJSON(payload)
		if err != nil {
			return
		}
		req, err := http.NewRequest(http.MethodPost, s.cfg.ControlPlaneURL, bytes.NewReader(data))
		if err != nil {
			return
		}
		req.Header.Set("Content-Type", "application/json")
		token := s.cfg.ControlPlaneToken
		if token == "" {
			token = s.cfg.InternalToken
		}
		if token != "" {
			req.Header.Set("X-Kin-Gateway-Token", token)
			timestamp := time.Now().UTC().Format(time.RFC3339Nano)
			nonce, _ := randomURLToken(18)
			hash := BodyHash(data)
			req.Header.Set("X-Kin-Gateway-Timestamp", timestamp)
			req.Header.Set("X-Kin-Gateway-Nonce", nonce)
			req.Header.Set("X-Kin-Gateway-Body-Sha256", hash)
			req.Header.Set("X-Kin-Gateway-Signature", Sign(token, timestamp, nonce, hash, data))
		}
		client := &http.Client{Timeout: 10 * time.Second}
		if tlsConfig, tlsErr := s.controlTLSConfig(); tlsErr == nil && tlsConfig != nil {
			client.Transport = &http.Transport{TLSClientConfig: tlsConfig}
		}
		resp, err := client.Do(req)
		if err == nil {
			// 心跳响应携带控制面的后台策略（账号错误保护、预热）
			if resp.StatusCode < 300 {
				body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
				s.applyHeartbeatPolicy(body)
				s.quotaReports.commit(quotaFingerprints)
				s.commitBPSProbes(probes)
				rejected = false
			} else if resp.StatusCode == http.StatusConflict && !rejected {
				// 控制面处于单 Worker 模式且已有其他在线实例：只在状态变化时提示一次，之后照常重试
				body, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
				log.Printf("codex-gateway: control plane refused registration: %s", strings.TrimSpace(string(body)))
				rejected = true
			}
			_ = resp.Body.Close()
		}
	}
	register()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			register()
		}
	}
}

func parseURL(raw string) (*url.URL, error) { return url.Parse(raw) }

func safeReceiptHeaders(headers http.Header) map[string]string {
	result := map[string]string{}
	for key, values := range headers {
		if !safeResponseHeader(key) || strings.EqualFold(key, "set-cookie") || strings.EqualFold(key, "authorization") {
			continue
		}
		if len(values) > 0 {
			result[strings.ToLower(key)] = values[len(values)-1]
		}
	}
	return result
}
