package codexgateway

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
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
	// shared：Redis 共享运行态（P5，shared_state.go）；未配置时为 nil
	shared *sharedState
	// facts 是 Gateway 事实直读的只读读取器与影子比对（设计第 19 节）；未配置 KIN_CODEX_GATEWAY_FACTS_DB 时为 nil
	facts *factsState
	// sharedConfigErr：KIN_REDIS_URL 配置有误（无法解析）时的原因（不含地址）；Worker 照常以本地状态接单，状态报告降级
	sharedConfigErr string
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
	// events 是执行契约的事件发件箱（events.go）；quotaEvents 记录已写成事件的额度指纹，与心跳上报分开
	events      *eventLog
	quotaEvents *quotaReporter
	// refreshLease：控制面是否要求刷新前先取得租约（心跳策略 refresh_lease.required，refresh_lease.go）。
	// 三态：leasePolicyUnknown / leasePolicyOff / leasePolicyOn，最近一次策略落盘，重启后沿用（终审 B1）
	refreshLease atomic.Int32
	// leasePolicyReceived：本次启动已收到心跳策略（定时刷新等它，PF.2 复核 N2）
	leasePolicyReceived atomic.Bool
	// refreshDesignated：控制面指派给本实例做定时预刷新的账号（nil 表示不限制，refresh_lease.go）
	refreshDesignated atomic.Pointer[map[string]bool]
	// settingsRevision：最近一次从心跳策略应用的控制面 Codex 设置版本（P4.3）
	settingsRevision atomic.Int64
	// custodyKey：实例托管私钥，控制面按其公钥封装凭据（custody.go）
	custodyKey *ecdh.PrivateKey
	stateEvent string
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
	// 授权会话改由控制面保存（P3.7）：删除旧版本留下的会话文件（含 PKCE verifier）
	_ = os.Remove(filepath.Join(cfg.DataDir, "oauth-sessions.json"))
	store.SetDefaultConcurrency(cfg.AccountConcurrency)
	store.SetQueueLimits(cfg.GuardianConcurrency, cfg.MaxWaitingPerAcct, time.Duration(cfg.SessionTTLHours)*time.Hour)
	server := &Server{cfg: cfg, store: store, nonces: map[string]time.Time{}, cancels: map[string]context.CancelFunc{}, drainForced: map[string]bool{}, refresher: newRefresher(), ws: newWSPool(), catalog: catalogCache{entries: map[string]catalogEntry{}}, clients: map[string]*http.Client{}, protection: loadProtectionPolicies(filepath.Join(cfg.DataDir, "account_protection_policy.json")), guardian: newGuardianRouting(), cyberPolicy: newCyberPolicyExclusions(), clientRetry: newClientRetryFailures(), oauthRecovery: newOAuthRecoveryLog(cfg), avatarSources: map[string]avatarSourceEntry{}, runtime: loadRuntimePolicy(filepath.Join(cfg.DataDir, "runtime_policy.json")), quotas: newQuotaScheduler(), plans: &planCatalogs{entries: map[string]planCatalog{}}, wsSessions: newWSSessionBudget(), live: newLiveRegistry(), releases: newReleaseStore(filepath.Join(cfg.DataDir, "client_releases.json")), profilePolicy: &profilePolicy{}, privacy: newPrivacyCache(), releaseFetcher: newReleaseFetcher(), quotaReports: newQuotaReporter()}
	store.eligible = server.accountEligible
	if server.events, err = openEventLog(filepath.Join(cfg.DataDir, "events"), cfg.InstanceID); err != nil {
		return nil, err
	}
	server.quotaEvents = newQuotaReporter()
	if server.custodyKey, err = loadCustodyKey(cfg.DataDir); err != nil {
		return nil, err
	}
	log.Printf("codex-gateway: custody key fingerprint %s", server.custodyKeyFingerprint())
	if cfg.ControlPlaneURL == "" {
		// 不接控制面：没有消费者，事件只保留 24 小时供排障
		server.events.setRequired(false)
	}
	server.refreshLease.Store(server.initialLeasePolicy())
	// 共享运行态（P5）：配置 KIN_REDIS_URL 时多实例经 Redis 共享协议状态、并发与冷却
	if server.shared, err = newSharedState(cfg); err != nil {
		// Redis 可丢、不影响接单：地址写错时退回本地状态并在健康与心跳中报告降级，不让整个 Worker 起不来（审计 U9）
		server.shared, server.sharedConfigErr = nil, err.Error()
		log.Printf("codex-gateway: shared state disabled: %v", err)
		err = nil
	}
	// BPS 工具回放与会话目录跨重启保留（bps_state.go）；配置 Redis 时存进 Redis（shared_bps_state.go）
	disk := newBPSDiskState(filepath.Join(cfg.DataDir, "bps_state"), store)
	if err := disk.importLegacy(filepath.Join(cfg.DataDir, "bps_state.json")); err != nil {
		log.Printf("codex-gateway: import legacy bps_state.json: %v", err)
	}
	server.bps.disk = disk
	if server.shared != nil {
		server.bps.disk = &sharedBPSState{shared: server.shared, disk: disk}
	}
	if cfg.FactsDB != "" && cfg.FactsMode != "off" {
		// 事实直读读不出不影响接单（G2 只做影子比对）：打不开时记日志并关闭
		if reader, err := OpenFactsReader(cfg.FactsDB, cfg.CredentialMasterKeyFile, cfg.DBSecret); err != nil {
			log.Printf("codex-gateway: facts reader disabled: %v", err)
		} else {
			server.facts = &factsState{reader: reader}
		}
	}
	server.provenance = newRouteProvenance(filepath.Join(cfg.DataDir, "route_provenance.json"), store)
	server.provenance.shared = server.shared
	store.leases = newSharedLeases(server.shared)
	store.holds = newSharedHolds(server.shared, store)
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
	mux.HandleFunc("/internal/v1/events", s.eventsRead)
	mux.HandleFunc("/internal/v1/schema/settings", s.schemaHandler("codex-settings.json"))
	mux.HandleFunc("/internal/v1/schema/account", s.schemaHandler("codex-account.json"))
	mux.HandleFunc("/internal/v1/events/ack", s.eventsAck)
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
	healthState := "healthy"
	if !s.events.accepting() {
		healthState = "degraded"
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "service": "kin-codex-gateway", "id": s.cfg.InstanceID, "boot_id": s.cfg.BootID, "region": s.cfg.Region, "version": s.cfg.Version, "protocol_version": 1, "contract": map[string]int{"min": executorContractVersion, "max": executorContractVersion}, "events": s.events.status(), "settings_revision": s.settingsRevision.Load(), "custody_key_fingerprint": s.custodyKeyFingerprint(), "shared_state": s.sharedStatus(), "facts": s.factsStatus(), "health_state": healthState, "drain_state": drainState, "draining": draining, "drain_deadline": func() any {
		if deadline.IsZero() {
			return nil
		}
		return deadline.UTC().Format(time.RFC3339Nano)
	}(), "active_concurrency": atomic.LoadInt64(&s.active), "account_count": len(s.store.List())})
}

func (s *Server) capabilities(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"version": 1, "service": "kin-codex-gateway", "operations": []string{"responses", "chat", "images", "images.generations", "images.edits", "search", "models", "cancel", "oauth", "receipts", "events", "projection", "live"}, "contract": map[string]int{"min": executorContractVersion, "max": executorContractVersion}, "protocols": []string{"openai.responses", "openai.chat", "openai.images", "openai.search"}, "websocket": true, "upstream_websocket": true, "responses_ws_bridge": true, "custody": s.custodyKey != nil, "signed_exports": true, "settings_schema": schemaCapabilities()["settings_schema"], "account_schema": schemaCapabilities()["account_schema"], "authorizations": accountAuthorizations, "mtls": s.cfg.RequireMTLS})
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
	if len(parts) == 1 && r.Method == http.MethodDelete {
		// 永久删除：控制面删除账号后逐实例调用，移除账号记录、凭据与本地运行态；不存在时回 404 account_not_found
		if err := s.store.Delete(accountID); err != nil {
			if errors.Is(err, os.ErrNotExist) {
				writeError(w, http.StatusNotFound, "account_not_found", "account not found")
				return
			}
			writeError(w, http.StatusInternalServerError, "account_delete_failed", err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "deleted": accountID})
		return
	}
	if len(parts) == 2 && parts[1] == "export" && (r.Method == http.MethodGet || r.Method == http.MethodPost) {
		// 导出响应签名（终审 B3）：control 托管时控制面据此把凭据写入凭据库，传输层不能篡改或重放旧凭据包
		account, ok := s.store.Get(accountID)
		if !ok {
			s.writeSignedJSON(w, r, http.StatusNotFound, map[string]any{"ok": false, "error": map[string]string{"code": "account_not_found", "message": "account not found"}})
			return
		}
		bundle, err := s.sealCredentialBundle(account)
		if err != nil {
			s.writeSignedJSON(w, r, http.StatusInternalServerError, map[string]any{"ok": false, "error": map[string]string{"code": "credential_export_failed", "message": err.Error()}})
			return
		}
		// installation_id 不进公开视图；控制面据签名响应把它记为账号字段（Gateway 事实直读 G2，设计第 19 节）
		s.writeSignedJSON(w, r, http.StatusOK, map[string]any{"ok": true, "account": publicAccount(account), "credential_bundle": bundle, "installation_id": account.InstallationID})
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
		// 凭据来源：控制面按本实例公钥封装的 custody_bundle（KIN_CREDENTIAL_CUSTODY=control，P3.5），
		// 或实例间共享密钥加密的 credential_bundle（从其他实例导出的副本）
		bundleField, open := "credential_bundle", s.openCredentialBundle
		local, hasLocal := s.store.Get(accountID)
		// 两种凭据包都不允许回退：本地已有更高的凭据代次时拒绝投影（R3 审查 P2-2、复审 N1）
		if hasLocal && local.CredentialRevision > account.CredentialRevision && (len(payload["custody_bundle"]) > 0 || len(payload["credential_bundle"]) > 0) {
			// 带上本地代次：控制面据此把本实例的绑定代次按 MAX 推进，下一次心跳以本实例为投影来源，
			// 轮换报告丢失时也能自动恢复（R3 复审 M1）
			writeJSON(w, http.StatusConflict, map[string]any{"ok": false, "error": map[string]string{"code": "credential_revision_stale", "message": "the projected credential revision is older than the local copy"}, "account": map[string]any{"id": accountID, "credential_revision": local.CredentialRevision}})
			return
		}
		if raw := payload["custody_bundle"]; len(raw) > 0 && string(raw) != "null" {
			// 托管封装绑定导入元数据的两种代次
			generation := int64(0)
			if account.BPS != nil {
				generation = account.BPS.TokenGeneration
			}
			revision := account.CredentialRevision
			bundleField, open = "custody_bundle", func(bundle, id string) (credentialBundle, error) {
				return s.openCustodyBundle(bundle, id, revision, generation)
			}
		}
		if raw := payload[bundleField]; len(raw) > 0 {
			var bundle string
			_ = json.Unmarshal(raw, &bundle)
			if bundle != "" {
				secrets, err := open(bundle, accountID)
				if err != nil {
					writeError(w, 400, bundleField+"_invalid", err.Error())
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
					// 本地 BPS 令牌代次更高（本实例刷新过、报告还没送达）：保留本地 BPS 令牌，不用投影来的旧令牌覆盖（R3 复审 N1）
					if hasLocal && local.BPS != nil && local.BPS.TokenGeneration > account.BPS.TokenGeneration && local.BPS.Revision >= account.BPS.Revision {
						kept := *local.BPS
						account.BPS = &kept
					}
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
	if !s.events.accepting() {
		// 事件日志写入故障或积压超限：结果无法可靠交给控制面结算，不接新请求（请求未发出，可换实例）
		w.Header().Set(sendStateHeader, sendStateNotSent)
		writeError(w, http.StatusServiceUnavailable, "executor_event_log_unavailable", "executor event log is unavailable")
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
	// 同一份结果写成 request.finalized 事件（载荷与回执相同）；写入失败时事件日志进入故障状态，Worker 停止接新请求
	subject := map[string]string{"dispatch_id": dispatch}
	for _, key := range []string{"request_id", "runtime_account_id"} {
		if text, ok := value[key].(string); ok && text != "" {
			subject[key] = text
		}
	}
	if _, eventErr := s.events.append(EventRequestFinalized, subject, value); eventErr != nil {
		log.Printf("codex-gateway: request.finalized event not recorded for %s: %v", dispatch, eventErr)
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
	go s.eventSnapshotLoop(ctx)
	go s.refreshLoop(ctx)
	go s.protectionLoop(ctx)
	go s.backgroundLoop(ctx)
	go s.resetCreditLoop(ctx)
	go s.ws.sweepLoop(ctx)
	go s.shared.loop(ctx)
	s.startFacts(ctx)
	go s.store.leases.loop(ctx)
	go s.store.holds.loop(ctx)
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
		_ = s.events.close()
		_ = s.shared.Close()
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
		payload := map[string]any{"drain_deadline": drainDeadline, "id": s.cfg.InstanceID, "name": s.cfg.InstanceID, "base_url": s.cfg.AdvertiseURL, "transport": map[bool]string{true: "https", false: "http"}[s.cfg.RequireMTLS], "region": s.cfg.Region, "version": s.cfg.Version, "boot_id": s.cfg.BootID, "protocol_version": 1, "capabilities": map[string]any{"operations": []string{"responses", "chat", "images", "images.generations", "images.edits", "search", "models", "cancel", "oauth", "receipts", "events", "projection", "live"}, "contract": map[string]int{"min": executorContractVersion, "max": executorContractVersion}, "websocket": true, "upstream_websocket": true, "responses_ws_bridge": true, "custody": s.custodyKey != nil, "signed_exports": true, "settings_schema": schemaCapabilities()["settings_schema"], "account_schema": schemaCapabilities()["account_schema"], "authorizations": accountAuthorizations, "mtls": s.cfg.RequireMTLS}, "health_state": "healthy", "drain_state": drainState, "active_concurrency": atomic.LoadInt64(&s.active), "protection_freezes": s.store.localFreezes(time.Now())}
		// 实例托管公钥：控制面以凭据库托管令牌时按它封装投影（P3.5）
		payload["custody_public_key"] = s.custodyPublicKey()
		// 已应用的 Codex 设置版本：控制面据此确认设置已收敛到本实例
		payload["settings_revision"] = s.settingsRevision.Load()
		// 共享运行态（P5）：控制面「Gateway Worker」页展示 Redis 是否可用
		payload["shared_state"] = s.sharedStatus()
		if facts := s.factsStatus(); facts != nil {
			payload["facts"] = facts
		}
		// 事件发件箱水位：控制面据此决定是否立即拉取，并监控积压
		events := s.events.status()
		payload["events"] = events
		if !s.events.accepting() {
			payload["health_state"] = "degraded"
		}
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
		s.signControlRequest(req, data)
		resp, err := s.controlClient(10 * time.Second).Do(req)
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
