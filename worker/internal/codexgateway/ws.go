package codexgateway

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

// 上游 Responses WebSocket（对齐 codex-proxy-rs transport/websocket）：
// OAuth 账号默认 prefer_websocket；连接按账号、出口、调用方、会话锚点与握手画像池化，或绑定到一条入站 WS。
// 每条连接有自己的读循环，空闲（在池或绑定待用）时每 25s Ping，断线即标记失效并由取用与定期清扫剔除；
// 冷建连经全局建连名额与按出口分开、带半开探测的熔断。新链与持久续接最多等 800ms 建连，超时本次走 HTTP，
// 后台建好的连接入池；首个语义输出前的断线按同账号有界恢复，耗尽或 426 时可回退的请求转 HTTP，
// 必须走 WS 的请求（预热、入站 WS 的 store=false 新链、连接内续接）不回退，要求客户端重放。
const (
	wsBetaHeader          = "responses_websockets=2026-02-06"
	wsMaxAge              = 55 * time.Minute
	wsIdleTimeout         = 300 * time.Second
	wsStreamIdleTimeout   = 300 * time.Second
	wsBoundIdleTimeout    = time.Hour
	wsPingInterval        = 25 * time.Second
	wsPingTimeout         = 5 * time.Second
	wsConnectTimeout      = 15 * time.Second
	wsSendTimeout         = 5 * time.Minute
	wsFastPathBudget      = 800 * time.Millisecond
	wsRecoveryLimit       = 5
	wsRecoveryBase        = 200 * time.Millisecond
	wsPayloadLimit        = 15<<20 + 1<<19         // 15.5 MiB：实测上游 16 MiB 消息边界前留半 MiB
	wsPayloadResume       = wsPayloadLimit - 2<<20 // 13.5 MiB：回差，避免在边界附近来回切换
	wsBreakerThreshold    = 3
	wsBreakerWindow       = 30 * time.Second
	wsBreakerOpenDuration = 30 * time.Second
	wsMaxActiveOpenings   = 128
	wsMaxWaitingOpenings  = 1024
	wsMaxPoolOpenings     = 16
	wsPoolSweepInterval   = 5 * time.Second
	wsFrameBuffer         = 64
	// wsMaxMessageBytes 只用于 Live sideband；Responses WS 与 CPR 一致不限制消息大小
	wsMaxMessageBytes = 64 << 20
)

var (
	errWSFallback               = errors.New("websocket unavailable; fall back to HTTP")
	errWSFastPathMiss           = fmt.Errorf("%w: websocket fast path budget exhausted", errWSFallback)
	errContinuationLost         = errors.New("connection-local continuation is no longer available")
	errWSClosedBeforeTerminal   = errors.New("upstream websocket closed before a terminal event")
	errWSNoBoundConnection      = errors.New("no upstream websocket is bound to this connection")
	errWSConnectionNotStreaming = errors.New("bound upstream websocket has no active response")
	errWSIdle                   = errors.New("upstream websocket stream idle timeout")
	errWSLocalCapacity          = errors.New("local websocket connection capacity exhausted")
	errWSUpgradeRequired        = errors.New("upstream requires a non-websocket transport")
)

type wsConn struct {
	conn               *websocket.Conn
	account            string
	credentialRevision int64
	origin             string
	createdAt          time.Time
	lastUsed           time.Time
	webSearch          bool
	// latestResponseID 是该连接上最近一次 completed/interrupted 的响应；连接内续接只认它（CPR latest）
	latestResponseID string
	active           bool
	// affinity 是握手 Set-Cookie 的路由 pin；ephemeral 连接（带父响应 pin 的 Guardian 请求）用后即关，不进池
	affinity  *routingAffinity
	ephemeral bool
	// idleKey 是空闲池键（见 wsIdleKey）；为空时连接不进空闲池
	idleKey string
	// proxyKey 标识占用的代理连接名额；released 保证只归还一次
	proxyKey string
	released atomic.Bool
	// frames 由读循环填充；closed 表示读循环或 Ping 已发现连接失效；streaming 期间不 Ping
	frames    chan []byte
	done      chan struct{}
	stopOnce  sync.Once
	closed    atomic.Bool
	streaming atomic.Bool
	errMu     sync.Mutex
	readErr   error
}

// start 启动读循环与 Ping（CPR pump）。coder/websocket 的 Ping 要等 Pong、需要并发读，超时会关闭连接；
// 流式期间下游背压会让读循环暂停，因此只在连接空闲时 Ping，流式期间由 300s 流空闲超时判定。
func (c *wsConn) start() {
	c.frames = make(chan []byte, wsFrameBuffer)
	c.done = make(chan struct{})
	go func() {
		defer close(c.frames)
		for {
			kind, data, err := c.conn.Read(context.Background())
			if err != nil {
				c.fail(err)
				return
			}
			if kind != websocket.MessageText {
				continue
			}
			select {
			case c.frames <- data:
			case <-c.done:
				return
			}
		}
	}()
	go func() {
		ticker := time.NewTicker(wsPingInterval)
		defer ticker.Stop()
		for {
			select {
			case <-c.done:
				return
			case <-ticker.C:
				if c.streaming.Load() {
					continue
				}
				ctx, cancel := context.WithTimeout(context.Background(), wsPingTimeout)
				err := c.conn.Ping(ctx)
				cancel()
				if err != nil {
					c.fail(err)
					return
				}
			}
		}
	}()
}

func (c *wsConn) fail(err error) {
	c.errMu.Lock()
	if c.readErr == nil {
		c.readErr = err
	}
	c.errMu.Unlock()
	c.closed.Store(true)
}

func (c *wsConn) err() error {
	c.errMu.Lock()
	defer c.errMu.Unlock()
	if c.readErr != nil {
		return c.readErr
	}
	return errWSClosedBeforeTerminal
}

func (c *wsConn) stop() {
	c.stopOnce.Do(func() {
		if c.done != nil {
			close(c.done)
		}
	})
}

// next 读取下一条文本帧；超过 timeout 没有数据返回 errWSIdle。调用方取消时连接需由调用方丢弃。
func (c *wsConn) next(ctx context.Context, timeout time.Duration) ([]byte, error) {
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case data, ok := <-c.frames:
		if !ok {
			return nil, c.err()
		}
		return data, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-timer.C:
		return nil, errWSIdle
	}
}

func (c *wsConn) stale(now time.Time, idle time.Duration) bool {
	return c.closed.Load() || now.Sub(c.createdAt) >= wsMaxAge || now.Sub(c.lastUsed) >= idle
}

// reusable：没有失效，也没有空闲期间到达的残留帧（残留帧属于上一个响应，不能交给下一个请求）。
func (c *wsConn) reusable() bool {
	return !c.closed.Load() && len(c.frames) == 0
}

// wsBreaker 是按“源站 + 账号出口”的建连熔断（CPR breaker.rs）：窗口 30s 内 3 次冷建连失败打开 30s；
// 到期后只放一个半开探测，探测成功关闭、失败再打开；探测许可按代次识别，迟到结果丢弃。
type wsBreaker struct {
	failures  []time.Time
	openUntil time.Time
	halfOpen  bool
	probe     uint64
}

type wsPool struct {
	mu              sync.Mutex
	idle            map[string][]*wsConn
	bound           map[string]*wsConn
	breaker         map[string]*wsBreaker
	proxyConns      map[string]int
	capacityChanged chan struct{}
	// openings 是全局同时建连名额（128），poolOpenings 是后台入池建连名额（16）
	openings        chan struct{}
	poolOpenings    chan struct{}
	waitingOpenings atomic.Int64
}

func newWSPool() *wsPool {
	return &wsPool{idle: map[string][]*wsConn{}, bound: map[string]*wsConn{}, breaker: map[string]*wsBreaker{}, proxyConns: map[string]int{}, capacityChanged: make(chan struct{}),
		openings: make(chan struct{}, wsMaxActiveOpenings), poolOpenings: make(chan struct{}, wsMaxPoolOpenings)}
}

// breakerAcquire 取冷建连许可：probe>0 表示半开探测许可；ok=false 表示熔断打开或探测进行中。
func (p *wsPool) breakerAcquire(key string, now time.Time) (uint64, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	b := p.breaker[key]
	switch {
	case b == nil || (b.openUntil.IsZero() && !b.halfOpen):
		return 0, true
	case b.halfOpen || now.Before(b.openUntil):
		return 0, false
	}
	b.halfOpen = true
	b.probe++
	return b.probe, true
}

// breakerResult 记录冷建连结果：握手成功或 opening 返回 <500 记成功，5xx、超时与连接错误记失败。
func (p *wsPool) breakerResult(key string, probe uint64, success bool, now time.Time) {
	p.mu.Lock()
	defer p.mu.Unlock()
	b := p.breaker[key]
	if probe != 0 {
		if b == nil || !b.halfOpen || b.probe != probe {
			return
		}
		b.halfOpen = false
		if success {
			delete(p.breaker, key)
			return
		}
		b.failures, b.openUntil = nil, now.Add(wsBreakerOpenDuration)
		return
	}
	if b != nil && (b.halfOpen || !b.openUntil.IsZero()) {
		// 打开或半开期间到达的普通许可结果属于旧代次
		return
	}
	if success {
		delete(p.breaker, key)
		return
	}
	if b == nil {
		b = &wsBreaker{}
		p.breaker[key] = b
	}
	kept := b.failures[:0]
	for _, at := range b.failures {
		if now.Sub(at) < wsBreakerWindow {
			kept = append(kept, at)
		}
	}
	b.failures = append(kept, now)
	if len(b.failures) >= wsBreakerThreshold {
		b.failures, b.openUntil = nil, now.Add(wsBreakerOpenDuration)
	}
}

// breakerCancel 归还未使用的探测许可（本地准入拒绝等），下一个请求可立即再探。
func (p *wsPool) breakerCancel(key string, probe uint64, now time.Time) {
	if probe == 0 {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if b := p.breaker[key]; b != nil && b.halfOpen && b.probe == probe {
		b.halfOpen, b.openUntil = false, now
	}
}

// acquireOpening 取全局建连名额（CPR：同时建连 128、排队 1024）；try 为真时拿不到立即返回。
func (p *wsPool) acquireOpening(ctx context.Context, try bool) (func(), error) {
	release := func() { <-p.openings }
	select {
	case p.openings <- struct{}{}:
		return release, nil
	default:
	}
	if try {
		return nil, errWSLocalCapacity
	}
	if p.waitingOpenings.Add(1) > wsMaxWaitingOpenings {
		p.waitingOpenings.Add(-1)
		return nil, errWSLocalCapacity
	}
	defer p.waitingOpenings.Add(-1)
	timer := time.NewTimer(wsConnectTimeout)
	defer timer.Stop()
	select {
	case p.openings <- struct{}{}:
		return release, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-timer.C:
		return nil, errWSLocalCapacity
	}
}

// take 返回可复用的连接：优先入站连接绑定的那条，其次同一空闲池键的连接。needSearch 时不复用首包未声明搜索的连接。
func (p *wsPool) take(key, idleKey, account string, revision int64, needSearch bool, now time.Time) *wsConn {
	p.mu.Lock()
	defer p.mu.Unlock()
	if key != "" {
		if conn := p.bound[key]; conn != nil {
			if conn.account == account && conn.credentialRevision == revision && !conn.active && conn.reusable() && !conn.stale(now, wsBoundIdleTimeout) && (!needSearch || conn.webSearch) {
				conn.active = true
				return conn
			}
			if !conn.active {
				delete(p.bound, key)
				go p.closeConn(conn, websocket.StatusNormalClosure, "rebind")
			}
		}
	}
	if idleKey == "" {
		return nil
	}
	idle := p.idle[idleKey]
	for len(idle) > 0 {
		conn := idle[len(idle)-1]
		idle = idle[:len(idle)-1]
		if conn.credentialRevision != revision || !conn.reusable() || conn.stale(now, wsIdleTimeout) || (needSearch && !conn.webSearch) {
			go p.closeConn(conn, websocket.StatusNormalClosure, "expired")
			continue
		}
		p.idle[idleKey] = idle
		conn.active = true
		return conn
	}
	delete(p.idle, idleKey)
	return nil
}

// put 在响应正常结束后归还连接：有入站绑定则保持绑定（支持连接内续接），否则按空闲池键入池；
// 没有空闲池键（无会话锚点）或已失效的连接用后即关（CPR：无 conversation 锚点不入池）。
func (p *wsPool) put(key string, conn *wsConn, now time.Time) {
	if conn.ephemeral || (key == "" && conn.idleKey == "") || conn.closed.Load() {
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
	p.idle[conn.idleKey] = append(p.idle[conn.idleKey], conn)
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

// continuation 判断连接内续接：入站连接绑定的上游连接最近完成的响应正是 previous_response_id 时返回其账号。
func (p *wsPool) continuation(key, responseID string) (string, int64, bool) {
	if key == "" || responseID == "" {
		return "", 0, false
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	conn := p.bound[key]
	if conn == nil || conn.latestResponseID != responseID || conn.stale(time.Now(), wsBoundIdleTimeout) {
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

// sweepLoop 每 5s 剔除失效、超龄或空闲超时的连接（CPR pool supervisor）。
func (p *wsPool) sweepLoop(ctx context.Context) {
	ticker := time.NewTicker(wsPoolSweepInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			p.sweep(now)
		}
	}
}

func (p *wsPool) sweep(now time.Time) {
	var expired []*wsConn
	p.mu.Lock()
	for key, conns := range p.idle {
		kept := conns[:0]
		for _, conn := range conns {
			if conn.stale(now, wsIdleTimeout) || !conn.reusable() {
				expired = append(expired, conn)
				continue
			}
			kept = append(kept, conn)
		}
		if len(kept) == 0 {
			delete(p.idle, key)
		} else {
			p.idle[key] = kept
		}
	}
	for key, conn := range p.bound {
		if !conn.active && conn.stale(now, wsBoundIdleTimeout) {
			delete(p.bound, key)
			expired = append(expired, conn)
		}
	}
	p.mu.Unlock()
	for _, conn := range expired {
		p.closeConn(conn, websocket.StatusNormalClosure, "expired")
	}
}

// wsRequirement 是本次请求对上游 WS 的要求（CPR TransportRequirement）。
type wsRequirement int

const (
	// wsPreferred：可回退 HTTP，没有快路径（续接但不确定上游是否持久化）
	wsPreferred wsRequirement = iota
	// wsFastPath：新链与持久续接，最多等 800ms 建连
	wsFastPath
	// wsRequired：generate:false 预热、入站 WS 的 store=false 新链、连接内续接，必须走 WS
	wsRequired
)

func (d *dispatchRun) wsRequirement() wsRequirement {
	if d.nativeContinuation {
		return wsRequired
	}
	var fields struct {
		Generate *bool  `json:"generate"`
		Store    *bool  `json:"store"`
		Previous string `json:"previous_response_id"`
	}
	_ = json.Unmarshal(topLevelSubset(d.body, "generate", "store", "previous_response_id"), &fields)
	storeFalse := fields.Store != nil && !*fields.Store
	switch {
	case fields.Generate != nil && !*fields.Generate && storeFalse:
		return wsRequired
	case fields.Previous != "":
		if fields.Store != nil && *fields.Store {
			return wsFastPath
		}
		return wsPreferred
	case d.envelope.ConnectionKey != "" && storeFalse:
		return wsRequired
	}
	return wsFastPath
}

// useWebSocket：仅 Responses 推理；API Key 账号与配置 HTTP 时走 HTTP。必须走 WS 的请求不看会话 HTTP 状态与熔断，
// 其余请求在会话已转 HTTP、本请求已放弃 WS 或正文过大时走 HTTP（完整新链按线程回差 15.5/13.5 MiB，带 previous_response_id 的请求只看 15.5 MiB）；熔断只约束冷建连（见 sendWS）。
func (d *dispatchRun) useWebSocket(account Account) bool {
	if d.envelope.Operation != "responses" && d.envelope.Operation != "chat" {
		return false
	}
	transport := d.envelope.Transport
	if transport == "" {
		transport = d.server.cfg.UpstreamTransport
	}
	if transport == "http" || account.APIKey != "" || !d.envelope.Stream {
		return false
	}
	if d.wsRequirement() == wsRequired {
		return true
	}
	if d.wsDisabled {
		return false
	}
	now := time.Now()
	key := d.wsSessionKey()
	if d.server.wsSessions.usesHTTP(key, now) {
		return false
	}
	if previousResponseID(d.body) == "" {
		// 完整新链：按线程的大小偏好决定，超过 15.5 MiB 后沿用 HTTP，直到帧长低于 13.5 MiB（CPR 49cee239）
		return !d.server.wsSessions.httpForFullPayload(key, len(d.body), now)
	}
	return len(d.body) < wsPayloadLimit
}

func (s *Server) wsOrigin() string {
	parsed, err := url.Parse(s.cfg.UpstreamBaseURL)
	if err != nil {
		return s.cfg.UpstreamBaseURL
	}
	return parsed.Host
}

// wsBreakerKey：源站 + 账号出口（配置自定义 CA 时区分 TLS 变体），单个账号出口故障不影响其他账号。
func (s *Server) wsBreakerKey(account Account) string {
	key := s.wsOrigin() + "\x00" + egressKey(account)
	if s.customCA {
		key += "\x00tls"
	}
	return key
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

// responseCreateFrame 构造 {"type":"response.create", ...body}：保留正文字段原顺序，`stream` 不为 true 时写为
// true、缺失时补上（CPR websocket_upstream_request）。返回本帧是否声明托管搜索（顶层 tools 或 Lite input 内的工具声明）。
func responseCreateFrame(body []byte) ([]byte, bool, error) {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
		return nil, false, errors.New("response.create body must be a JSON object")
	}
	var out bytes.Buffer
	var bodyType json.RawMessage
	var rest bytes.Buffer
	search, sawStream := false, false
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
			sawStream = true
			value = json.RawMessage("true")
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
	if !sawStream {
		rest.WriteString(`,"stream":true`)
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

// wsRecoveryDelay：第 attempt 次恢复前的退避 200ms×2^(attempt-1)，乘以 [0.9, 1.1) 的抖动。
func wsRecoveryDelay(attempt int) time.Duration {
	delay := wsRecoveryBase << (attempt - 1)
	return delay + time.Duration(float64(delay)*(rand.Float64()*0.2-0.1))
}

type wsOpened struct {
	conn   *wsConn
	header http.Header
	// resp 是握手被明确拒绝（4xx/5xx，非 426）时的响应，按 HTTP 失败分类
	resp *http.Response
}

// dialPooledConn 取代理名额并完成握手，成功后启动读循环；426 返回 errWSUpgradeRequired。
func (s *Server) dialPooledConn(ctx context.Context, account Account, header http.Header, idleKey string, search bool, pinned *routingAffinity) (wsOpened, error) {
	proxyKey := account.ProxyURL
	if err := s.ws.acquireProxySlot(ctx, proxyKey, account.ProxyMaxWS); err != nil {
		if ctx.Err() != nil {
			return wsOpened{}, ctx.Err()
		}
		return wsOpened{}, errWSFallback
	}
	dialed, resp, err := s.dialWSHeader(ctx, account, header)
	if err != nil {
		s.ws.releaseProxySlot(proxyKey)
		if resp != nil && resp.StatusCode != http.StatusSwitchingProtocols {
			if resp.StatusCode == http.StatusUpgradeRequired {
				return wsOpened{}, errWSUpgradeRequired
			}
			if resp.StatusCode >= 400 {
				return wsOpened{resp: resp}, nil
			}
		}
		return wsOpened{}, err
	}
	now := time.Now()
	conn := &wsConn{conn: dialed, account: account.ID, credentialRevision: account.CredentialRevision, origin: s.wsOrigin(), createdAt: now, lastUsed: now, webSearch: search, active: true, affinity: pinned, ephemeral: pinned != nil, idleKey: idleKey, proxyKey: proxyKey}
	if pinned == nil {
		conn.affinity = routingAffinityFromResponse(s.wsURL(), resp.Header)
	}
	dialed.SetReadLimit(-1)
	conn.start()
	return wsOpened{conn: conn, header: resp.Header}, nil
}

func breakerSuccess(opened wsOpened, err error) bool {
	if errors.Is(err, errWSUpgradeRequired) {
		return true
	}
	if err != nil {
		return false
	}
	return opened.resp == nil || opened.resp.StatusCode < 500
}

// openWS 冷建连：必须走 WS 的请求不取熔断许可；新链与持久续接走 800ms 快路径，其余同步建连。
func (d *dispatchRun) openWS(ctx context.Context, account Account, header http.Header, idleKey string, search bool, pinned *routingAffinity, requirement wsRequirement) (wsOpened, error) {
	s := d.server
	breakerKey := s.wsBreakerKey(account)
	useBreaker := requirement != wsRequired
	var probe uint64
	if useBreaker {
		permit, ok := s.ws.breakerAcquire(breakerKey, time.Now())
		if !ok {
			return wsOpened{}, errWSFallback
		}
		probe = permit
	}
	if requirement == wsFastPath && pinned == nil {
		return d.openFast(ctx, account, header, idleKey, search, breakerKey, probe)
	}
	release, err := s.ws.acquireOpening(ctx, false)
	if err != nil {
		if useBreaker {
			s.ws.breakerCancel(breakerKey, probe, time.Now())
		}
		if ctx.Err() != nil {
			return wsOpened{}, ctx.Err()
		}
		return wsOpened{}, errWSFallback
	}
	defer release()
	opened, err := s.dialPooledConn(ctx, account, header.Clone(), idleKey, search, pinned)
	if useBreaker {
		if ctx.Err() != nil && err != nil {
			s.ws.breakerCancel(breakerKey, probe, time.Now())
		} else {
			s.ws.breakerResult(breakerKey, probe, breakerSuccess(opened, err), time.Now())
		}
	}
	return opened, err
}

// openFast：CPR 快路径。建连在后台进行，前台最多等 800ms；超时本次改走 HTTP（不计熔断失败），
// 后台继续建连并把成功的连接放进空闲池。拿不到建连名额时同样本次走 HTTP。
func (d *dispatchRun) openFast(ctx context.Context, account Account, header http.Header, idleKey string, search bool, breakerKey string, probe uint64) (wsOpened, error) {
	s := d.server
	release, err := s.ws.acquireOpening(ctx, true)
	if err != nil {
		s.ws.breakerCancel(breakerKey, probe, time.Now())
		return wsOpened{}, errWSFastPathMiss
	}
	select {
	case s.ws.poolOpenings <- struct{}{}:
	default:
		release()
		s.ws.breakerCancel(breakerKey, probe, time.Now())
		return wsOpened{}, errWSFastPathMiss
	}
	type result struct {
		opened wsOpened
		err    error
	}
	var mu sync.Mutex
	waiting := true
	ch := make(chan result, 1)
	header = header.Clone()
	go func() {
		defer func() {
			<-s.ws.poolOpenings
			release()
		}()
		dialCtx, cancel := context.WithTimeout(context.Background(), wsConnectTimeout)
		defer cancel()
		opened, err := s.dialPooledConn(dialCtx, account, header, idleKey, search, nil)
		s.ws.breakerResult(breakerKey, probe, breakerSuccess(opened, err), time.Now())
		mu.Lock()
		if waiting {
			ch <- result{opened, err}
			mu.Unlock()
			return
		}
		mu.Unlock()
		// 前台已改走 HTTP：建好的连接进空闲池供同一会话后续请求复用
		if err == nil && opened.conn != nil {
			s.ws.put("", opened.conn, time.Now())
		}
		if opened.resp != nil && opened.resp.Body != nil {
			_ = opened.resp.Body.Close()
		}
	}()
	timer := time.NewTimer(wsFastPathBudget)
	defer timer.Stop()
	select {
	case r := <-ch:
		return r.opened, r.err
	case <-timer.C:
	case <-ctx.Done():
	}
	mu.Lock()
	waiting = false
	select {
	case r := <-ch:
		mu.Unlock()
		return r.opened, r.err
	default:
	}
	mu.Unlock()
	if ctx.Err() != nil {
		return wsOpened{}, ctx.Err()
	}
	return wsOpened{}, errWSFastPathMiss
}

// sendWS 通过上游 WebSocket 发送一轮 response.create。返回的 *http.Response 是由 WS 事件转成的 SSE 流，
// 与 HTTP 路径共用提交、观察与 Receipt 逻辑；握手被拒（非 101）按 HTTP 失败交给分类器。
func (d *dispatchRun) sendWS(ctx context.Context, account Account) (*http.Response, bool, error) {
	s := d.server
	requirement := d.wsRequirement()
	attemptBody, state, pinned := d.prepareAttempt(account)
	d.affinity = nil
	d.attemptState = state
	attemptBody = projectWSClientMetadata(attemptBody, d.inboundHeader("x-openai-internal-codex-responses-lite"), state.turnState, time.Now())
	handshakeHeader := s.wsHandshakeHeader(account, d.upstreamInboundHeaders(), codexRoutingHint(attemptBody), pinned, state)
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
	idleKey := ""
	if pinned != nil {
		poolKey = ""
	} else {
		idleKey = d.wsIdleKey(account, handshakeHeader)
	}
	for attempt := 0; attempt <= wsRecoveryLimit; attempt++ {
		if attempt > 0 && !sleepContext(ctx, wsRecoveryDelay(attempt)) {
			return nil, true, ctx.Err()
		}
		var conn *wsConn
		if pinned == nil {
			conn = s.ws.take(poolKey, idleKey, account.ID, account.CredentialRevision, search, time.Now())
		}
		if conn == nil && d.nativeContinuation {
			// 连接内续接只能在原连接上发送
			return nil, false, errContinuationLost
		}
		var handshake http.Header
		if conn == nil {
			opened, err := d.openWS(ctx, account, handshakeHeader, idleKey, search, pinned, requirement)
			switch {
			case opened.resp != nil:
				return opened.resp, true, nil
			case errors.Is(err, errWSUpgradeRequired):
				// 426 是明确的传输切换信号：本会话改走 HTTP
				s.wsSessions.disable(d.wsSessionKey(), time.Now())
				return nil, false, errWSFallback
			case errors.Is(err, errWSFallback):
				return nil, false, err
			case err != nil:
				if ctx.Err() != nil {
					return nil, false, ctx.Err()
				}
				s.wsSessions.recordFailure(d.wsSessionKey(), time.Now())
				continue
			}
			conn, handshake = opened.conn, opened.header
		}
		writeCtx, cancelWrite := context.WithTimeout(ctx, wsSendTimeout)
		err := conn.conn.Write(writeCtx, websocket.MessageText, frame)
		cancelWrite()
		if err != nil {
			s.ws.discard(poolKey, conn)
			if ctx.Err() != nil {
				return nil, true, ctx.Err()
			}
			if d.nativeContinuation {
				return nil, false, errContinuationLost
			}
			s.wsSessions.recordFailure(d.wsSessionKey(), time.Now())
			continue
		}
		first, err := conn.next(ctx, wsStreamIdleTimeout)
		if err != nil {
			// 首个事件前断线：同账号有界恢复（CPR：发送状态不明不单独阻止该恢复）；只计会话预算，不计熔断
			s.ws.discard(poolKey, conn)
			if ctx.Err() != nil {
				return nil, true, ctx.Err()
			}
			if d.nativeContinuation {
				return nil, true, errContinuationLost
			}
			s.wsSessions.recordFailure(d.wsSessionKey(), time.Now())
			continue
		}
		s.wsSessions.succeeded(d.wsSessionKey())
		d.affinity = conn.affinity
		if resp := wsErrorResponse(first); resp != nil {
			s.ws.discard(poolKey, conn)
			return resp, true, nil
		}
		s.ws.bind(poolKey, conn)
		// 握手响应头（turn-state、Set-Cookie、额度头）只属于建连后的首个响应；复用连接不再交付（CPR reusable_websocket_metadata）
		header := http.Header{}
		for key, values := range handshake {
			lower := strings.ToLower(key)
			if lower == "connection" || lower == "upgrade" || strings.HasPrefix(lower, "sec-websocket-") {
				continue
			}
			header[key] = values
		}
		header.Set("Content-Type", "text/event-stream")
		body := newWSBody(ctx, s.ws, poolKey, conn, first)
		return &http.Response{StatusCode: http.StatusOK, Header: header, Body: body}, true, nil
	}
	if d.nativeContinuation {
		return nil, true, errContinuationLost
	}
	// 恢复次数耗尽：可回退的请求转 HTTP 并在本会话转用 HTTP（CPR disable_websocket）
	if requirement != wsRequired {
		s.wsSessions.disable(d.wsSessionKey(), time.Now())
	}
	return nil, true, errWSFallback
}

// wsProfileHeaders 是区分 WS opening 画像的握手头（CPR websocket_connection_profile）：画像或部署配置不同的
// 连接不能互相复用；空值也是显式配置，与未发送区分。
var wsProfileHeaders = []string{"originator", "user-agent", "version", "x-openai-memgen-request", "x-codex-guardian", "x-openai-internal-codex-residency", "x-openai-account-routing-override"}

// wsIdleKey 是上游 WS 空闲池键（对齐 CPR websocket_pool_key）：账号、出口、调用方范围、会话锚点与握手画像都相同
// 才复用，避免把别的会话的握手身份（session-id、thread-id、turn metadata、UA）带到本请求；没有会话锚点时返回空。
func (d *dispatchRun) wsIdleKey(account Account, handshake http.Header) string {
	anchor := d.conversationAnchor()
	if anchor == "" {
		return ""
	}
	digest := sha256.New()
	write := func(value string) {
		digest.Write([]byte(strconv.Itoa(len(value))))
		digest.Write([]byte{0})
		digest.Write([]byte(value))
	}
	write(account.ID)
	write(account.ProxyURL)
	write(d.envelope.ClientScope)
	write(anchor)
	for _, name := range wsProfileHeaders {
		if values, ok := handshake[http.CanonicalHeaderKey(name)]; ok {
			write(name + ":" + strings.Join(values, "\x00"))
		} else {
			write(name)
		}
	}
	return hex.EncodeToString(digest.Sum(nil))
}

// conversationAnchor 按 CPR derive_conversation_anchor 的顺序取会话锚点：thread_spawn 子线程用自己的 thread-id，
// 其次会话 ID、线程 ID、prompt_cache_key、由模型+instructions+首条用户文本派生的稳定键，最后 previous_response_id。
// 只用于本进程的连接复用判定，结果在本次分发内缓存。
func (d *dispatchRun) conversationAnchor() string {
	if d.anchorDone {
		return d.anchor
	}
	d.anchorDone = true
	d.anchor = deriveConversationAnchor(d.envelope.Scope.SessionID, d.envelope.Headers, d.body)
	return d.anchor
}

const threadSpawnSubagentKind = "thread_spawn"

func deriveConversationAnchor(sessionID string, headers map[string]string, body []byte) string {
	var fields struct {
		Model              string            `json:"model"`
		Instructions       string            `json:"instructions"`
		PromptCacheKey     string            `json:"prompt_cache_key"`
		PreviousResponseID string            `json:"previous_response_id"`
		SubagentKind       string            `json:"subagent_kind"`
		ClientMetadata     map[string]any    `json:"client_metadata"`
		Input              []json.RawMessage `json:"input"`
	}
	_ = json.Unmarshal(topLevelSubset(body, "model", "instructions", "prompt_cache_key", "previous_response_id", "subagent_kind", "client_metadata", "input"), &fields)
	header := func(name string) string {
		for key, value := range headers {
			if strings.EqualFold(key, name) {
				return strings.TrimSpace(value)
			}
		}
		return ""
	}
	thread := header("thread-id")
	kind := header("x-openai-subagent")
	if kind == "" {
		kind = strings.TrimSpace(fields.SubagentKind)
	}
	if kind == "" {
		kind, _ = fields.ClientMetadata["x-openai-subagent"].(string)
		kind = strings.TrimSpace(kind)
	}
	switch {
	case kind == threadSpawnSubagentKind && thread != "":
		return "subagent-thread\x00" + thread
	case strings.TrimSpace(sessionID) != "":
		return "session\x00" + strings.TrimSpace(sessionID)
	case header("session-id") != "":
		return "session\x00" + header("session-id")
	case thread != "":
		return "thread\x00" + thread
	case strings.TrimSpace(fields.PromptCacheKey) != "":
		return "prompt-cache\x00" + strings.TrimSpace(fields.PromptCacheKey)
	}
	if stable := stableConversationKey(fields.Model, fields.Instructions, fields.Input); stable != "" {
		return "request\x00" + stable
	}
	if previous := strings.TrimSpace(fields.PreviousResponseID); previous != "" {
		return "previous\x00" + previous
	}
	return ""
}

// stableConversationKey 对齐 CPR derive_stable_conversation_key：模型、instructions 前 2000 字符与首条用户文本
// （去掉开头的 <system-reminder> 段）的摘要；两者都为空时没有稳定键。
func stableConversationKey(model, instructions string, input []json.RawMessage) string {
	if runes := []rune(instructions); len(runes) > 2000 {
		instructions = string(runes[:2000])
	}
	text := firstUserText(input)
	if normalized := stripLeadingSystemReminders(text); normalized != "" {
		text = normalized
	}
	if instructions == "" && text == "" {
		return ""
	}
	digest := sha256.Sum256([]byte(model + "\x00" + instructions + "\x00" + text))
	return hex.EncodeToString(digest[:16])
}

func firstUserText(input []json.RawMessage) string {
	for _, raw := range input {
		var item struct {
			Role    string          `json:"role"`
			Content json.RawMessage `json:"content"`
		}
		if json.Unmarshal(raw, &item) != nil || item.Role != "user" {
			continue
		}
		var text string
		if json.Unmarshal(item.Content, &text) == nil {
			return text
		}
		var parts []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}
		if json.Unmarshal(item.Content, &parts) != nil {
			return ""
		}
		var out strings.Builder
		for _, part := range parts {
			if part.Type == "input_text" {
				out.WriteString(part.Text)
			}
		}
		return out.String()
	}
	return ""
}

func stripLeadingSystemReminders(text string) string {
	const open, closeTag = "<system-reminder>", "</system-reminder>"
	rest := strings.TrimLeft(text, " \t\r\n")
	// 只按 ASCII 转小写，保证下标仍对应原文
	lower := func(value string) string {
		return strings.Map(func(r rune) rune {
			if r >= 'A' && r <= 'Z' {
				return r + 'a' - 'A'
			}
			return r
		}, value)
	}
	for strings.HasPrefix(lower(rest), open) {
		end := strings.Index(lower(rest), closeTag)
		if end < 0 {
			break
		}
		rest = strings.TrimLeft(rest[end+len(closeTag):], " \t\r\n")
	}
	return rest
}

// wsErrorResponse：WS 错误帧 {"type":"error","status":429,"error":{...},"headers":{...}} 转成 HTTP 失败。
func wsErrorResponse(frame []byte) *http.Response {
	var event struct {
		Type    string            `json:"type"`
		Status  int               `json:"status"`
		Error   json.RawMessage   `json:"error"`
		Headers map[string]string `json:"headers"`
	}
	if json.Unmarshal(frame, &event) != nil || event.Type != "error" {
		return nil
	}
	if event.Status < 400 {
		// 连接寿命上限：按限流处理，可安全重放（CPR websocket_connection_limit_reached）
		var detail struct {
			Code string `json:"code"`
		}
		if json.Unmarshal(event.Error, &detail) != nil || detail.Code != "websocket_connection_limit_reached" {
			return nil
		}
		event.Status = http.StatusTooManyRequests
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
		if name, ok := upstreamHeaderName(key); ok {
			header.Set(name, value)
		}
	}
	header.Set("openai-beta", wsBetaHeader)
	if routingHint != "" {
		header.Set("x-codex-routing-hint", routingHint)
	}
	scopeCorrelationHeaders(header, account.InstallationID)
	// turn-state 同时写在握手头与首帧 client_metadata（CPR headers.rs 与 client.rs 共用 request.turn_state）
	applyAttemptHeaders(header, account, state)
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
	client, err := s.cachedClient("ws\x00"+egressKey(account), func() (*http.Client, error) {
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

// wsBody 把上游 WS 事件转换为 SSE 文本（event: <type> / data: <json>），对齐 CPR exchange reducer：
//   - completed 与 reason=interrupted 的 incomplete 让连接回池（或保持入站绑定），并记为连接内续接的最新响应；
//   - 其他 incomplete、failed 与任意位置的 type=error 帧是终态，丢弃连接；终态前关闭（含 Close 1000）按失败处理；
//   - codex.rate_limits 不转发给调用方，解析后由提交阶段并入额度；
//   - response.metadata 帧原样转发，其中本响应首个 x-codex-turn-state 交给客户端（复用连接时只有这一来源）。
type wsBody struct {
	reader *io.PipeReader
	cancel context.CancelFunc
	once   sync.Once

	mu         sync.Mutex
	rateLimits map[string]any
	turnState  string
	diagnostic string
}

func newWSBody(parent context.Context, pool *wsPool, key string, conn *wsConn, first []byte) *wsBody {
	reader, writer := io.Pipe()
	ctx, cancel := context.WithCancel(parent)
	body := &wsBody{reader: reader, cancel: cancel}
	conn.streaming.Store(true)
	go func() {
		reusable := false
		defer func() {
			conn.streaming.Store(false)
			if reusable {
				pool.put(key, conn, time.Now())
			} else {
				pool.discard(key, conn)
			}
		}()
		message := first
		for {
			event := wsEventInfo(message)
			switch event.Type {
			case "codex.rate_limits":
				var raw map[string]any
				if json.Unmarshal(message, &raw) == nil {
					if limits := parseRateLimitsEvent(raw, time.Now()); len(limits) > 0 {
						body.mu.Lock()
						body.rateLimits = limits
						body.mu.Unlock()
					}
				}
			case "response.metadata", "codex.response.metadata":
				if state := event.turnState(); state != "" {
					body.mu.Lock()
					if body.turnState == "" {
						body.turnState = state
					}
					body.mu.Unlock()
				}
			}
			if event.Type != "codex.rate_limits" {
				var chunk bytes.Buffer
				if event.Type != "" {
					fmt.Fprintf(&chunk, "event: %s\n", event.Type)
				}
				chunk.WriteString("data: ")
				chunk.Write(message)
				chunk.WriteString("\n\n")
				if _, err := writer.Write(chunk.Bytes()); err != nil {
					return
				}
			}
			switch event.Type {
			case "response.completed", "response.done":
				reusable = true
			case "response.incomplete":
				reusable = event.Response.IncompleteDetails.Reason == "interrupted"
			case "response.failed", "error":
			default:
				next, err := conn.next(ctx, wsStreamIdleTimeout)
				if err != nil {
					// 终态前断开：记录关闭码、关闭原因、最后事件与连接退出原因，提交阶段经 trailer 交给控制面
					if ctx.Err() == nil {
						readErr := err
						if !errors.Is(err, errWSIdle) {
							readErr = conn.err()
						}
						body.mu.Lock()
						body.diagnostic = string(wsCloseDiagnostic(readErr, event.Type))
						body.mu.Unlock()
					}
					_ = writer.CloseWithError(errWSClosedBeforeTerminal)
					return
				}
				message = next
				continue
			}
			if reusable && event.Response.ID != "" {
				pool.mu.Lock()
				conn.latestResponseID = event.Response.ID
				pool.mu.Unlock()
			}
			_ = writer.Close()
			return
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

// metadata 返回流内最新的 codex.rate_limits 与本响应 metadata 帧声明的 turn-state。
func (b *wsBody) metadata() (map[string]any, string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.rateLimits, b.turnState
}

// closeDiagnostic 返回终态前断开的诊断 JSON（正常结束为空）。
func (b *wsBody) closeDiagnostic() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.diagnostic
}

// wsBodyOf 取出（可能被前导窥视包装过的）WS 响应正文。
func wsBodyOf(body io.ReadCloser) *wsBody {
	switch value := body.(type) {
	case *wsBody:
		return value
	case readCloser:
		if inner, ok := value.Closer.(*wsBody); ok {
			return inner
		}
	}
	return nil
}

type wsEvent struct {
	Type     string `json:"type"`
	Response struct {
		ID                string `json:"id"`
		IncompleteDetails struct {
			Reason string `json:"reason"`
		} `json:"incomplete_details"`
	} `json:"response"`
	Headers map[string]any `json:"headers"`
}

func wsEventInfo(message []byte) wsEvent {
	var event wsEvent
	_ = json.Unmarshal(message, &event)
	return event
}

// turnState：metadata 帧 headers 中的 x-codex-turn-state（数组取第一个字符串）。
func (e wsEvent) turnState() string {
	for name, value := range e.Headers {
		if !strings.EqualFold(name, "x-codex-turn-state") {
			continue
		}
		switch typed := value.(type) {
		case string:
			return strings.TrimSpace(typed)
		case []any:
			if len(typed) > 0 {
				if text, ok := typed[0].(string); ok {
					return strings.TrimSpace(text)
				}
			}
		}
	}
	return ""
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
