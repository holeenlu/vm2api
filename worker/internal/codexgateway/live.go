package codexgateway

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// Codex Live / Realtime 语音（对齐 codex-proxy-rs provider/live.rs、transport/client_live.rs、websocket/live.rs）：
//   - 通话引导：operation=live 的 execute 走正常选号（仅 OAuth、排除 Free 套餐），POST
//     {base}/realtime/calls?intent=quicksilver&architecture=avas，正文与响应原样转发；成功响应的 Location 中的
//     call id 登记到进程内注册表并钉住创建账号（1 小时，不持久化）。
//   - sideband：控制面经签名内部 WS 接入，Worker 认领 call（同一调用方、无并发 sideband）后用钉住账号的凭据
//     直连 wss://api.openai.com/v1 的对应端点，双向原样中继帧；断开只释放认领，上游 404/410 时删除登记。
//   - hangup：同一调用方随时可挂断（不要求认领），POST {api}/realtime/calls/{id}/hangup。
//
// Live 请求不继承 Responses 的路由提示、turn-state 与续接字段，turn metadata 按归属不明清理。
const (
	liveCallsQuery     = "intent=quicksilver&architecture=avas"
	liveSessionTTL     = time.Hour
	defaultLiveAPIBase = "https://api.openai.com/v1"
	maxLiveCalls       = 4096
)

type liveEntry struct {
	account     string
	clientScope string
	model       string
	profile     wireProfile
	expiresAt   time.Time
	claimed     bool
}

type liveRegistry struct {
	mu      sync.Mutex
	entries map[string]*liveEntry
}

func newLiveRegistry() *liveRegistry { return &liveRegistry{entries: map[string]*liveEntry{}} }

func validCallID(id string) bool {
	if id == "" || len(id) > 128 {
		return false
	}
	for _, c := range id {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' || c == '-') {
			return false
		}
	}
	return true
}

// callIDFromLocation 接受裸 id、`?call_id=` 与路径尾段三种形态。
func callIDFromLocation(location string) string {
	location = strings.TrimSpace(location)
	if validCallID(location) {
		return location
	}
	if index := strings.Index(location, "call_id="); index >= 0 {
		candidate, _, _ := strings.Cut(location[index+len("call_id="):], "&")
		if validCallID(candidate) {
			return candidate
		}
	}
	path := location
	if _, rest, ok := strings.Cut(location, "//"); ok {
		_, path, _ = strings.Cut(rest, "/")
	}
	path, _, _ = strings.Cut(path, "?")
	path = strings.TrimRight(path, "/")
	if index := strings.LastIndex(path, "/"); index >= 0 {
		path = path[index+1:]
	}
	if validCallID(path) {
		return path
	}
	return ""
}

func (r *liveRegistry) sweepLocked(now time.Time) {
	for id, entry := range r.entries {
		if !entry.claimed && !entry.expiresAt.After(now) {
			delete(r.entries, id)
		}
	}
}

func (r *liveRegistry) register(callID, account, clientScope, model string, profile wireProfile) {
	if !validCallID(callID) {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	now := time.Now()
	r.sweepLocked(now)
	if len(r.entries) >= maxLiveCalls {
		return
	}
	r.entries[callID] = &liveEntry{account: account, clientScope: clientScope, model: model, profile: profile, expiresAt: now.Add(liveSessionTTL)}
}

var (
	errLiveCallMissing  = errors.New("The voice call was not found or has expired.")
	errLiveCallBusy     = errors.New("The voice call already has an active event connection.")
	errLiveOwner        = errors.New("This API key cannot access the voice call.")
	errLiveInvalidCall  = errors.New("The voice call ID is invalid.")
	errLiveAccountGone  = errors.New("The account for this voice call is unavailable.")
	errLiveUnsupported  = errors.New("Voice calls require an OpenAI OAuth account.")
	errLiveConnectFails = errors.New("The voice connection could not be established.")
)

func liveErrorStatus(err error) (int, string) {
	switch {
	case errors.Is(err, errLiveInvalidCall):
		return http.StatusBadRequest, "invalid_call_id"
	case errors.Is(err, errLiveCallMissing):
		return http.StatusNotFound, "call_not_found"
	case errors.Is(err, errLiveCallBusy):
		return http.StatusConflict, "call_busy"
	case errors.Is(err, errLiveOwner):
		return http.StatusForbidden, "owner_mismatch"
	case errors.Is(err, errLiveUnsupported):
		return http.StatusNotImplemented, "unsupported"
	case errors.Is(err, errLiveAccountGone):
		return http.StatusServiceUnavailable, "credential_unavailable"
	}
	return http.StatusBadGateway, "upstream_unavailable"
}

// claim 认领 call：校验调用方并阻止并发 sideband；认领期间暂停过期。
func (r *liveRegistry) claim(callID, clientScope string) (liveEntry, error) {
	if !validCallID(callID) {
		return liveEntry{}, errLiveInvalidCall
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.sweepLocked(time.Now())
	entry := r.entries[callID]
	if entry == nil {
		return liveEntry{}, errLiveCallMissing
	}
	if entry.claimed {
		return liveEntry{}, errLiveCallBusy
	}
	if entry.clientScope != clientScope {
		return liveEntry{}, errLiveOwner
	}
	entry.claimed = true
	return *entry, nil
}

// release 归还认领并恢复过期计时（官方客户端会重连同一 call）。
func (r *liveRegistry) release(callID string) {
	r.mu.Lock()
	if entry := r.entries[callID]; entry != nil {
		entry.claimed = false
		entry.expiresAt = time.Now().Add(liveSessionTTL)
	}
	r.mu.Unlock()
}

func (r *liveRegistry) complete(callID string) {
	r.mu.Lock()
	delete(r.entries, callID)
	r.mu.Unlock()
}

// peek 用于 hangup：只复验调用方，不认领，也不因 sideband 已连接而拒绝。
func (r *liveRegistry) peek(callID, clientScope string) (liveEntry, error) {
	if !validCallID(callID) {
		return liveEntry{}, errLiveInvalidCall
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.sweepLocked(time.Now())
	entry := r.entries[callID]
	if entry == nil {
		return liveEntry{}, errLiveCallMissing
	}
	if entry.clientScope != clientScope {
		return liveEntry{}, errLiveOwner
	}
	return *entry, nil
}

func (s *Server) liveAPIBase() string {
	if base := strings.TrimSpace(s.cfg.LiveAPIBaseURL); base != "" {
		return strings.TrimRight(base, "/")
	}
	return defaultLiveAPIBase
}

// liveHeaders 组装 Live 请求头：沿用客户端协议头，但不继承 Responses 的路由、turn-state 与 turn id；
// turn metadata 按换号清理（含 turn-state，同 CPR client_live）并写入本账号安装身份。
func liveHeaders(header http.Header, inbound map[string]string, account Account) {
	for key, value := range inbound {
		name, ok := upstreamHeaderName(key)
		if !ok || name == "accept" || name == "content-type" || name == "openai-beta" || name == "x-codex-routing-hint" {
			continue
		}
		if name == "x-codex-turn-metadata" {
			scoped, keep := scopeTurnMetadataString(value, account.InstallationID, true, true)
			if !keep {
				continue
			}
			value = scoped
		}
		header.Set(name, value)
	}
	scopeCorrelationHeaders(header, account.InstallationID)
}

// sendLive 发送通话引导；正文原样转发，不做 Responses 的正文收敛或压缩。
func (d *dispatchRun) sendLive(ctx context.Context, account Account) (*http.Response, bool, error) {
	if account.APIKey != "" {
		return nil, false, errLiveUnsupported
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, d.target, bytes.NewReader(d.body))
	if err != nil {
		return nil, false, err
	}
	contentType := d.inboundHeader("content-type")
	if contentType == "" {
		contentType = "application/json"
	}
	req.Header.Set("Content-Type", contentType)
	liveHeaders(req.Header, d.envelope.Headers, account)
	applyProfileIdentity(req.Header, account, d.profile)
	client, err := d.server.clientFor(account)
	if err != nil {
		return nil, false, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, false, err
	}
	return resp, true, nil
}

// liveHangup：POST /internal/v1/live/hangup {call_id, client_scope, content_type, body, headers}。
func (s *Server) liveHangup(w http.ResponseWriter, r *http.Request) {
	var input struct {
		CallID      string            `json:"call_id"`
		ClientScope string            `json:"client_scope"`
		ContentType string            `json:"content_type"`
		Body        json.RawMessage   `json:"body"`
		Headers     map[string]string `json:"headers"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", err.Error())
		return
	}
	entry, err := s.live.peek(input.CallID, input.ClientScope)
	if err != nil {
		status, code := liveErrorStatus(err)
		writeError(w, status, code, err.Error())
		return
	}
	account, ok := s.store.Get(entry.account)
	if !ok {
		writeError(w, http.StatusServiceUnavailable, "credential_unavailable", errLiveAccountGone.Error())
		return
	}
	body := []byte(input.Body)
	if len(body) == 0 {
		body = []byte("{}")
	}
	ctx, cancel := context.WithTimeout(r.Context(), accountRequestTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.liveAPIBase()+"/realtime/calls/"+input.CallID+"/hangup", bytes.NewReader(body))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	contentType := input.ContentType
	if contentType == "" {
		contentType = "application/json"
	}
	req.Header.Set("Content-Type", contentType)
	liveHeaders(req.Header, input.Headers, account)
	applyProfileIdentity(req.Header, account, s.profileOr(entry.profile))
	// hangup 与引导同源：走钉住账号的出口代理与 Cookie
	client, err := s.clientFor(account)
	if err != nil {
		writeError(w, http.StatusBadGateway, "upstream_unavailable", err.Error())
		return
	}
	resp, err := client.Do(req)
	if err != nil {
		writeError(w, http.StatusBadGateway, "upstream_unavailable", "The voice call request could not be completed.")
		return
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 300 || resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone {
		s.live.complete(input.CallID)
	}
	for key, values := range resp.Header {
		if safeResponseHeader(key) && !isCodexQuotaHeader(key) && !strings.EqualFold(key, "Content-Length") {
			for _, value := range values {
				w.Header().Add(key, value)
			}
		}
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(data)
}

// liveSidebandRequest 由控制面签名放在 X-Kin-Gateway-Live 头（Body-Sha256 对它计算）。
type liveSidebandRequest struct {
	CallID       string            `json:"call_id"`
	Style        string            `json:"style"`
	ClientScope  string            `json:"client_scope"`
	Headers      map[string]string `json:"headers"`
	Subprotocols []string          `json:"subprotocols"`
}

func (s *Server) liveSidebandURL(style, callID string) string {
	base := s.liveAPIBase()
	switch {
	case strings.HasPrefix(base, "https://"):
		base = "wss://" + strings.TrimPrefix(base, "https://")
	case strings.HasPrefix(base, "http://"):
		base = "ws://" + strings.TrimPrefix(base, "http://")
	}
	switch style {
	case "realtime_calls":
		return base + "/realtime/calls/" + callID
	case "realtime_query":
		return base + "/realtime?intent=quicksilver&call_id=" + callID
	}
	return base + "/live/" + callID
}

// liveSideband：GET /internal/v1/live/sideband（WebSocket 升级）。认证中间件已按
// X-Kin-Gateway-Live 校验签名；先拨通上游再接受控制面连接，便于把上游拒绝原样返回。
func (s *Server) liveSideband(w http.ResponseWriter, r *http.Request) {
	var input liveSidebandRequest
	if err := json.Unmarshal([]byte(r.Header.Get("X-Kin-Gateway-Live")), &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_live_request", "invalid sideband request")
		return
	}
	entry, err := s.live.claim(input.CallID, input.ClientScope)
	if err != nil {
		status, code := liveErrorStatus(err)
		writeError(w, status, code, err.Error())
		return
	}
	defer s.live.release(input.CallID)
	account, ok := s.store.Get(entry.account)
	switch {
	case !ok:
		writeError(w, http.StatusServiceUnavailable, "credential_unavailable", errLiveAccountGone.Error())
		return
	case account.APIKey != "":
		writeError(w, http.StatusNotImplemented, "unsupported", errLiveUnsupported.Error())
		return
	case !account.Enabled:
		writeError(w, http.StatusForbidden, "owner_mismatch", "The account for this voice call is disabled.")
		return
	}
	header := http.Header{}
	liveHeaders(header, input.Headers, account)
	applyProfileIdentity(header, account, s.profileOr(entry.profile))
	client, err := s.wsClientFor(account)
	if err != nil {
		writeError(w, http.StatusBadGateway, "upstream_unavailable", errLiveConnectFails.Error())
		return
	}
	dialCtx, cancel := context.WithTimeout(r.Context(), wsConnectTimeout)
	upstream, resp, err := websocket.Dial(dialCtx, s.liveSidebandURL(input.Style, input.CallID), &websocket.DialOptions{
		HTTPClient: client, HTTPHeader: header, Subprotocols: input.Subprotocols, CompressionMode: websocket.CompressionContextTakeover,
	})
	cancel()
	if err != nil {
		if resp != nil && resp.StatusCode >= 400 {
			if resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone {
				// 上游报告通话已结束，立即删除登记
				s.live.complete(input.CallID)
			}
			data := []byte{}
			if resp.Body != nil {
				data, _ = io.ReadAll(io.LimitReader(resp.Body, 64<<10))
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(resp.StatusCode)
			_, _ = w.Write(data)
			return
		}
		writeError(w, http.StatusBadGateway, "upstream_unavailable", errLiveConnectFails.Error())
		return
	}
	defer upstream.CloseNow()
	upstream.SetReadLimit(wsMaxMessageBytes)
	options := &websocket.AcceptOptions{CompressionMode: websocket.CompressionDisabled}
	if subprotocol := upstream.Subprotocol(); subprotocol != "" {
		options.Subprotocols = []string{subprotocol}
	}
	downstream, err := websocket.Accept(w, r, options)
	if err != nil {
		return
	}
	defer downstream.CloseNow()
	downstream.SetReadLimit(wsMaxMessageBytes)
	relayLive(r.Context(), downstream, upstream)
}

// relayLive 双向原样中继帧，任一侧结束即关闭另一侧并传递关闭码。
func relayLive(ctx context.Context, downstream, upstream *websocket.Conn) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	pump := func(from, to *websocket.Conn) {
		defer cancel()
		for {
			kind, data, err := from.Read(ctx)
			if err != nil {
				status := websocket.CloseStatus(err)
				if status == -1 {
					status = websocket.StatusGoingAway
				}
				_ = to.Close(status, "")
				return
			}
			if err := to.Write(ctx, kind, data); err != nil {
				return
			}
		}
	}
	go pump(upstream, downstream)
	pump(downstream, upstream)
}
