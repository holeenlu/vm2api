package codexgateway

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// 跨实例账号并发租约（统一控制面重构 P5.2）：同一账号投影到多个 Worker 时，各实例各自按 max_concurrency 计数，
// 合计可能超过账号上限。配置 Redis 后，本地准入成功再取共享租约：每个账号、每个池（普通 / Guardian）一个有序集合，
// 成员为持有者令牌、分数为到期时刻；Lua 脚本原子执行“清理过期 → 未满则加入”。
//   - 被拒：归还本地租约并撤回准入副作用，把该账号短暂记为“远端满载”（sharedBusyHold），调度按原有排队等待；
//   - 租约 30 秒到期，每 10 秒续期，请求结束释放；
//   - Redis 不可用时准入的请求没有令牌，按“无令牌租约”单独计数（R5 审查 R5-1）：归还时先减无令牌计数，
//     不会删掉其他请求的令牌；Redis 恢复后在续期时为它们补登记，使共享计数与本地在途一致；
//   - 续期发现令牌已丢失（Redis 重启等）且本地仍持有：补登记，不取消在途请求（中途取消会伤害调用方并浪费上游用量）。
//     这种情况下合计并发可能短暂超过上限，新的准入在计数恢复前会被拒；
//   - 续期只延长仍在的令牌（ZADD XX），与归还的异步删除竞争时不会把已归还的令牌加回去（R5-6）。
//
// 同一实例同一账号同一池的租约令牌可互换：本地归还一个租约即释放一个令牌（或减一个无令牌计数），不需要沿请求路径传递令牌。
const (
	sharedLeaseTTL   = 30 * time.Second
	sharedLeaseRenew = 10 * time.Second
	sharedBusyHold   = 250 * time.Millisecond
)

var sharedLeaseAcquireScript = redis.NewScript(`
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then return 0 end
redis.call('ZADD', KEYS[1], ARGV[3], ARGV[4])
redis.call('PEXPIRE', KEYS[1], ARGV[5])
return 1
`)

// 续期：只延长仍在的令牌；返回 1 已延长，0 已不在
var sharedLeaseRenewScript = redis.NewScript(`
local updated = redis.call('ZADD', KEYS[1], 'XX', 'CH', ARGV[1], ARGV[2])
if redis.call('ZSCORE', KEYS[1], ARGV[2]) then
  redis.call('PEXPIRE', KEYS[1], ARGV[3])
  return 1
end
return 0
`)

type sharedLeases struct {
	shared *sharedState
	mu     sync.Mutex
	held   map[queueKey][]string
	// untokened 是 Redis 不可用时准入、没有令牌的在途租约数
	untokened map[queueKey]int
	// lost 统计续期时发现丢失并补登记的租约数（健康接口展示）
	lost int64
}

func newSharedLeases(shared *sharedState) *sharedLeases {
	if shared == nil {
		return nil
	}
	return &sharedLeases{shared: shared, held: map[queueKey][]string{}, untokened: map[queueKey]int{}}
}

func (l *sharedLeases) key(id queueKey) string {
	pool := "n"
	if id.guardian {
		pool = "g"
	}
	return l.shared.key("sem", sharedDigest(id.account), pool)
}

func (l *sharedLeases) newToken() string {
	raw := make([]byte, 12)
	_, _ = rand.Read(raw)
	return l.shared.instance + ":" + hex.EncodeToString(raw)
}

// acquire 取共享租约；limit<=0（不限并发）时直接放行；Redis 不可用或出错时放行并记一个无令牌租约。返回是否取得。
func (l *sharedLeases) acquire(account string, guardian bool, limit int) bool {
	if l == nil || limit <= 0 {
		return true
	}
	id := queueKey{account, guardian}
	if !l.shared.usable() {
		l.addUntokened(id)
		return true
	}
	token := l.newToken()
	now := time.Now()
	ctx, cancel := l.shared.opContext(context.Background())
	defer cancel()
	result, err := sharedLeaseAcquireScript.Run(ctx, l.shared.client, []string{l.key(id)},
		now.UnixMilli(), limit, now.Add(sharedLeaseTTL).UnixMilli(), token, (2 * sharedLeaseTTL).Milliseconds()).Int64()
	l.shared.observe(err)
	if err != nil {
		l.addUntokened(id)
		return true
	}
	if result != 1 {
		return false
	}
	l.mu.Lock()
	l.held[id] = append(l.held[id], token)
	l.mu.Unlock()
	return true
}

func (l *sharedLeases) addUntokened(id queueKey) {
	l.mu.Lock()
	l.untokened[id]++
	l.mu.Unlock()
}

// releaseOne 归还本实例在该账号该池上的一个共享租约（本地租约归还时调用）：先减无令牌计数，再释放令牌。
// 池以归还时计算的为准；该池没有记录时（准入后 Guardian 池设置变了）退到另一个池，避免令牌成为孤儿。
func (l *sharedLeases) releaseOne(account string, guardian bool) {
	if l == nil {
		return
	}
	l.mu.Lock()
	id := queueKey{account, guardian}
	if l.untokened[id] == 0 && len(l.held[id]) == 0 {
		id = queueKey{account, !guardian}
	}
	if l.untokened[id] > 0 {
		l.untokened[id]--
		if l.untokened[id] == 0 {
			delete(l.untokened, id)
		}
		l.mu.Unlock()
		return
	}
	tokens := l.held[id]
	if len(tokens) == 0 {
		l.mu.Unlock()
		return
	}
	token := tokens[len(tokens)-1]
	if len(tokens) == 1 {
		delete(l.held, id)
	} else {
		l.held[id] = tokens[:len(tokens)-1]
	}
	l.mu.Unlock()
	go func() {
		ctx, cancel := l.shared.opContext(context.Background())
		defer cancel()
		// 释放失败（Redis 不可用）时由到期时刻兜底
		l.shared.observe(l.shared.client.ZRem(ctx, l.key(id), token).Err())
	}()
}

func (l *sharedLeases) holds(id queueKey, token string) bool {
	for _, held := range l.held[id] {
		if held == token {
			return true
		}
	}
	return false
}

// renew 续期本实例持有的全部共享租约；为无令牌租约补登记；本地仍持有但已丢失的令牌补登记。
func (l *sharedLeases) renew() {
	if l == nil || !l.shared.usable() {
		return
	}
	type item struct {
		id    queueKey
		token string
	}
	l.mu.Lock()
	var items []item
	for id, tokens := range l.held {
		for _, token := range tokens {
			items = append(items, item{id, token})
		}
	}
	pending := map[queueKey]int{}
	for id, count := range l.untokened {
		pending[id] = count
	}
	l.mu.Unlock()
	ctx, cancel := l.shared.opContext(context.Background())
	defer cancel()
	expiry := time.Now().Add(sharedLeaseTTL).UnixMilli()
	keyTTL := (2 * sharedLeaseTTL).Milliseconds()
	var reregister []item
	if len(items) > 0 {
		pipe := l.shared.client.Pipeline()
		results := make([]*redis.Cmd, len(items))
		for i, it := range items {
			results[i] = sharedLeaseRenewScript.Eval(ctx, pipe, []string{l.key(it.id)}, expiry, it.token, keyTTL)
		}
		_, err := pipe.Exec(ctx)
		l.shared.observe(err)
		if err != nil {
			return
		}
		for i, result := range results {
			if value, _ := result.Int64(); value == 0 {
				reregister = append(reregister, items[i])
			}
		}
	}
	l.mu.Lock()
	// 丢失的令牌只在本地仍持有时补登记（已归还的不加回去）
	kept := reregister[:0]
	for _, it := range reregister {
		if l.holds(it.id, it.token) {
			kept = append(kept, it)
		}
	}
	reregister = kept
	l.lost += int64(len(reregister))
	// 无令牌租约换成令牌
	for id, count := range pending {
		current := l.untokened[id]
		if count > current {
			count = current
		}
		for i := 0; i < count; i++ {
			token := l.newToken()
			l.held[id] = append(l.held[id], token)
			reregister = append(reregister, item{id, token})
		}
		if l.untokened[id] -= count; l.untokened[id] <= 0 {
			delete(l.untokened, id)
		}
	}
	l.mu.Unlock()
	if len(reregister) == 0 {
		return
	}
	pipe := l.shared.client.Pipeline()
	for _, it := range reregister {
		key := l.key(it.id)
		pipe.ZAdd(ctx, key, redis.Z{Score: float64(expiry), Member: it.token})
		pipe.PExpire(ctx, key, 2*sharedLeaseTTL)
	}
	_, err := pipe.Exec(ctx)
	l.shared.observe(err)
	// 补登记期间被归还的令牌（归还的异步删除可能先于补登记执行）：再删一次，不留下没有持有者的令牌（R5 复核 N1）
	l.mu.Lock()
	var released []item
	for _, it := range reregister {
		if !l.holds(it.id, it.token) {
			released = append(released, it)
		}
	}
	l.mu.Unlock()
	if len(released) == 0 {
		return
	}
	pipe = l.shared.client.Pipeline()
	for _, it := range released {
		pipe.ZRem(ctx, l.key(it.id), it.token)
	}
	_, err = pipe.Exec(ctx)
	l.shared.observe(err)
}

func (l *sharedLeases) loop(ctx context.Context) {
	if l == nil {
		return
	}
	ticker := time.NewTicker(sharedLeaseRenew)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			l.renew()
		}
	}
}

func (l *sharedLeases) status() map[string]any {
	if l == nil {
		return nil
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	held, untokened := 0, 0
	for _, tokens := range l.held {
		held += len(tokens)
	}
	for _, count := range l.untokened {
		untokened += count
	}
	return map[string]any{"held": held, "untokened": untokened, "lost_renewed": l.lost}
}

// sharedStatus：健康接口与心跳里的共享运行态（Redis 是否可用、本实例持有的共享租约）。
func (s *Server) sharedStatus() map[string]any {
	status := s.shared.status()
	if leases := s.store.leases.status(); leases != nil {
		status["leases"] = leases
		status["remote_holds"] = s.store.sharedHoldCount()
	}
	return status
}
