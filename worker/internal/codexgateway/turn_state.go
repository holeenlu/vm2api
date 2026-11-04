package codexgateway

import (
	"crypto/sha256"
	"encoding/binary"
	"hash"
	"sync"
	"time"
)

// turnStateProofs 只为上游已交给客户端的 turn-state 保存归属证明（对齐 codex-proxy-rs
// provider/turn_state.rs，790f3147）：键是 Client Key 范围、账号、会话、线程、turn id 与 token 的摘要，
// 只存 32 字节摘要与过期时间，不保存 token 原文，也不参与选号。
// 归属不明（未钉住账号、会话记录缺失或过期）的全量请求，只在 token 被证明属于本账号时回传该 token；
// 证明不能放行 previous_response_id 等其他账号状态。
type turnStateProofs struct {
	mu     sync.Mutex
	proofs map[[32]byte]time.Time
}

const turnStateProofCapacity = 4096

func newTurnStateProofs() *turnStateProofs {
	return &turnStateProofs{proofs: map[[32]byte]time.Time{}}
}

// turnStateScope 是一次尝试的证明范围；没有客户端 turn id 时不建立证明。
type turnStateScope struct {
	identity hash.Hash
	ok       bool
}

func (d *dispatchRun) turnStateScope(account Account) turnStateScope {
	turnID := d.inboundHeader("x-codex-turn-id")
	if turnID == "" {
		return turnStateScope{}
	}
	identity := sha256.New()
	for _, part := range []string{d.envelope.ClientScope, account.ID, d.inboundHeader("session-id"), d.inboundHeader("thread-id"), turnID} {
		writeProofPart(identity, part)
	}
	// OAuth 刷新不改变账号归属；API Key 替换后不能继承原认证的路由状态
	if account.APIKey != "" {
		identity.Write([]byte{1})
		_ = binary.Write(identity, binary.LittleEndian, account.CredentialRevision)
	} else {
		identity.Write([]byte{0})
	}
	return turnStateScope{identity: identity, ok: true}
}

func writeProofPart(h hash.Hash, part string) {
	_ = binary.Write(h, binary.LittleEndian, uint64(len(part)))
	h.Write([]byte(part))
}

func (scope turnStateScope) key(token string) [32]byte {
	sum := sha256.New()
	sum.Write(scope.identity.Sum(nil))
	writeProofPart(sum, token)
	var out [32]byte
	copy(out[:], sum.Sum(nil))
	return out
}

// owns 判断 token 是否已证明属于本范围；命中时续期。
func (p *turnStateProofs) owns(scope turnStateScope, token string, retention time.Duration, now time.Time) bool {
	if !scope.ok || token == "" {
		return false
	}
	key := scope.key(token)
	p.mu.Lock()
	defer p.mu.Unlock()
	expires, ok := p.proofs[key]
	if !ok {
		return false
	}
	if !expires.After(now) {
		delete(p.proofs, key)
		return false
	}
	p.proofs[key] = now.Add(retention)
	return true
}

// remember 记录上游交给客户端的 token（成功与失败响应都记录）；满额时先清过期项，再淘汰最早到期的一项。
func (p *turnStateProofs) remember(scope turnStateScope, token string, retention time.Duration, now time.Time) {
	if !scope.ok || token == "" {
		return
	}
	key := scope.key(token)
	p.mu.Lock()
	defer p.mu.Unlock()
	if _, exists := p.proofs[key]; !exists && len(p.proofs) >= turnStateProofCapacity {
		for k, expires := range p.proofs {
			if !expires.After(now) {
				delete(p.proofs, k)
			}
		}
		if len(p.proofs) >= turnStateProofCapacity {
			var oldestKey [32]byte
			var oldest time.Time
			first := true
			for k, expires := range p.proofs {
				if first || expires.Before(oldest) {
					oldestKey, oldest, first = k, expires, false
				}
			}
			delete(p.proofs, oldestKey)
		}
	}
	p.proofs[key] = now.Add(retention)
}

// rememberTurnState 记录本账号交给客户端的 turn-state。
func (d *dispatchRun) rememberTurnState(account Account, token string) {
	if account.ID == "" || token == "" {
		return
	}
	s := d.server
	s.turnStates.remember(d.turnStateScope(account), token, s.store.SessionTTL(), time.Now())
}
