package codexgateway

import (
	"context"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// 会话级 WS 失败预算（对齐 codex-proxy-rs session_transport.rs）：同一调用方会话连续 WS 失败达到上限、
// 或收到明确的传输切换（426）后，该会话后续请求直接走 HTTP；成功一次即清除，空闲 8 小时释放。
const (
	wsSessionIdleRetention = 8 * time.Hour
	maxWSSessions          = 16384
)

type wsSessionState struct {
	failures int
	http     bool
	lastUsed time.Time
}

type wsSessionBudget struct {
	mu       sync.Mutex
	sessions map[string]*wsSessionState
}

func newWSSessionBudget() *wsSessionBudget {
	return &wsSessionBudget{sessions: map[string]*wsSessionState{}}
}

func (b *wsSessionBudget) usesHTTP(key string, now time.Time) bool {
	if key == "" {
		return false
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	state := b.sessions[key]
	if state == nil {
		return false
	}
	if now.Sub(state.lastUsed) >= wsSessionIdleRetention {
		delete(b.sessions, key)
		return false
	}
	state.lastUsed = now
	return state.http
}

func (b *wsSessionBudget) update(key string, now time.Time, fn func(*wsSessionState)) {
	if key == "" {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	state := b.sessions[key]
	if state == nil || now.Sub(state.lastUsed) >= wsSessionIdleRetention {
		state = &wsSessionState{}
		if len(b.sessions) >= maxWSSessions {
			var oldestKey string
			var oldest time.Time
			for k, s := range b.sessions {
				if oldestKey == "" || s.lastUsed.Before(oldest) {
					oldestKey, oldest = k, s.lastUsed
				}
			}
			delete(b.sessions, oldestKey)
		}
		b.sessions[key] = state
	}
	state.lastUsed = now
	fn(state)
}

// recordFailure 记一次会话 WS 失败；超过恢复上限后该会话转为 HTTP。
func (b *wsSessionBudget) recordFailure(key string, now time.Time) {
	b.update(key, now, func(state *wsSessionState) {
		if state.failures < wsRecoveryLimit {
			state.failures++
			return
		}
		state.http = true
	})
}

func (b *wsSessionBudget) disable(key string, now time.Time) {
	b.update(key, now, func(state *wsSessionState) { state.http = true })
}

func (b *wsSessionBudget) succeeded(key string) {
	if key == "" {
		return
	}
	b.mu.Lock()
	delete(b.sessions, key)
	b.mu.Unlock()
}

// wsSessionKey：调用方范围 + 原始会话 ID；没有会话 ID 时不建立会话状态。
func (d *dispatchRun) wsSessionKey() string {
	session := d.inboundHeader("session-id")
	if session == "" {
		return ""
	}
	return d.envelope.ClientScope + "\x00" + session
}

// 按代理共享的物理 WS 连接预算（对齐 codex-proxy-rs websocket/pool/capacity.rs）：同一出站代理的
// 连接合计不超过 limit（0 不限，但仍计数）；满额时先回收该代理下最旧的未绑定空闲连接，
// 否则等待名额，建连超时内仍无名额则本次回退 HTTP。
func (p *wsPool) acquireProxySlot(ctx context.Context, proxyKey string, limit int) error {
	if proxyKey == "" {
		return nil
	}
	deadline := time.NewTimer(wsConnectTimeout)
	defer deadline.Stop()
	for {
		p.mu.Lock()
		if limit <= 0 || p.proxyConns[proxyKey] < limit {
			p.proxyConns[proxyKey]++
			p.mu.Unlock()
			return nil
		}
		var victim *wsConn
		victimAccount, victimIndex := "", -1
		for account, conns := range p.idle {
			for i, conn := range conns {
				if conn.proxyKey == proxyKey && (victim == nil || conn.lastUsed.Before(victim.lastUsed)) {
					victim, victimAccount, victimIndex = conn, account, i
				}
			}
		}
		if victim != nil {
			conns := p.idle[victimAccount]
			p.idle[victimAccount] = append(conns[:victimIndex:victimIndex], conns[victimIndex+1:]...)
			p.mu.Unlock()
			p.closeConn(victim, websocket.StatusNormalClosure, "proxy capacity")
			continue
		}
		changed := p.capacityChanged
		p.mu.Unlock()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return errWSFallback
		case <-changed:
		}
	}
}

// releaseProxySlot 归还一个代理名额并唤醒等待者。
func (p *wsPool) releaseProxySlot(proxyKey string) {
	if proxyKey == "" {
		return
	}
	p.mu.Lock()
	if p.proxyConns[proxyKey] > 0 {
		p.proxyConns[proxyKey]--
	}
	if p.proxyConns[proxyKey] == 0 {
		delete(p.proxyConns, proxyKey)
	}
	close(p.capacityChanged)
	p.capacityChanged = make(chan struct{})
	p.mu.Unlock()
}

// closeConn 关闭上游连接并只归还一次代理名额。
func (p *wsPool) closeConn(conn *wsConn, code websocket.StatusCode, reason string) {
	if conn.released.CompareAndSwap(false, true) {
		p.releaseProxySlot(conn.proxyKey)
	}
	_ = conn.conn.Close(code, reason)
}
