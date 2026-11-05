package codexgateway

import (
	"bytes"
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
)

func newTestSharedState(t *testing.T, mr *miniredis.Miniredis, instance string) *sharedState {
	t.Helper()
	shared, err := newSharedState(Config{RedisURL: "redis://" + mr.Addr(), CredentialBundleKey: "bundle-key", InstanceID: instance})
	if err != nil || shared == nil {
		t.Fatalf("shared state: %v", err)
	}
	t.Cleanup(func() { _ = shared.Close() })
	return shared
}

// P5.1、P5.4：两个实例经 Redis 共享 BPS 协议状态；内容加密、按版本 CAS、空闲过期；Redis 停止时退回数据目录，恢复后回到共享
func TestSharedBPSStateIsSharedEncryptedAndDegradesToDisk(t *testing.T) {
	mr := miniredis.RunT(t)
	a := &sharedBPSState{shared: newTestSharedState(t, mr, "gw-a"), disk: newBPSDiskState(filepath.Join(t.TempDir(), "a.json"), nil)}
	b := &sharedBPSState{shared: newTestSharedState(t, mr, "gw-b"), disk: newBPSDiskState(filepath.Join(t.TempDir(), "b.json"), nil)}
	ctx := context.Background()
	secret := []byte(`{"tool":"secret replay payload"}`)
	if ok, err := a.SaveBPSState(ctx, "scope-1", "catalog", nil, secret); !ok || err != nil {
		t.Fatalf("save: %v %v", ok, err)
	}
	data, version, err := b.LoadBPSState(ctx, "scope-1", "catalog")
	if err != nil || !bytes.Equal(data, secret) || version != 1 {
		t.Fatalf("other instance load: %q v=%d err=%v", data, version, err)
	}
	for _, key := range mr.Keys() {
		if raw := mr.HGet(key, "d"); bytes.Contains([]byte(raw), []byte("secret replay")) {
			t.Fatal("protocol content must be encrypted in redis")
		}
		if ttl := mr.TTL(key); ttl <= 0 || ttl > bpsStateTTL {
			t.Fatalf("ttl=%v", ttl)
		}
	}
	// CAS：以旧版本写入被拒，以当前版本写入成功
	stale := uint64(0)
	if ok, _ := b.SaveBPSState(ctx, "scope-1", "catalog", &stale, []byte("x")); ok {
		t.Fatal("stale version must lose")
	}
	current := uint64(1)
	if ok, _ := b.SaveBPSState(ctx, "scope-1", "catalog", &current, []byte("y")); !ok {
		t.Fatal("current version must win")
	}
	if data, version, _ := a.LoadBPSState(ctx, "scope-1", "catalog"); string(data) != "y" || version != 2 {
		t.Fatalf("after cas: %q v=%d", data, version)
	}
	// Redis 停止：读写退回数据目录，状态报告降级
	mr.Close()
	if ok, err := a.SaveBPSState(ctx, "scope-2", "catalog", nil, []byte("local")); !ok || err != nil {
		t.Fatalf("fallback save: %v %v", ok, err)
	}
	if a.shared.usable() || a.shared.status()["healthy"] != false {
		t.Fatalf("status=%v", a.shared.status())
	}
	if data, _, _ := a.LoadBPSState(ctx, "scope-2", "catalog"); string(data) != "local" {
		t.Fatalf("fallback load: %q", data)
	}
	// 恢复：探活成功后回到共享
	if err := mr.Restart(); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for !a.shared.usable() && time.Now().Before(deadline) {
		a.shared.ping()
		time.Sleep(20 * time.Millisecond)
	}
	if !a.shared.usable() {
		t.Fatal("shared state must recover after redis is back")
	}
}

// P5.4：一个实例记录的历史来源，另一个实例能查到（来源锁定跨实例生效）
func TestRouteProvenanceIsSharedAcrossInstances(t *testing.T) {
	mr := miniredis.RunT(t)
	a := newRouteProvenance(filepath.Join(t.TempDir(), "a.json"), nil)
	a.shared = newTestSharedState(t, mr, "gw-a")
	b := newRouteProvenance(filepath.Join(t.TempDir(), "b.json"), nil)
	b.shared = newTestSharedState(t, mr, "gw-b")
	a.recordOwned("caller", routeNative, "acct-1", []string{"resp:r1", "enc:abc"})
	deadline := time.Now().Add(2 * time.Second)
	for len(mr.Keys()) < 2 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if routes := b.lookup("caller", []string{"resp:r1"}); !routes[routeNative] {
		t.Fatalf("routes=%v", routes)
	}
	if owner := b.owner("caller", []string{"enc:abc"}); owner != "acct-1" {
		t.Fatalf("owner=%q", owner)
	}
	if routes := b.lookup("other-caller", []string{"resp:r1"}); len(routes) != 0 {
		t.Fatalf("scopes must not leak: %v", routes)
	}
}

func TestSharedStateIsOffWithoutRedisURL(t *testing.T) {
	shared, err := newSharedState(Config{})
	if err != nil || shared != nil {
		t.Fatalf("shared=%v err=%v", shared, err)
	}
	if shared.usable() || shared.status()["backend"] != "local" {
		t.Fatal("nil shared state is local only")
	}
}

// P5.2：同一账号投影到两个实例，合计并发不超过账号上限；一侧归还后另一侧排队的请求取得租约
func TestSharedLeasesCapConcurrencyAcrossInstances(t *testing.T) {
	mr := miniredis.RunT(t)
	a := scheduleStore(t, limited("acct", 1))
	a.leases = newSharedLeases(newTestSharedState(t, mr, "gw-a"))
	b := scheduleStore(t, limited("acct", 1))
	b.leases = newSharedLeases(newTestSharedState(t, mr, "gw-b"))
	var deadline time.Time
	if _, err := a.Acquire(context.Background(), req(SchedulingPolicy{}), &deadline); err != nil {
		t.Fatalf("first instance: %v", err)
	}
	// 另一实例不排队时直接拿不到
	noWait := req(SchedulingPolicy{})
	noWait.NoWait = true
	var none time.Time
	if _, err := b.Acquire(context.Background(), noWait, &none); err == nil {
		t.Fatal("the second instance must not exceed the account limit")
	}
	if account, _ := b.Get("acct"); account.InFlight != 0 {
		t.Fatalf("the denied local lease must be returned: %d", account.InFlight)
	}
	// 排队等待：第一个实例归还后取得
	got := make(chan error, 1)
	go func() {
		var dl time.Time
		_, err := b.Acquire(context.Background(), req(SchedulingPolicy{WaitTimeoutMS: 5000}), &dl)
		got <- err
	}()
	time.Sleep(300 * time.Millisecond)
	a.ReleaseLease("acct", false, "")
	select {
	case err := <-got:
		if err != nil {
			t.Fatalf("queued acquire: %v", err)
		}
	case <-time.After(4 * time.Second):
		t.Fatal("the queued request never got the shared lease")
	}
	if held := b.leases.status()["held"]; held != 1 {
		t.Fatalf("held=%v", held)
	}
	// Redis 停止：只按本地计数，不阻塞
	mr.Close()
	b.leases.shared.ping()
	b.ReleaseLease("acct", false, "")
	var dl time.Time
	if _, err := a.Acquire(context.Background(), noWait, &dl); err != nil {
		t.Fatalf("degraded acquire: %v", err)
	}
}

// P5.3：一个实例上的冷却与 BPS 退避，另一个实例拉取后立即不再选该账号；提前解除后恢复；自己发布的条目不影响自己
func TestSharedHoldsPropagateCooldownsAcrossInstances(t *testing.T) {
	mr := miniredis.RunT(t)
	a := scheduleStore(t, limited("acct", 4))
	a.holds = newSharedHolds(newTestSharedState(t, mr, "gw-a"), a)
	b := scheduleStore(t, limited("acct", 4))
	b.holds = newSharedHolds(newTestSharedState(t, mr, "gw-b"), b)
	now := time.Now()
	a.mu.Lock()
	account := a.accounts["acct"]
	account.CooldownUntil = now.Add(time.Minute)
	account.LastError = "rate_limit_exceeded"
	a.accounts["acct"] = account
	a.mu.Unlock()
	a.holds.sync(now, true)
	b.holds.sync(now, true)
	noWait := req(SchedulingPolicy{})
	noWait.NoWait = true
	var dl time.Time
	if _, err := b.Acquire(context.Background(), noWait, &dl); err == nil {
		t.Fatal("a cooldown on another instance must block selection here")
	}
	if len(a.sharedHolds) != 0 {
		t.Fatalf("an instance must ignore its own published holds: %v", a.sharedHolds)
	}
	// 提前解除：删除自己发布的字段，另一实例下一次拉取后恢复
	a.mu.Lock()
	account = a.accounts["acct"]
	account.CooldownUntil = time.Time{}
	a.accounts["acct"] = account
	a.mu.Unlock()
	a.holds.sync(now, true)
	b.holds.sync(now, true)
	if _, err := b.Acquire(context.Background(), noWait, &dl); err != nil {
		t.Fatalf("cleared cooldown must unblock: %v", err)
	}
	// BPS usage-policy 退避按模型共享
	a.mu.Lock()
	account = a.accounts["acct"]
	account.BPS = &BPSGrant{PolicyBackoff: map[string]bpsBackoff{"m": {Until: now.Add(time.Minute), Strikes: 1}}}
	a.accounts["acct"] = account
	a.mu.Unlock()
	a.holds.sync(now, true)
	b.holds.sync(now, true)
	if held := b.sharedHolds["acct"]; !held.bpsBlocked("m", now) || held.bpsBlocked("other", now) || held.nativeBlocked("m", now) {
		t.Fatalf("holds=%+v", held)
	}
}

// R5-1：Redis 不可用时准入的无令牌租约，归还时不会删掉其他请求的令牌；恢复后续期为它补登记
func TestSharedLeasesTokenlessReleaseNeverStealsTokens(t *testing.T) {
	mr := miniredis.RunT(t)
	a := scheduleStore(t, limited("acct", 2))
	a.leases = newSharedLeases(newTestSharedState(t, mr, "gw-a"))
	b := scheduleStore(t, limited("acct", 2))
	b.leases = newSharedLeases(newTestSharedState(t, mr, "gw-b"))
	var dl time.Time
	if _, err := a.Acquire(context.Background(), req(SchedulingPolicy{}), &dl); err != nil {
		t.Fatal(err)
	}
	// Redis 短暂不可用：第二个请求无令牌准入
	a.leases.shared.healthy.Store(false)
	if _, err := a.Acquire(context.Background(), req(SchedulingPolicy{}), &dl); err != nil {
		t.Fatal(err)
	}
	if status := a.leases.status(); status["held"] != 1 || status["untokened"] != 1 {
		t.Fatalf("status=%v", status)
	}
	a.leases.shared.healthy.Store(true)
	a.ReleaseLease("acct", false, "")
	time.Sleep(50 * time.Millisecond)
	members, _ := mr.ZMembers(a.leases.key(queueKey{"acct", false}))
	if len(members) != 1 {
		t.Fatalf("the tokenless release must keep the other request's token: %v", members)
	}
	noWait := req(SchedulingPolicy{})
	noWait.NoWait = true
	if _, err := b.Acquire(context.Background(), noWait, &dl); err != nil {
		t.Fatalf("one slot is free: %v", err)
	}
	if _, err := b.Acquire(context.Background(), noWait, &dl); err == nil {
		t.Fatal("the combined limit (2) must hold")
	}
	// 恢复后续期：无令牌租约补登记
	a.leases.shared.healthy.Store(false)
	if _, err := a.Acquire(context.Background(), req(SchedulingPolicy{WaitTimeoutMS: 1}), &dl); err != nil {
		t.Fatal(err)
	}
	a.leases.shared.healthy.Store(true)
	a.leases.renew()
	if status := a.leases.status(); status["untokened"] != 0 || status["held"] != 2 {
		t.Fatalf("tokenless leases must be registered on recovery: %v", status)
	}
}

// R5-2：共享租约被拒时撤回准入副作用（RPM 样本、会话绑定），排队的请求在另一实例归还后照常取得
func TestRejectedSharedLeaseRollsBackAdmission(t *testing.T) {
	mr := miniredis.RunT(t)
	account := limited("acct", 1)
	account.MaxRPM = 3
	a := scheduleStore(t, account)
	a.leases = newSharedLeases(newTestSharedState(t, mr, "gw-a"))
	b := scheduleStore(t, account)
	b.leases = newSharedLeases(newTestSharedState(t, mr, "gw-b"))
	var dl time.Time
	if _, err := a.Acquire(context.Background(), req(SchedulingPolicy{}), &dl); err != nil {
		t.Fatal(err)
	}
	got := make(chan error, 1)
	go func() {
		var deadline time.Time
		_, err := b.Acquire(context.Background(), req(SchedulingPolicy{WaitTimeoutMS: 4000}), &deadline)
		got <- err
	}()
	time.Sleep(1500 * time.Millisecond)
	b.mu.RLock()
	samples := len(b.rpm["acct"])
	b.mu.RUnlock()
	if samples != 0 {
		t.Fatalf("rejected admissions must not leave RPM samples: %d", samples)
	}
	a.ReleaseLease("acct", false, "")
	select {
	case err := <-got:
		if err != nil {
			t.Fatalf("queued acquire after release: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the queued request never got the lease")
	}
	b.mu.RLock()
	samples = len(b.rpm["acct"])
	b.mu.RUnlock()
	if samples != 1 {
		t.Fatalf("exactly one RPM sample for the admitted request: %d", samples)
	}
}

// R5-6：续期不会把已归还的令牌加回去；实例失联（不再续期）后 30 秒租约到期，其他实例可以取得
func TestSharedLeaseRenewAndExpiryAfterInstanceLoss(t *testing.T) {
	mr := miniredis.RunT(t)
	a := scheduleStore(t, limited("acct", 1))
	a.leases = newSharedLeases(newTestSharedState(t, mr, "gw-a"))
	b := scheduleStore(t, limited("acct", 1))
	b.leases = newSharedLeases(newTestSharedState(t, mr, "gw-b"))
	var dl time.Time
	if _, err := a.Acquire(context.Background(), req(SchedulingPolicy{}), &dl); err != nil {
		t.Fatal(err)
	}
	key := a.leases.key(queueKey{"acct", false})
	a.ReleaseLease("acct", false, "")
	time.Sleep(50 * time.Millisecond)
	a.leases.renew()
	if members, _ := mr.ZMembers(key); len(members) != 0 {
		t.Fatalf("renew must not re-add a released token: %v", members)
	}
	// 实例失联：a 取得后既不续期也不归还
	if _, err := a.Acquire(context.Background(), req(SchedulingPolicy{}), &dl); err != nil {
		t.Fatal(err)
	}
	noWait := req(SchedulingPolicy{})
	noWait.NoWait = true
	if _, err := b.Acquire(context.Background(), noWait, &dl); err == nil {
		t.Fatal("the lease is still held")
	}
	// 失联实例 30 秒没有续期：令牌分数已过期（租约到期按 Worker 时钟比较分数）
	lost := a.leases.held[queueKey{"acct", false}][0]
	_, _ = mr.ZAdd(key, float64(time.Now().Add(-time.Second).UnixMilli()), lost)
	b.mu.Lock()
	b.remoteFull = map[queueKey]time.Time{}
	b.mu.Unlock()
	if _, err := b.Acquire(context.Background(), noWait, &dl); err != nil {
		t.Fatalf("an expired lease of a lost instance must not block: %v", err)
	}
}

// R5-3、R5-8：发布失败（Redis 暂时出错）下轮重试；Redis 重启丢数据后 30 秒内全量重发；Redis 不可用时清空共享限制
func TestSharedHoldsRetryAfterErrorsAndRepublishAfterDataLoss(t *testing.T) {
	mr := miniredis.RunT(t)
	a := scheduleStore(t, limited("acct", 4))
	a.holds = newSharedHolds(newTestSharedState(t, mr, "gw-a"), a)
	b := scheduleStore(t, limited("acct", 4))
	b.holds = newSharedHolds(newTestSharedState(t, mr, "gw-b"), b)
	now := time.Now()
	a.holds.sync(now, true)
	a.mu.Lock()
	account := a.accounts["acct"]
	account.CooldownUntil = now.Add(time.Hour)
	a.accounts["acct"] = account
	a.mu.Unlock()
	mr.SetError("LOADING Redis is loading the dataset in memory")
	a.holds.sync(now, false)
	if a.holds.shared.usable() {
		t.Fatal("LOADING means redis cannot take writes and must count as unavailable")
	}
	mr.SetError("")
	a.holds.shared.ping()
	a.holds.sync(now, false)
	b.holds.sync(now, true)
	if !b.sharedHolds["acct"].nativeBlocked("m", now) {
		t.Fatal("a failed publish must be retried")
	}
	// Redis 重启丢数据：30 秒内全量重发
	mr.FlushAll()
	a.holds.sync(now.Add(sharedHoldsRepublish+time.Second), true)
	b.holds.sync(now, true)
	if !b.sharedHolds["acct"].nativeBlocked("m", now) {
		t.Fatal("holds must be republished after redis lost its data")
	}
	// 降级：不再按旧的远端限制屏蔽
	b.holds.shared.healthy.Store(false)
	b.holds.sync(now, true)
	if b.sharedHoldCount() != 0 {
		t.Fatal("remote holds must be dropped while redis is unavailable")
	}
}

// R5-13：地址格式错误时，错误信息不带地址与密码
func TestSharedStateURLErrorsDoNotLeakTheURL(t *testing.T) {
	_, err := newSharedState(Config{RedisURL: "http://user:s3cret@host:6379"})
	if err == nil || strings.Contains(err.Error(), "s3cret") {
		t.Fatalf("err=%v", err)
	}
}

// R5 复核 N2：Redis 查询失败不当作“查不到”，不写负缓存，恢复后能查到
func TestRouteProvenanceLookupErrorsAreNotCachedAsMisses(t *testing.T) {
	mr := miniredis.RunT(t)
	a := newRouteProvenance(filepath.Join(t.TempDir(), "a.json"), nil)
	a.shared = newTestSharedState(t, mr, "gw-a")
	b := newRouteProvenance(filepath.Join(t.TempDir(), "b.json"), nil)
	b.shared = newTestSharedState(t, mr, "gw-b")
	a.recordOwned("caller", routeBPS, "", []string{"resp:x"})
	mr.SetError("LOADING Redis is loading the dataset in memory")
	if routes := b.lookup("caller", []string{"resp:x"}); len(routes) != 0 {
		t.Fatalf("routes=%v", routes)
	}
	if len(b.misses) != 0 {
		t.Fatalf("a failed lookup must not be cached as a miss: %v", b.misses)
	}
	mr.SetError("")
	b.shared.ping()
	if routes := b.lookup("caller", []string{"resp:x"}); !routes[routeBPS] {
		t.Fatalf("after recovery the record must be found: %v", routes)
	}
}
