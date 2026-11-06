package codexgateway

import (
	"context"
	"strconv"
	"strings"
	"sync"
	"time"
)

// 冷却与冻结共享（统一控制面重构 P5.3）：一个实例上账号被冷却、被错误保护冻结、BPS 冷却或 BPS usage-policy 退避时，
// 其他实例在约 1 秒内也不再选它。共享哈希 holds 的字段为 账号|类别|实例，值为 截止毫秒|原因类别（R5 审查 R5-11）：
//   - 每个实例只写、只删自己的字段，读取时按（账号, 类别）取各实例中最晚的截止时刻；本实例缩短或提前解除只影响自己的字段；
//   - 本地状态变化后去抖 200 毫秒发布；写入成功后才记为已发布，失败下轮重试；每 30 秒全量重发一次，
//     Redis 重启丢数据后也能补上（R5-3）；进程重启后第一次拉取时清掉自己以前发布、本地已不存在的字段；
//   - 每秒拉取一次，忽略自己的字段（本地状态为准），合并为调度时的“共享限制”（Store.sharedHolds），
//     与本地状态分开保存，不写回账号，避免把其他实例的限制当成本实例的再发布出去；
//   - Redis 不可用时清空共享限制，只按本地状态（与单实例相同，R5-8）；
//   - 原因只存类别（cooldown、model_cooldown、bps_cooldown、usage_policy）或错误保护规则名，不存上游错误文本（R5-13）。
//
// 类别：cooldown（原生冷却）、model:<模型>（原生按模型冷却）、freeze（错误保护冻结）、
// bps（BPS 冷却）、bps_policy:*（BPS usage-policy 账号级退避）。
// 错误保护冻结另有原有的心跳通道（控制面汇总后随心跳下发 PeerFreeze，约 15 秒一轮），两者并存：
// 心跳通道服务没有 Redis 的部署；有 Redis 时这里传播更快，提前解除仍要等下一次心跳才清掉 PeerFreeze。
const (
	sharedHoldsInterval  = time.Second
	sharedHoldsDebounce  = 200 * time.Millisecond
	sharedHoldsRepublish = 30 * time.Second
	sharedHoldsTTL       = 24 * time.Hour
)

// accountHolds 是其他实例对一个账号的限制。
type accountHolds struct {
	cooldown  time.Time
	freeze    time.Time
	bps       time.Time
	model     map[string]time.Time
	bpsPolicy map[string]time.Time
}

func (h accountHolds) nativeBlocked(model string, now time.Time) bool {
	return h.cooldown.After(now) || h.freeze.After(now) || h.model[model].After(now)
}

func (h accountHolds) bpsBlocked(now time.Time) bool {
	return h.bps.After(now) || h.bpsPolicy[bpsPolicyAccountKey].After(now)
}

type sharedHold struct {
	until  time.Time
	reason string
}

type sharedHolds struct {
	shared    *sharedState
	store     *Store
	mu        sync.Mutex
	published map[string]time.Time
	lastFull  time.Time
	cleaned   bool
	wake      chan struct{}
}

func newSharedHolds(shared *sharedState, store *Store) *sharedHolds {
	if shared == nil {
		return nil
	}
	return &sharedHolds{shared: shared, store: store, published: map[string]time.Time{}, wake: make(chan struct{}, 1)}
}

// notify 在本地账号状态变化时调用，去抖后发布。
func (h *sharedHolds) notify() {
	if h == nil {
		return
	}
	select {
	case h.wake <- struct{}{}:
	default:
	}
}

func (h *sharedHolds) loop(ctx context.Context) {
	if h == nil {
		return
	}
	ticker := time.NewTicker(sharedHoldsInterval)
	defer ticker.Stop()
	h.sync(time.Now(), true)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			h.sync(time.Now(), true)
		case <-h.wake:
			// 去抖：短时间内的多次变化合并成一次发布（R5-7），拉取仍按每秒的定时
			select {
			case <-ctx.Done():
				return
			case <-time.After(sharedHoldsDebounce):
			}
			h.sync(time.Now(), false)
		}
	}
}

// localHolds 收集本实例当前生效的限制。
func (s *Store) localHolds(now time.Time) map[string]sharedHold {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := map[string]sharedHold{}
	add := func(account, kind string, until time.Time, reason string) {
		if until.After(now) {
			out[account+"|"+kind] = sharedHold{until: until, reason: reason}
		}
	}
	for id, account := range s.accounts {
		add(id, "cooldown", account.CooldownUntil, "cooldown")
		for model, until := range account.ModelCooldowns {
			add(id, "model:"+model, until, "model_cooldown")
		}
		if protectionFrozen(account, now) && account.Protection != nil {
			names := make([]string, 0, len(account.Protection.Rules))
			for _, rule := range account.Protection.Rules {
				names = append(names, rule.Name)
			}
			add(id, "freeze", account.Protection.FrozenUntil, strings.Join(names, ", "))
		}
		if account.BPS != nil {
			add(id, "bps", account.BPS.CooldownUntil, "bps_cooldown")
			for model, backoff := range account.BPS.PolicyBackoff {
				add(id, "bps_policy:"+model, backoff.Until, "usage_policy")
			}
		}
	}
	return out
}

// sync 发布本实例的限制变化；pull 为真时再拉取其他实例的限制。
func (h *sharedHolds) sync(now time.Time, pull bool) {
	if h == nil {
		return
	}
	if !h.shared.usable() {
		// 降级：不再按其他实例的旧限制屏蔽账号（R5-8）
		if h.store.sharedHoldCount() > 0 {
			h.store.applySharedHolds(nil)
		}
		return
	}
	key := h.shared.key("holds")
	self := "|" + h.shared.instance
	local := h.store.localHolds(now)
	h.mu.Lock()
	full := now.Sub(h.lastFull) >= sharedHoldsRepublish
	sets := map[string]string{}
	setUntil := map[string]time.Time{}
	var clears []string
	for field, hold := range local {
		if !full && h.published[field].Equal(hold.until) {
			continue
		}
		sets[field+self] = strconv.FormatInt(hold.until.UnixMilli(), 10) + "|" + strings.ReplaceAll(hold.reason, "|", "/")
		setUntil[field] = hold.until
	}
	for field := range h.published {
		if _, ok := local[field]; !ok {
			clears = append(clears, field)
		}
	}
	h.mu.Unlock()
	ctx, cancel := h.shared.opContext(context.Background())
	defer cancel()
	pipe := h.shared.client.Pipeline()
	if len(sets) > 0 {
		pipe.HSet(ctx, key, sets)
		pipe.PExpire(ctx, key, sharedHoldsTTL)
	}
	if len(clears) > 0 {
		fields := make([]string, len(clears))
		for i, field := range clears {
			fields[i] = field + self
		}
		pipe.HDel(ctx, key, fields...)
	}
	var all interface{ Val() map[string]string }
	if pull {
		all = pipe.HGetAll(ctx, key)
	}
	if len(sets) == 0 && len(clears) == 0 && !pull {
		return
	}
	_, err := pipe.Exec(ctx)
	h.shared.observe(err)
	if err != nil {
		// 未写成功：不记为已发布，下轮重试（R5-3）
		return
	}
	h.mu.Lock()
	for field, until := range setUntil {
		h.published[field] = until
	}
	for _, field := range clears {
		delete(h.published, field)
	}
	if full {
		h.lastFull = now
	}
	cleaned := h.cleaned
	if pull {
		h.cleaned = true
	}
	h.mu.Unlock()
	if !pull {
		return
	}
	remote := map[string]accountHolds{}
	var stale []string
	for field, value := range all.Val() {
		parts := strings.SplitN(field, "|", 3)
		if len(parts) != 3 {
			continue
		}
		account, kind, instance := parts[0], parts[1], parts[2]
		untilText, _, _ := strings.Cut(value, "|")
		ms, err := strconv.ParseInt(untilText, 10, 64)
		if err != nil {
			continue
		}
		until := time.UnixMilli(ms)
		if instance == h.shared.instance {
			// 进程重启后第一次拉取：清掉自己以前发布、本地已不存在的字段
			if _, ok := local[account+"|"+kind]; !ok && !cleaned {
				stale = append(stale, field)
			}
			continue
		}
		if !until.After(now) {
			stale = append(stale, field)
			continue
		}
		holds := remote[account]
		later := func(current time.Time) time.Time {
			if until.After(current) {
				return until
			}
			return current
		}
		switch {
		case kind == "cooldown":
			holds.cooldown = later(holds.cooldown)
		case kind == "freeze":
			holds.freeze = later(holds.freeze)
		case kind == "bps":
			holds.bps = later(holds.bps)
		case strings.HasPrefix(kind, "model:"):
			if holds.model == nil {
				holds.model = map[string]time.Time{}
			}
			model := strings.TrimPrefix(kind, "model:")
			holds.model[model] = later(holds.model[model])
		case strings.HasPrefix(kind, "bps_policy:"):
			if holds.bpsPolicy == nil {
				holds.bpsPolicy = map[string]time.Time{}
			}
			model := strings.TrimPrefix(kind, "bps_policy:")
			holds.bpsPolicy[model] = later(holds.bpsPolicy[model])
		default:
			continue
		}
		remote[account] = holds
	}
	h.store.applySharedHolds(remote)
	if len(stale) > 0 {
		h.shared.observe(h.shared.client.HDel(ctx, key, stale...).Err())
	}
}

// applySharedHolds 以最新拉取结果替换其他实例的限制；有账号解除时唤醒等待者。
func (s *Store) applySharedHolds(holds map[string]accountHolds) {
	s.mu.Lock()
	previous := s.sharedHolds
	s.sharedHolds = holds
	for account := range previous {
		if _, ok := holds[account]; !ok {
			s.wakeLocked(account, false)
		}
	}
	s.mu.Unlock()
}

// sharedHoldCount 是当前生效的其他实例限制条数（健康接口展示）。
func (s *Store) sharedHoldCount() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.sharedHolds)
}
