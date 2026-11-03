package codexgateway

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

// 上游 Responses WebSocket（对齐 codex-proxy-rs transport/websocket）：
// OAuth 账号默认 prefer_websocket；连接按账号池化或绑定到一条入站 WS；
// 首个事件前的断线按同账号有界恢复，耗尽或 426 时回退 HTTP/SSE。
const (
	wsBetaHeader          = "responses_websockets=2026-02-06"
	wsMaxAge              = 55 * time.Minute
	wsIdleTimeout         = 300 * time.Second
	wsStreamIdleTimeout   = 300 * time.Second
	wsBoundIdleTimeout    = time.Hour
	wsPingInterval        = 25 * time.Second
	wsConnectTimeout      = 15 * time.Second
	wsRecoveryLimit       = 5
	wsRecoveryBase        = 200 * time.Millisecond
	wsHTTPFallbackBytes   = 15 << 20
	wsBreakerThreshold    = 3
	wsBreakerWindow       = 30 * time.Second
	wsBreakerOpenDuration = 30 * time.Second
	wsMaxMessageBytes     = 64 << 20
)

var (
	errWSFallback               = errors.New("websocket unavailable; fall back to HTTP")
	errContinuationLost         = errors.New("connection-local continuation is no longer available")
	errWSClosedBeforeTerminal   = errors.New("upstream websocket closed before a terminal event")
	errWSNoBoundConnection      = errors.New("no upstream websocket is bound to this connection")
	errWSConnectionNotStreaming = errors.New("bound upstream websocket has no active response")
)

type wsConn struct {
	conn               *websocket.Conn
	account            string
	credentialRevision int64
	origin             string
	createdAt          time.Time
	lastUsed           time.Time
	webSearch          bool
	responseIDs        map[string]bool
	active             bool
	// affinity 是握手 Set-Cookie 的路由 pin；ephemeral 连接（带父响应 pin 的 Guardian 请求）用后即关，不进池
	affinity  *routingAffinity
	ephemeral bool
	// turnState 是握手响应下发的 x-codex-turn-state，复用连接时随响应一并交付
	turnState string
	// safetyBuffering 是握手响应的 x-codex-safety-buffering-* 头；WS 只在握手时下发响应头，
	// 复用连接时同样交付，控制面据此如实记录这两个头的值
	safetyBuffering http.Header
	// proxyKey 标识占用的代理连接名额；released 保证只归还一次
	proxyKey string
	released atomic.Bool
}

func (c *wsConn) stale(now time.Time, idle time.Duration) bool {
	return now.Sub(c.createdAt) >= wsMaxAge || now.Sub(c.lastUsed) >= idle
}

type originBreaker struct {
	failures  []time.Time
	openUntil time.Time
}

type wsPool struct {
	mu              sync.Mutex
	idle            map[string][]*wsConn
	bound           map[string]*wsConn
	breaker         map[string]*originBreaker
	proxyConns      map[string]int
	capacityChanged chan struct{}
}

func newWSPool() *wsPool {
	return &wsPool{idle: map[string][]*wsConn{}, bound: map[string]*wsConn{}, breaker: map[string]*originBreaker{}, proxyConns: map[string]int{}, capacityChanged: make(chan struct{})}
}

func (p *wsPool) breakerOpen(origin string, now time.Time) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	b := p.breaker[origin]
	return b != nil && now.Before(b.openUntil)
}

func (p *wsPool) recordFailure(origin string, now time.Time) {
	p.mu.Lock()
	defer p.mu.Unlock()
	b := p.breaker[origin]
	if b == nil {
		b = &originBreaker{}
		p.breaker[origin] = b
	}
	kept := b.failures[:0]
	for _, at := range b.failures {
		if now.Sub(at) < wsBreakerWindow {
			kept = append(kept, at)
		}
	}
	b.failures = append(kept, now)
	if len(b.failures) >= wsBreakerThreshold {
		b.openUntil = now.Add(wsBreakerOpenDuration)
		b.failures = nil
	}
}

func (p *wsPool) recordSuccess(origin string) {
	p.mu.Lock()
	delete(p.breaker, origin)
	p.mu.Unlock()
}

// take 返回可复用的连接：优先入站连接绑定的那条，其次账号空闲池。needSearch 时不复用首包未声明搜索的连接。
func (p *wsPool) take(key, account string, revision int64, needSearch bool, now time.Time) *wsConn {
	p.mu.Lock()
	defer p.mu.Unlock()
	if key != "" {
		if conn := p.bound[key]; conn != nil {
			if conn.account == account && conn.credentialRevision == revision && !conn.active && !conn.stale(now, wsBoundIdleTimeout) && (!needSearch || conn.webSearch) {
				conn.active = true
				return conn
			}
			if !conn.active {
				delete(p.bound, key)
				go p.closeConn(conn, websocket.StatusNormalClosure, "rebind")
			}
		}
	}
	idle := p.idle[account]
	for len(idle) > 0 {
		conn := idle[len(idle)-1]
		idle = idle[:len(idle)-1]
		if conn.credentialRevision != revision || conn.stale(now, wsIdleTimeout) || (needSearch && !conn.webSearch) {
			go p.closeConn(conn, websocket.StatusNormalClosure, "expired")
			continue
		}
		p.idle[account] = idle
		conn.active = true
		return conn
	}
	delete(p.idle, account)
	return nil
}

// put 在响应正常结束后归还连接：有入站绑定则保持绑定（支持连接内续接），否则进入账号空闲池。
func (p *wsPool) put(key string, conn *wsConn, now time.Time) {
	if conn.ephemeral {
		p.discard(key, conn)
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	conn.active = false
	conn.lastUsed = now
	if key != "" {
		if previous := p.bound[key]; previous != nil && previous != conn {
			go p.closeConn(previous, websocket.StatusNormalClosure, "rebind")
		}
		p.bound[key] = conn
		return
	}
	p.idle[conn.account] = append(p.idle[conn.account], conn)
}

func (p *wsPool) discard(key string, conn *wsConn) {
	p.mu.Lock()
	if key != "" && p.bound[key] == conn {
		delete(p.bound, key)
	}
	p.mu.Unlock()
	p.closeConn(conn, websocket.StatusGoingAway, "discard")
}

func (p *wsPool) bind(key string, conn *wsConn) {
	if key == "" {
		return
	}
	p.mu.Lock()
	if previous := p.bound[key]; previous != nil && previous != conn && !previous.active {
		go p.closeConn(previous, websocket.StatusNormalClosure, "rebind")
	}
	p.bound[key] = conn
	p.mu.Unlock()
}

// continuation 判断连接内续接：入站连接绑定的上游连接见过该 response id 时返回其账号。
func (p *wsPool) continuation(key, responseID string) (string, int64, bool) {
	if key == "" || responseID == "" {
		return "", 0, false
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	conn := p.bound[key]
	if conn == nil || !conn.responseIDs[responseID] || conn.stale(time.Now(), wsBoundIdleTimeout) {
		return "", 0, false
	}
	return conn.account, conn.credentialRevision, true
}

// send 把入站控制帧（如 response.interrupt）写到绑定的上游连接；只在有活动响应时转发。
func (p *wsPool) send(ctx context.Context, key string, frame []byte) error {
	p.mu.Lock()
	conn := p.bound[key]
	p.mu.Unlock()
	if conn == nil {
		return errWSNoBoundConnection
	}
	if !conn.active {
		return errWSConnectionNotStreaming
	}
	return conn.conn.Write(ctx, websocket.MessageText, frame)
}

func (p *wsPool) closeKey(key string) {
	p.mu.Lock()
	conn := p.bound[key]
	delete(p.bound, key)
	p.mu.Unlock()
	if conn != nil && !conn.active {
		p.closeConn(conn, websocket.StatusNormalClosure, "client closed")
	}
}

// useWebSocket：仅 Responses 推理；API Key 账号默认 HTTP；大请求与熔断时走 HTTP。
func (d *dispatchRun) useWebSocket(account Account) bool {
	if d.envelope.Operation != "responses" && d.envelope.Operation != "chat" {
		return false
	}
	transport := d.envelope.Transport
	if transport == "" {
		transport = d.server.cfg.UpstreamTransport
	}
	if transport == "http" || account.APIKey != "" || d.wsDisabled || !d.envelope.Stream {
		return false
	}
	if d.server.wsSessions.usesHTTP(d.wsSessionKey(), time.Now()) {
		return false
	}
	if len(d.body) >= wsHTTPFallbackBytes {
		return false
	}
	return !d.server.ws.breakerOpen(d.server.wsOrigin(), time.Now())
}

func (s *Server) wsOrigin() string {
	parsed, err := url.Parse(s.cfg.UpstreamBaseURL)
	if err != nil {
		return s.cfg.UpstreamBaseURL
	}
	return parsed.Host
}

func (s *Server) wsURL() string {
	base := strings.TrimRight(s.cfg.UpstreamBaseURL, "/") + "/responses"
	switch {
	case strings.HasPrefix(base, "https://"):
		return "wss://" + strings.TrimPrefix(base, "https://")
	case strings.HasPrefix(base, "http://"):
		return "ws://" + strings.TrimPrefix(base, "http://")
	}
	return base
}

// responseCreateFrame 构造 {"type":"response.create", ...body}：保留正文字段原顺序（与 CPR 逐字节一致），
// 去掉 WS 不使用的 stream。返回本帧是否声明托管搜索（顶层 tools 或 Lite input 内的工具声明）。
func responseCreateFrame(body []byte) ([]byte, bool, error) {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
		return nil, false, errors.New("response.create body must be a JSON object")
	}
	var out bytes.Buffer
	var bodyType json.RawMessage
	var rest bytes.Buffer
	search := false
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return nil, false, err
		}
		key, _ := token.(string)
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, false, err
		}
		switch key {
		case "stream":
			continue
		case "type":
			bodyType = value
			continue
		case "tools":
			search = search || rawToolsDeclareSearch(value)
		case "input":
			search = search || rawInputDeclaresSearch(value)
		}
		name, _ := json.Marshal(key)
		rest.WriteByte(',')
		rest.Write(name)
		rest.WriteByte(':')
		rest.Write(value)
	}
	out.WriteString(`{"type":`)
	if len(bodyType) > 0 {
		out.Write(bodyType)
	} else {
		out.WriteString(`"response.create"`)
	}
	out.Write(rest.Bytes())
	out.WriteByte('}')
	return out.Bytes(), search, nil
}

// sendWS 通过上游 WebSocket 发送一轮 response.create。返回的 *http.Response 是由 WS 事件转成的 SSE 流，
// 与 HTTP 路径共用提交、观察与 Receipt 逻辑；握手被拒（非 101）按 HTTP 失败交给分类器。
func (d *dispatchRun) sendWS(ctx context.Context, account Account) (*http.Response, bool, error) {
	s := d.server
	attemptBody, state, pinned := d.prepareAttempt(account)
	d.affinity = nil
	d.attemptState = state
	attemptBody = projectWSClientMetadata(attemptBody, d.inboundHeader("x-openai-internal-codex-responses-lite"), state.turnState, time.Now())
	handshakeHeader := s.wsHandshakeHeader(account, d.envelope.Headers, codexRoutingHint(attemptBody), pinned, state)
	// 隐私规则在 WS 投影与握手头完成后执行（复用连接时握手头不再发送）
	attemptBody, err := d.privacy.applyBody(ctx, attemptBody, handshakeHeader)
	if err != nil {
		return nil, false, err
	}
	frame, search, err := responseCreateFrame(attemptBody)
	if err != nil {
		return nil, false, errWSFallback
	}
	// 带父响应 pin 的 Guardian 请求使用独立连接（CPR 连接池键含路由快照），不复用也不绑定入站连接
	poolKey := d.envelope.ConnectionKey
	if pinned != nil {
		poolKey = ""
	}
	origin := s.wsOrigin()
	for attempt := 0; attempt <= wsRecoveryLimit; attempt++ {
		if attempt > 0 {
			// origin 熔断打开后不再同账号恢复，直接回退 HTTP
			if s.ws.breakerOpen(origin, time.Now()) {
				return nil, true, errWSFallback
			}
			delay := wsRecoveryBase << (attempt - 1)
			jitter := time.Duration(float64(delay) * (rand.Float64()*0.2 - 0.1))
			if !sleepContext(ctx, delay+jitter) {
				return nil, attempt > 0, ctx.Err()
			}
		}
		now := time.Now()
		var conn *wsConn
		if pinned == nil {
			conn = s.ws.take(poolKey, account.ID, account.CredentialRevision, search, now)
		}
		var handshake http.Header
		if conn == nil {
			proxyKey := account.ProxyURL
			if err := s.ws.acquireProxySlot(ctx, proxyKey, account.ProxyMaxWS); err != nil {
				if ctx.Err() != nil {
					return nil, false, ctx.Err()
				}
				return nil, false, errWSFallback
			}
			dialed, resp, err := s.dialWSHeader(ctx, account, handshakeHeader.Clone())
			if err != nil {
				s.ws.releaseProxySlot(proxyKey)
				if resp != nil && resp.StatusCode != http.StatusSwitchingProtocols {
					// 握手阶段的 401/403/429/5xx 是明确拒绝，按 HTTP 失败分类；426 与其他非升级响应
					// 说明该路径不提供 WS，改走 HTTP（CPR：426 是明确的传输切换信号）
					if resp.StatusCode >= 400 && resp.StatusCode != http.StatusUpgradeRequired {
						return resp, true, nil
					}
					if resp.StatusCode != http.StatusUpgradeRequired {
						s.ws.recordFailure(origin, time.Now())
						s.wsSessions.recordFailure(d.wsSessionKey(), time.Now())
					} else {
						s.wsSessions.disable(d.wsSessionKey(), time.Now())
					}
					return nil, false, errWSFallback
				}
				if ctx.Err() != nil {
					return nil, false, ctx.Err()
				}
				s.ws.recordFailure(origin, time.Now())
				s.wsSessions.recordFailure(d.wsSessionKey(), time.Now())
				continue
			}
			handshake = resp.Header
			conn = &wsConn{conn: dialed, account: account.ID, credentialRevision: account.CredentialRevision, origin: origin, createdAt: now, lastUsed: now, webSearch: search, responseIDs: map[string]bool{}, active: true, affinity: pinned, ephemeral: pinned != nil, proxyKey: proxyKey}
			if pinned == nil {
				conn.affinity = routingAffinityFromResponse(s.wsURL(), resp.Header)
			}
			conn.turnState = resp.Header.Get("x-codex-turn-state")
			conn.safetyBuffering = safetyBufferingHeaders(resp.Header)
			conn.conn.SetReadLimit(wsMaxMessageBytes)
		}
		writeCtx, cancelWrite := context.WithTimeout(ctx, wsConnectTimeout)
		err := conn.conn.Write(writeCtx, websocket.MessageText, frame)
		cancelWrite()
		if err != nil {
			s.ws.discard(poolKey, conn)
			if ctx.Err() != nil {
				return nil, true, ctx.Err()
			}
			s.ws.recordFailure(origin, time.Now())
			s.wsSessions.recordFailure(d.wsSessionKey(), time.Now())
			continue
		}
		readCtx, cancelRead := context.WithTimeout(ctx, wsStreamIdleTimeout)
		kind, first, err := conn.conn.Read(readCtx)
		cancelRead()
		if err != nil || kind != websocket.MessageText {
			// 首个事件前断线：同账号有界恢复（CPR：发送状态不明不单独阻止该恢复）
			s.ws.discard(poolKey, conn)
			if ctx.Err() != nil {
				return nil, true, ctx.Err()
			}
			s.ws.recordFailure(origin, time.Now())
			s.wsSessions.recordFailure(d.wsSessionKey(), time.Now())
			continue
		}
		s.ws.recordSuccess(origin)
		s.wsSessions.succeeded(d.wsSessionKey())
		d.affinity = conn.affinity
		if resp := wsErrorResponse(first); resp != nil {
			s.ws.discard(poolKey, conn)
			return resp, true, nil
		}
		s.ws.bind(poolKey, conn)
		header := http.Header{}
		for key, values := range handshake {
			lower := strings.ToLower(key)
			if lower == "connection" || lower == "upgrade" || strings.HasPrefix(lower, "sec-websocket-") {
				continue
			}
			header[key] = values
		}
		header.Set("Content-Type", "text/event-stream")
		if conn.turnState != "" {
			header.Set("x-codex-turn-state", conn.turnState)
		}
		for key, values := range conn.safetyBuffering {
			header[key] = values
		}
		body := newWSBody(ctx, s.ws, poolKey, conn, first)
		return &http.Response{StatusCode: http.StatusOK, Header: header, Body: body}, true, nil
	}
	return nil, true, errWSFallback
}

// wsErrorResponse：WS 错误帧 {"type":"error","status":429,"error":{...},"headers":{...}} 转成 HTTP 失败。
func wsErrorResponse(frame []byte) *http.Response {
	var event struct {
		Type    string            `json:"type"`
		Status  int               `json:"status"`
		Error   json.RawMessage   `json:"error"`
		Headers map[string]string `json:"headers"`
	}
	if json.Unmarshal(frame, &event) != nil || event.Type != "error" || event.Status < 400 {
		return nil
	}
	header := http.Header{}
	for key, value := range event.Headers {
		header.Set(key, value)
	}
	header.Set("Content-Type", "application/json")
	body, _ := json.Marshal(map[string]json.RawMessage{"error": event.Error})
	return &http.Response{StatusCode: event.Status, Header: header, Body: io.NopCloser(bytes.NewReader(body))}
}

func (s *Server) dialWS(ctx context.Context, account Account, inbound map[string]string, routingHint string, pinned *routingAffinity, state attemptState) (*websocket.Conn, *http.Response, error) {
	return s.dialWSHeader(ctx, account, s.wsHandshakeHeader(account, inbound, routingHint, pinned, state))
}

// wsHandshakeHeader 构造上游 WS 握手头（宿主头、画像身份与路由 pin），隐私规则在其后执行。
func (s *Server) wsHandshakeHeader(account Account, inbound map[string]string, routingHint string, pinned *routingAffinity, state attemptState) http.Header {
	header := http.Header{}
	for key, value := range inbound {
		if name, ok := upstreamHeaderName(key); ok && name != "accept" && name != "content-type" {
			header.Set(name, value)
		}
	}
	header.Set("openai-beta", wsBetaHeader)
	if routingHint != "" {
		header.Set("x-codex-routing-hint", routingHint)
	}
	scopeCorrelationHeaders(header, account.InstallationID)
	// WS 的 turn-state 写在首帧 client_metadata，握手只带 turn metadata
	applyAttemptHeaders(header, account, attemptState{scope: state.scope})
	applyProfileIdentity(header, account, s.profileOr(state.profile))
	pinned.apply(s.wsURL(), header)
	return header
}

func (s *Server) dialWSHeader(ctx context.Context, account Account, header http.Header) (*websocket.Conn, *http.Response, error) {
	client, err := s.wsClientFor(account)
	if err != nil {
		return nil, nil, err
	}
	dialCtx, cancel := context.WithTimeout(ctx, wsConnectTimeout)
	defer cancel()
	return websocket.Dial(dialCtx, s.wsURL(), &websocket.DialOptions{HTTPClient: client, HTTPHeader: header, CompressionMode: websocket.CompressionContextTakeover})
}

// wsClientFor 与 clientFor 使用同一代理出口；握手由 wsHandshakeTransport 按官方线级顺序写出，
// OAuth 账号同样回放并采集账号 Cookie。
func (s *Server) wsClientFor(account Account) (*http.Client, error) {
	client, err := s.cachedClient("ws\x00"+account.ProxyURL, func() (*http.Client, error) {
		out, err := newUpstreamEgress(account.ProxyURL)
		if err != nil {
			return nil, err
		}
		return &http.Client{Transport: &wsHandshakeTransport{server: s, egress: out}}, nil
	})
	if err != nil || account.ID == "" || account.APIKey != "" {
		return client, err
	}
	wrapped := *client
	wrapped.Transport = &accountCookieTransport{base: client.Transport, store: s.store, account: account.ID, revision: account.CredentialRevision}
	return &wrapped, nil
}

// wsBody 把上游 WS 事件转换为 SSE 文本（event: <type> / data: <json>）。终态后连接归池或保持入站绑定，
// 终态前关闭（包括 Close 1000）按失败处理。
type wsBody struct {
	reader *io.PipeReader
	cancel context.CancelFunc
	once   sync.Once
}

func newWSBody(parent context.Context, pool *wsPool, key string, conn *wsConn, first []byte) *wsBody {
	reader, writer := io.Pipe()
	ctx, cancel := context.WithCancel(parent)
	body := &wsBody{reader: reader, cancel: cancel}
	go func() {
		pingDone := make(chan struct{})
		go func() {
			ticker := time.NewTicker(wsPingInterval)
			defer ticker.Stop()
			for {
				select {
				case <-pingDone:
					return
				case <-ticker.C:
					pingCtx, cancelPing := context.WithTimeout(ctx, 10*time.Second)
					_ = conn.conn.Ping(pingCtx)
					cancelPing()
				}
			}
		}()
		reusable := false
		defer func() {
			close(pingDone)
			if reusable {
				pool.put(key, conn, time.Now())
			} else {
				pool.discard(key, conn)
			}
		}()
		message := first
		for {
			eventType, responseID := wsEventInfo(message)
			if responseID != "" {
				pool.mu.Lock()
				conn.responseIDs[responseID] = true
				pool.mu.Unlock()
			}
			var chunk bytes.Buffer
			if eventType != "" {
				fmt.Fprintf(&chunk, "event: %s\n", eventType)
			}
			chunk.WriteString("data: ")
			chunk.Write(message)
			chunk.WriteString("\n\n")
			if _, err := writer.Write(chunk.Bytes()); err != nil {
				return
			}
			if terminalStreamEvents[eventType] {
				reusable = eventType != "response.failed"
				_ = writer.Close()
				return
			}
			readCtx, cancelRead := context.WithTimeout(ctx, wsStreamIdleTimeout)
			kind, next, err := conn.conn.Read(readCtx)
			cancelRead()
			if err != nil {
				_ = writer.CloseWithError(errWSClosedBeforeTerminal)
				return
			}
			if kind != websocket.MessageText {
				continue
			}
			message = next
		}
	}()
	return body
}

func (b *wsBody) Read(p []byte) (int, error) { return b.reader.Read(p) }

func (b *wsBody) Close() error {
	b.once.Do(func() {
		b.cancel()
		_ = b.reader.Close()
	})
	return nil
}

func wsEventInfo(message []byte) (string, string) {
	var event struct {
		Type     string `json:"type"`
		Response struct {
			ID string `json:"id"`
		} `json:"response"`
	}
	if json.Unmarshal(message, &event) != nil {
		return "", ""
	}
	return event.Type, event.Response.ID
}

// wsFrame 把入站连接的非 response.create 文本帧（如 response.interrupt）转发到其绑定的上游 WS。
// 控制帧不重新选号、不创建 attempt；没有绑定或当前没有活动响应时返回 409，由控制面回 interrupt.failed。
func (s *Server) wsFrame(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ConnectionKey string          `json:"connection_key"`
		Frame         json.RawMessage `json:"frame"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body); err != nil || body.ConnectionKey == "" || len(body.Frame) == 0 {
		writeError(w, http.StatusBadRequest, "invalid_frame", "connection_key and frame are required")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), wsConnectTimeout)
	defer cancel()
	if err := s.ws.send(ctx, body.ConnectionKey, body.Frame); err != nil {
		code := "upstream_frame_failed"
		if errors.Is(err, errWSNoBoundConnection) || errors.Is(err, errWSConnectionNotStreaming) {
			code = "no_upstream_control_channel"
		}
		writeError(w, http.StatusConflict, code, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// wsClose 在入站连接关闭时释放其绑定的上游 WS。
func (s *Server) wsClose(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ConnectionKey string `json:"connection_key"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 4<<10)).Decode(&body)
	if body.ConnectionKey != "" {
		s.ws.closeKey(body.ConnectionKey)
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// safetyBufferingHeaders 取出 x-codex-safety-buffering-* 响应头（上游声明的安全缓冲与 faster model）。
func safetyBufferingHeaders(source http.Header) http.Header {
	var out http.Header
	for key, values := range source {
		if strings.HasPrefix(strings.ToLower(key), "x-codex-safety-buffering-") && len(values) > 0 {
			if out == nil {
				out = http.Header{}
			}
			out[key] = append([]string(nil), values...)
		}
	}
	return out
}
