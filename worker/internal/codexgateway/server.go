package codexgateway

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
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
	// facts 是 Gateway 事实直读的读取器（设计第 19 节）；未配置 KIN_CODEX_GATEWAY_FACTS_DB 时为 nil
	facts *factsState
	cfg   Config
	store *Store
	// controlErrors：注册（心跳）请求的网络与 TLS 错误限频日志（control_errors.go）
	controlErrors controlErrorLog
	// provenance 记录原生输出密文的签发账号（route_provenance.go）
	provenance    *routeProvenance
	mu            sync.RWMutex
	draining      bool
	drained       bool
	drainDeadline time.Time
	nonces        map[string]time.Time
	cancels       map[string]context.CancelFunc
	// drainForced 记录因 Drain 截止时间或停机被强制取消的 dispatch 及原因，Receipt 据此标注 error_code
	drainForced map[string]string
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
	// events 是执行契约的事件发件箱（events.go）；quotaEvents 记录已写成事件的额度指纹，与心跳上报分开
	events      *eventLog
	quotaEvents *quotaReporter
	// settingsRevision：最近一次从心跳策略应用的控制面 Codex 设置版本（P4.3）
	settingsRevision atomic.Int64
	// requestExit：让 Serve 退出（托管器随后以新的引导令牌重新拉起）
	requestExit func()
	stateEvent  string
}

func NewServer(cfg Config) (*Server, error) {
	// 账号库以凭据 bundle 密钥派生的独立密钥加密落盘；未配置该密钥（不接控制面的本机调试）时保持明文
	store, err := OpenSealedStore(cfg.AccountsPath(), cfg.CredentialBundleKey)
	if err != nil {
		return nil, err
	}
	// 授权会话改由控制面保存（P3.7）：删除旧版本留下的会话文件（含 PKCE verifier）
	_ = os.Remove(filepath.Join(cfg.DataDir, "oauth-sessions.json"))
	store.SetDefaultConcurrency(cfg.AccountConcurrency)
	store.SetQueueLimits(cfg.GuardianConcurrency, cfg.MaxWaitingPerAcct, time.Duration(cfg.SessionTTLHours)*time.Hour)
	server := &Server{cfg: cfg, store: store, nonces: map[string]time.Time{}, cancels: map[string]context.CancelFunc{}, drainForced: map[string]string{}, refresher: newRefresher(), ws: newWSPool(), catalog: catalogCache{entries: map[string]catalogEntry{}}, clients: map[string]*http.Client{}, protection: loadProtectionPolicies(filepath.Join(cfg.DataDir, "account_protection_policy.json")), guardian: newGuardianRouting(), cyberPolicy: newCyberPolicyExclusions(), clientRetry: newClientRetryFailures(), oauthRecovery: newOAuthRecoveryLog(cfg), avatarSources: map[string]avatarSourceEntry{}, runtime: loadRuntimePolicy(filepath.Join(cfg.DataDir, "runtime_policy.json")), quotas: newQuotaScheduler(), plans: &planCatalogs{entries: map[string]planCatalog{}}, wsSessions: newWSSessionBudget(), live: newLiveRegistry(), releases: newReleaseStore(filepath.Join(cfg.DataDir, "client_releases.json")), profilePolicy: &profilePolicy{}, privacy: newPrivacyCache(), releaseFetcher: newReleaseFetcher()}
	store.eligible = server.accountEligible
	if server.events, err = openEventLog(filepath.Join(cfg.DataDir, "events"), cfg.InstanceID); err != nil {
		return nil, err
	}
	server.quotaEvents = newQuotaReporter()
	if cfg.ControlPlaneURL == "" {
		// 不接控制面：没有消费者，事件只保留 24 小时供排障
		server.events.setRequired(false)
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
	if roots, err := loadCustomCA(); err != nil {
		return nil, err
	} else if roots != nil {
		server.upstreamRoots, server.customCA = roots, true
	}
	return server, nil
}

// factsStale：启用了事实直读且距最近一次成功读取超过 factsStaleAfter。
func (s *Server) factsStale(now time.Time) bool {
	return s.facts != nil && s.facts.reader.Stale(now)
}

// factsMode 是事实直读的状态：primary 表示账号来自控制面数据库（设计第 19 节），off 表示没有配置事实库（本机调试）
func (s *Server) factsMode() string {
	if s.facts == nil {
		return "off"
	}
	return "primary"
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
	mux.HandleFunc("/internal/v1/events/ack", s.eventsAck)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authenticated, err := s.authenticate(r)
		if err != nil {
			writeError(w, http.StatusUnauthorized, "invalid_internal_auth", err.Error())
			return
		}
		mux.ServeHTTP(w, authenticated)
	})
}

// authenticate 校验控制面请求的签名（v1，本进程的内部令牌：托管时为会话密钥，否则为共用令牌）。
// 返回的请求在上下文里带着验证用的令牌，事件页等响应签名用同一把。
func (s *Server) authenticate(r *http.Request) (*http.Request, error) {
	secret := s.cfg.InternalToken
	body, err := io.ReadAll(io.LimitReader(r.Body, 64<<20))
	if err != nil {
		return r, err
	}
	r.Body = io.NopCloser(bytes.NewReader(body))
	if r.URL.Path == "/internal/v1/live/sideband" {
		// WebSocket 升级没有正文：签名覆盖 X-Kin-Gateway-Live 中的 sideband 参数
		body = []byte(r.Header.Get("X-Kin-Gateway-Live"))
	}
	if err := Verify(
		secret,
		r.Header.Get("X-Kin-Gateway-Timestamp"),
		r.Header.Get("X-Kin-Gateway-Nonce"),
		r.Header.Get("X-Kin-Gateway-Body-Sha256"),
		r.Header.Get("X-Kin-Gateway-Signature"),
		body,
		time.Now(),
		s.cfg.ClockSkew,
	); err != nil {
		return r, err
	}
	if s.seenNonce(r.Header.Get("X-Kin-Gateway-Nonce")) {
		return r, errors.New("request nonce already used")
	}
	return r.WithContext(context.WithValue(r.Context(), verifiedSecretKey{}, secret)), nil
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
	if !s.events.accepting() || s.factsStale(time.Now()) {
		healthState = "degraded"
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "service": "kin-codex-gateway", "id": s.cfg.InstanceID, "boot_id": s.cfg.BootID, "region": s.cfg.Region, "version": s.cfg.Version, "protocol_version": 1, "contract": map[string]int{"min": executorContractVersion, "max": executorContractVersion}, "events": s.events.status(), "settings_revision": s.settingsRevision.Load(), "facts": s.factsStatus(), "health_state": healthState, "drain_state": drainState, "draining": draining, "drain_deadline": func() any {
		if deadline.IsZero() {
			return nil
		}
		return deadline.UTC().Format(time.RFC3339Nano)
	}(), "active_concurrency": atomic.LoadInt64(&s.active), "account_count": len(s.store.List())})
}

func (s *Server) capabilities(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"version": 1, "service": "kin-codex-gateway", "operations": []string{"responses", "chat", "images", "images.generations", "images.edits", "search", "models", "cancel", "receipts", "events", "live"}, "contract": map[string]int{"min": executorContractVersion, "max": executorContractVersion}, "protocols": []string{"openai.responses", "openai.chat", "openai.images", "openai.search"}, "websocket": true, "upstream_websocket": true, "responses_ws_bridge": true, "settings_schema": schemaCapabilities()["settings_schema"], "facts": s.factsMode()})
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
	current := s.drainEpoch == epoch && s.draining
	s.mu.Unlock()
	if current {
		s.cancelInflight(drainReasonDeadline)
	}
}

// takeDrainForced 返回该 dispatch 被强制取消的原因（drain_deadline / worker_shutdown），没有时为空。
func (s *Server) takeDrainForced(dispatch string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	reason := s.drainForced[dispatch]
	delete(s.drainForced, dispatch)
	return reason
}

func (s *Server) accounts(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		writeJSON(w, http.StatusOK, map[string]any{"items": s.store.List()})
		return
	}
	// 账号由控制面写库、Worker 直读（S1 起不再接受推送或导入）
	writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "accounts are read from the control-plane database")
}

func (s *Server) accountAction(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.Trim(strings.TrimPrefix(r.URL.Path, "/internal/v1/accounts/"), "/"), "/")
	if len(parts) == 0 || parts[0] == "" {
		writeError(w, http.StatusNotFound, "account_not_found", "account not found")
		return
	}
	accountID := parts[0]
	if len(parts) == 2 && s.accountInsight(w, r, accountID, parts[1]) {
		return
	}
	if len(parts) != 2 || r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed")
		return
	}
	switch parts[1] {
	case "recover":
		if err := s.store.Recover(accountID); err != nil {
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
	// 事实陈旧（库被锁、文件被换掉后读不出等超过 2 分钟）：账号的启停、分组与凭据可能已变，不能按旧事实调度（审计 P1-C7）
	if s.factsStale(time.Now()) {
		w.Header().Set(sendStateHeader, sendStateNotSent)
		writeError(w, http.StatusServiceUnavailable, "gateway_facts_stale", "control-plane account facts are stale; the Worker is not scheduling requests")
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
	run.cachePreference = run.deriveCachePreference(parsedBody)
	run.clientTurn = run.clientTurnKey()
	run.retrySuppressed = s.clientRetry.has(run.clientTurn, time.Now())
	if previousID, _ := parsedBody["previous_response_id"].(string); previousID != "" && envelope.ConnectionKey != "" {
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
	// 结算只走事件通道（2026-11-07 S2）：request.finalized 写进事件日志（fsync）即算交付，控制面拉取后写回执表并结算；
	// 写入失败时事件日志进入故障状态，Worker 停止接新请求（控制面消费事件时）
	if _, err := s.events.append(EventRequestFinalized, subject, value); err != nil {
		log.Printf("codex-gateway: request.finalized event not recorded for %s: %v", dispatch, err)
		return err
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

func (s *Server) Serve(parent context.Context) error {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	s.requestExit = cancel
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
	s.startFacts(ctx)
	// 退出：等待在途请求结束，仍未结束的按停机取消并写出回执（shutdownHTTP），再写出延迟落盘的运行时状态
	stopped := make(chan struct{})
	go func() {
		<-ctx.Done()
		s.shutdownHTTP(server)
		_ = s.store.Close()
		_ = s.provenance.Flush()
		_ = s.events.close()
		close(stopped)
	}()
	err := server.ListenAndServe()
	if errors.Is(err, http.ErrServerClosed) {
		<-stopped
		return ctx.Err()
	}
	return err
}

// shutdownGrace 是收到退出信号后等待在途请求的上限，短于控制面托管的强杀宽限（10 秒）；托管器在 SIGTERM 前已先排空
// （/internal/v1/drain，最长 120 秒），这里只处理排空后仍在途的请求
const shutdownGrace = 8 * time.Second

// shutdownCancelAfter：收到退出信号后在途请求仍未结束，到它时按停机取消（回执 worker_shutdown，带已消耗的部分用量），
// 留出 shutdownGrace 的剩余时间写回执；测试可调短
var shutdownCancelAfter = 5 * time.Second

// shutdownHTTP 停止接单并等待在途请求结束；超过 shutdownCancelAfter 仍在途的请求按停机取消，处理器随之写出
// cancelled 回执（流已交付的部分用量照常记入），回执写进事件日志后才关闭存储（审计 P2-11）。
func (s *Server) shutdownHTTP(server *http.Server) {
	s.mu.Lock()
	s.draining = true
	s.mu.Unlock()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownGrace)
	defer cancel()
	force := time.AfterFunc(shutdownCancelAfter, func() { s.cancelInflight(drainReasonShutdown) })
	defer force.Stop()
	_ = server.Shutdown(shutdownCtx)
}

// cancelInflight 取消全部在途请求并记下原因（回执的 error_code）。
func (s *Server) cancelInflight(reason string) {
	s.mu.Lock()
	cancels := make([]context.CancelFunc, 0, len(s.cancels))
	for dispatch, cancel := range s.cancels {
		s.drainForced[dispatch] = reason
		cancels = append(cancels, cancel)
	}
	s.mu.Unlock()
	for _, cancel := range cancels {
		cancel()
	}
}

// 在途请求被强制取消的原因：排空截止时间到（drain_deadline）或进程停机（worker_shutdown）
const (
	drainReasonDeadline = "drain_deadline"
	drainReasonShutdown = "worker_shutdown"
)

func (s *Server) registrationLoop(ctx context.Context) {
	rejected := false
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	register := func() bool { return s.registerOnce(&rejected) }
	if register() {
		register()
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if register() {
				register()
			}
		}
	}
}

// registerOnce 向控制面注册（心跳）一次。返回 true 表示应立即再注册一次：刚换上新实例密钥（让控制面尽快确认），
// 或实例密钥刚被控制面拒绝并已删除（用共用令牌重新注册）。
// rejected 记录上一次是否被拒，被拒原因只在状态变化时打印一次。
func (s *Server) registerOnce(rejected *bool) bool {
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
	payload := map[string]any{"drain_deadline": drainDeadline, "id": s.cfg.InstanceID, "name": s.cfg.InstanceID, "base_url": s.cfg.AdvertiseURL, "transport": "http", "region": s.cfg.Region, "version": s.cfg.Version, "boot_id": s.cfg.BootID, "protocol_version": 1, "capabilities": map[string]any{"operations": []string{"responses", "chat", "images", "images.generations", "images.edits", "search", "models", "cancel", "receipts", "events", "live"}, "contract": map[string]int{"min": executorContractVersion, "max": executorContractVersion}, "websocket": true, "upstream_websocket": true, "responses_ws_bridge": true, "settings_schema": schemaCapabilities()["settings_schema"], "facts": s.factsMode()}, "health_state": "healthy", "drain_state": drainState, "active_concurrency": atomic.LoadInt64(&s.active), "protection_freezes": s.store.localFreezes(time.Now())}
	// 已应用的 Codex 设置版本：控制面据此确认设置已收敛到本实例
	payload["settings_revision"] = s.settingsRevision.Load()
	if facts := s.factsStatus(); facts != nil {
		payload["facts"] = facts
		// 读不到控制面事实（库被锁、主密钥缺失、契约不匹配）时标为 degraded，面板与告警可见；
		// 超过 factsStaleAfter 仍读不到时拒绝调度（gateway_facts_stale）
		if status, ok := facts["status"].(FactsStatus); ok && (status.LastError != "" || status.Stale) {
			payload["health_state"] = "degraded"
		}
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
	// 账号凭据终态与额度快照只走事件（account.state、account.quota，2026-11-07 S2）
	data, err := marshalJSON(payload)
	if err != nil {
		return false
	}
	req, err := http.NewRequest(http.MethodPost, s.cfg.ControlPlaneURL, bytes.NewReader(data))
	if err != nil {
		return false
	}
	call := s.signControlRequest(req, data)
	resp, err := s.controlClient(10 * time.Second).Do(req)
	if err != nil {
		// 网络与 TLS 错误（控制面不可达、证书名称不符等）限频记日志，照常在下一周期重试
		s.controlErrors.note(s.cfg.ControlPlaneURL, err)
		return false
	}
	defer resp.Body.Close()
	// 心跳响应携带控制面的后台策略（账号错误保护、预热）：只采信验签通过的响应
	if resp.StatusCode < 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		if !call.verifyResponse(resp.StatusCode, resp.Header, body) {
			log.Printf("codex-gateway: ignoring an unverified control plane response")
			return false
		}
		s.applyHeartbeatPolicy(body)
		*rejected = false
		return false
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 16<<10))
	if (resp.StatusCode == http.StatusConflict || resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden) && !*rejected {
		// 单 Worker 模式下已有其他在线实例（409），或认证被拒（令牌不符）：
		// 只在状态变化时提示一次，之后照常重试
		log.Printf("codex-gateway: control plane refused registration: %s", strings.TrimSpace(string(body)))
		*rejected = true
	}
	return false
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
