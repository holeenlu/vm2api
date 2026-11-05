package codexgateway

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

func scheduleStore(t *testing.T, accounts ...Account) *Store {
	t.Helper()
	store, err := OpenStore(t.TempDir() + "/accounts.json")
	if err != nil {
		t.Fatal(err)
	}
	for _, account := range accounts {
		if _, err := store.Upsert(account); err != nil {
			t.Fatal(err)
		}
	}
	return store
}

func limited(id string, concurrency int) Account {
	return Account{ID: id, Enabled: true, AccessToken: "t", Groups: []string{"1"}, Weight: 1, MaxConcurrency: concurrency}
}

func req(policy SchedulingPolicy) selectRequest {
	return selectRequest{Scope: Scope{GroupIDs: []int64{1}}, Model: "m", Policy: policy}
}

func TestAcquireWaitsFIFOForCapacity(t *testing.T) {
	store := scheduleStore(t, limited("a", 1))
	var deadline time.Time
	first, err := store.Acquire(context.Background(), req(SchedulingPolicy{}), &deadline)
	if err != nil || first.ID != "a" {
		t.Fatalf("first=%v err=%v", first.ID, err)
	}
	var order []int
	var mu sync.Mutex
	var wg sync.WaitGroup
	for i := range 3 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var dl time.Time
			if _, err := store.Acquire(context.Background(), req(SchedulingPolicy{WaitTimeoutMS: 5000}), &dl); err != nil {
				t.Errorf("waiter %d: %v", i, err)
				return
			}
			mu.Lock()
			order = append(order, i)
			mu.Unlock()
			time.Sleep(20 * time.Millisecond)
			store.ReleaseLease("a", false, "")
		}()
		time.Sleep(30 * time.Millisecond) // 保证入队顺序
	}
	store.ReleaseLease("a", false, "")
	wg.Wait()
	if len(order) != 3 || order[0] != 0 || order[1] != 1 || order[2] != 2 {
		t.Fatalf("FIFO order=%v", order)
	}
}

func TestAcquireTimeoutAndQueueFull(t *testing.T) {
	store := scheduleStore(t, limited("a", 1))
	store.SetQueueLimits(-1, 1, 0)
	var dl time.Time
	if _, err := store.Acquire(context.Background(), req(SchedulingPolicy{}), &dl); err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		var dl time.Time
		close(started)
		_, err := store.Acquire(context.Background(), req(SchedulingPolicy{WaitTimeoutMS: 300}), &dl)
		done <- err
	}()
	<-started
	time.Sleep(50 * time.Millisecond)
	var dl2 time.Time
	if _, err := store.Acquire(context.Background(), req(SchedulingPolicy{WaitTimeoutMS: 300}), &dl2); !errors.Is(err, ErrQueueFull) {
		t.Fatalf("second waiter err=%v, want queue full", err)
	}
	if err := <-done; !errors.Is(err, ErrQueueTimeout) {
		t.Fatalf("first waiter err=%v, want timeout", err)
	}
	store.mu.Lock()
	waiting := store.sched.waiting
	store.mu.Unlock()
	if waiting != 0 {
		t.Fatalf("waiting count leaked: %d", waiting)
	}
}

func TestAcquireCancellationReleasesQueuePosition(t *testing.T) {
	store := scheduleStore(t, limited("a", 1))
	var dl time.Time
	_, _ = store.Acquire(context.Background(), req(SchedulingPolicy{}), &dl)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		var dl time.Time
		_, err := store.Acquire(ctx, req(SchedulingPolicy{WaitTimeoutMS: 5000}), &dl)
		done <- err
	}()
	time.Sleep(50 * time.Millisecond)
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("err=%v", err)
	}
	store.ReleaseLease("a", false, "")
	var dl3 time.Time
	if _, err := store.Acquire(context.Background(), req(SchedulingPolicy{WaitTimeoutMS: 100}), &dl3); err != nil {
		t.Fatalf("cancelled waiter kept its slot: %v", err)
	}
}

func TestGuardianPoolIsIndependent(t *testing.T) {
	store := scheduleStore(t, limited("a", 1))
	store.SetQueueLimits(2, -1, 0)
	var dl time.Time
	if _, err := store.Acquire(context.Background(), req(SchedulingPolicy{}), &dl); err != nil {
		t.Fatal(err)
	}
	guardian := req(SchedulingPolicy{WaitTimeoutMS: 100})
	guardian.Guardian = true
	for i := range 2 {
		var gdl time.Time
		if _, err := store.Acquire(context.Background(), guardian, &gdl); err != nil {
			t.Fatalf("guardian %d blocked by the normal pool: %v", i, err)
		}
	}
	var gdl time.Time
	if _, err := store.Acquire(context.Background(), guardian, &gdl); !errors.Is(err, ErrQueueTimeout) {
		t.Fatalf("third guardian err=%v, want timeout at R=2", err)
	}
	account, _ := store.Get("a")
	if account.InFlight != 1 || account.GuardianInFlight != 2 {
		t.Fatalf("in-flight normal=%d guardian=%d", account.InFlight, account.GuardianInFlight)
	}
}

func TestSessionAffinityModes(t *testing.T) {
	session := func(policy SchedulingPolicy) selectRequest {
		r := req(policy)
		r.Scope.SessionID = "sess"
		return r
	}
	// preferred：主账号满载时临时分流，但不改写绑定
	store := scheduleStore(t, limited("a", 1), limited("b", 1))
	var dl time.Time
	first, _ := store.Acquire(context.Background(), session(SchedulingPolicy{Affinity: "preferred"}), &dl)
	second, err := store.Acquire(context.Background(), session(SchedulingPolicy{Affinity: "preferred"}), &dl)
	if err != nil || second.ID == first.ID {
		t.Fatalf("preferred should divert: first=%s second=%s err=%v", first.ID, second.ID, err)
	}
	store.ReleaseLease(first.ID, false, "")
	store.ReleaseLease(second.ID, false, "")
	third, _ := store.Acquire(context.Background(), session(SchedulingPolicy{Affinity: "preferred"}), &dl)
	if third.ID != first.ID {
		t.Fatalf("preferred binding changed: %s -> %s", first.ID, third.ID)
	}
	store.ReleaseLease(third.ID, false, "")

	// strict：主账号满载时排队等待，不分流
	strict := scheduleStore(t, limited("a", 1), limited("b", 1))
	var sdl time.Time
	owner, _ := strict.Acquire(context.Background(), session(SchedulingPolicy{Affinity: "strict"}), &sdl)
	var sdl2 time.Time
	if _, err := strict.Acquire(context.Background(), session(SchedulingPolicy{Affinity: "strict", WaitTimeoutMS: 100}), &sdl2); !errors.Is(err, ErrQueueTimeout) {
		t.Fatalf("strict should wait for %s, got %v", owner.ID, err)
	}

	// relaxed：不使用绑定
	relaxed := scheduleStore(t, limited("a", 1), limited("b", 1))
	var rdl time.Time
	r1, _ := relaxed.Acquire(context.Background(), session(SchedulingPolicy{Affinity: "relaxed", Strategy: "round_robin"}), &rdl)
	relaxed.ReleaseLease(r1.ID, false, "")
	r2, _ := relaxed.Acquire(context.Background(), session(SchedulingPolicy{Affinity: "relaxed", Strategy: "round_robin"}), &rdl)
	if r1.ID == r2.ID {
		t.Fatalf("relaxed round robin reused %s", r1.ID)
	}
}

func TestSmartPrefersHealthyAndHigherWeightTier(t *testing.T) {
	store := scheduleStore(t, limited("a", 4), limited("b", 4))
	for range 10 {
		store.RecordFeedback("a", feedbackCapacityRejected, 0)
	}
	for range 4 {
		var dl time.Time
		account, err := store.Acquire(context.Background(), req(SchedulingPolicy{}), &dl)
		if err != nil {
			t.Fatal(err)
		}
		if account.ID != "b" {
			t.Fatalf("smart picked unhealthy account %s", account.ID)
		}
		store.ReleaseLease(account.ID, false, "")
	}
	heavy := limited("c", 4)
	heavy.Weight = 5
	weighted := scheduleStore(t, limited("a", 4), heavy)
	var dl time.Time
	if account, _ := weighted.Acquire(context.Background(), req(SchedulingPolicy{}), &dl); account.ID != "c" {
		t.Fatalf("highest weight tier not preferred: %s", account.ID)
	}
	if got := (SchedulingPolicy{}).scoreTolerance(); got <= 0 {
		t.Fatalf("tolerance=%v", got)
	}
}

func TestFeedbackOnlyCountsScoreFailures(t *testing.T) {
	if _, ok := feedbackForFailure(upstreamFailure{Category: categoryCredentialExpired}); ok {
		t.Fatal("credential failures must not affect the health score")
	}
	if kind, ok := feedbackForFailure(upstreamFailure{Category: categoryCapacity}); !ok || kind != feedbackCapacityRejected {
		t.Fatal("capacity rejection must use the capacity alpha")
	}
	if _, ok := feedbackForFailure(upstreamFailure{Category: categoryUnavailable, Code: "server_error"}); !ok {
		t.Fatal("server_error must count")
	}
	// 裸 429（没有闭集内的 code/type）不计入健康分；只有 type 时按 type 判定
	if _, ok := feedbackForFailure(upstreamFailure{Category: categoryRateLimited, Status: 429}); ok {
		t.Fatal("a bare 429 must not affect the health score")
	}
	if _, ok := feedbackForFailure(upstreamFailure{Category: categoryRateLimited, Type: "rate_limit_error"}); !ok {
		t.Fatal("rate_limit_error type must count")
	}
}

// 调度细节对齐 CPR：排队关闭返回容量不可用；Retry-After: 0 不冷却；Cloudflare 挑战只让 Cookie 过期、不冷却账号；
// 建连重试 500ms 起翻倍并带 ±20% 抖动；同队长时权重高者优先排队。
func TestSchedulingDetailsAlignWithCPR(t *testing.T) {
	store := scheduleStore(t, limited("a", 1))
	store.sched.maxWaitingPerAccount = 0
	var dl time.Time
	if _, err := store.Acquire(context.Background(), req(SchedulingPolicy{}), &dl); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Acquire(context.Background(), req(SchedulingPolicy{}), &dl); !errors.Is(err, ErrAccountCapacityUnavailable) {
		t.Fatalf("queue disabled should be capacity unavailable, got %v", err)
	}

	now := time.Now()
	acct := limited("b", 1)
	acct.Cookies = []StoredCookie{{Name: "cf_clearance", Value: "v", Domain: "chatgpt.com", Path: "/"}}
	store = scheduleStore(t, acct)
	store.Dispose("b", "", upstreamFailure{Category: categoryRateLimited, HasRetryAfter: true}, now)
	if saved, _ := store.Get("b"); saved.CooldownUntil.After(now) {
		t.Fatalf("Retry-After: 0 must not cool the account: %v", saved.CooldownUntil)
	}
	store.Dispose("b", "", upstreamFailure{Category: categoryCloudflareChallenge}, now)
	saved, _ := store.Get("b")
	if saved.CooldownUntil.After(now) || len(saved.Cookies) != 1 || !saved.Cookies[0].ExpiresAt.Equal(now.Add(cloudflareChallengeBackoff[0])) {
		t.Fatalf("challenge must expire cookies without cooling the account: %+v", saved)
	}
	store.Dispose("b", "", upstreamFailure{Category: categoryCloudflarePathBlocked}, now)
	if saved, _ := store.Get("b"); len(saved.Cookies) != 0 {
		t.Fatal("a blocked path must clear the account cookies")
	}

	for retries, base := range []time.Duration{500, 1000, 2000} {
		delay := connectRetryDelay(retries, "req_1")
		if delay < base*time.Millisecond*80/100 || delay > base*time.Millisecond*120/100 || delay != connectRetryDelay(retries, "req_1") {
			t.Fatalf("retry %d delay %v", retries, delay)
		}
	}

	heavy, light := limited("heavy", 1), limited("light", 1)
	heavy.Weight = 5
	store = scheduleStore(t, heavy, light)
	if got := store.pickQueue([]Account{light, heavy}, req(SchedulingPolicy{}), now); got != "heavy" {
		t.Fatalf("equal queues should prefer the higher weight, got %s", got)
	}
}

func TestDeniedModelsExcludeAccount(t *testing.T) {
	denied := limited("denied", 1)
	denied.DeniedModels = []string{"m"}
	store := scheduleStore(t, denied, limited("ok", 1))
	var deadline time.Time
	got, err := store.Acquire(context.Background(), req(SchedulingPolicy{}), &deadline)
	if err != nil || got.ID != "ok" {
		t.Fatalf("got=%v err=%v", got.ID, err)
	}
}

// 对齐 CPR 的亲和细节：会话绑定按调用方范围隔离；preferred 主账号越过权重层；strict 下后代线程只跟随
// 根会话账号；strict 绑定迁移后旧账号的续接要求客户端重放；cyber_policy 排除全部候选时返回专用错误。
func TestAffinityAlignsWithCPR(t *testing.T) {
	session := func(policy SchedulingPolicy, scope string) selectRequest {
		r := req(policy)
		r.Scope.SessionID = "sess"
		r.ClientScope = scope
		return r
	}
	heavy := limited("heavy", 4)
	heavy.Weight = 5
	light := limited("light", 4)

	// preferred：已绑定的低权重主账号仍优先于更高权重层
	store := scheduleStore(t, light)
	var dl time.Time
	first, _ := store.Acquire(context.Background(), session(SchedulingPolicy{Affinity: "preferred"}, "k1"), &dl)
	store.ReleaseLease(first.ID, false, "")
	if _, err := store.Upsert(heavy); err != nil {
		t.Fatal(err)
	}
	if again, _ := store.Acquire(context.Background(), session(SchedulingPolicy{Affinity: "preferred"}, "k1"), &dl); again.ID != "light" {
		t.Fatalf("preferred primary must override the weight tier, got %s", again.ID)
	}
	// 另一个调用方范围的同名会话不继承该绑定
	if other, _ := store.Acquire(context.Background(), session(SchedulingPolicy{Affinity: "preferred"}, "k2"), &dl); other.ID != "heavy" {
		t.Fatalf("session bindings must be isolated per client scope, got %s", other.ID)
	}

	// strict + 后代线程：根账号满载时等待它，不分流到其他账号
	strict := scheduleStore(t, limited("a", 1), limited("b", 1))
	var sdl time.Time
	root, _ := strict.Acquire(context.Background(), session(SchedulingPolicy{Affinity: "strict"}, "k1"), &sdl)
	child := session(SchedulingPolicy{Affinity: "strict", WaitTimeoutMS: 100}, "k1")
	child.FollowOnly = true
	var cdl time.Time
	if _, err := strict.Acquire(context.Background(), child, &cdl); !errors.Is(err, ErrQueueTimeout) {
		t.Fatalf("a descendant thread must wait for %s, got %v", root.ID, err)
	}
	strict.ReleaseLease(root.ID, false, "")
	var cdl2 time.Time
	if got, err := strict.Acquire(context.Background(), child, &cdl2); err != nil || got.ID != root.ID {
		t.Fatalf("descendant should follow %s: got %s err=%v", root.ID, got.ID, err)
	}

	// strict：会话已迁到 b，钉在 a 的续接要求客户端重放
	continuation := session(SchedulingPolicy{Affinity: "strict"}, "k1")
	continuation.Continuation = true
	other := "a"
	if root.ID == "a" {
		other = "b"
	}
	strict.mu.Lock()
	strict.sched.bindings[continuation.sessionKey()] = sessionBinding{account: other, expires: time.Now().Add(time.Hour)}
	strict.mu.Unlock()
	continuation.Scope.RuntimeAccountID = root.ID
	var kdl time.Time
	if _, err := strict.Acquire(context.Background(), continuation, &kdl); !errors.Is(err, ErrContinuationOwnerChanged) {
		t.Fatalf("a continuation on the old owner must require replay, got %v", err)
	}

	// cyber_policy：会话排除全部候选时返回专用错误，排除部分时选其余账号
	cyber := scheduleStore(t, limited("a", 2), limited("b", 2))
	excluded := req(SchedulingPolicy{})
	excluded.SessionExclude = map[string]bool{"a": true}
	var ydl time.Time
	if got, err := cyber.Acquire(context.Background(), excluded, &ydl); err != nil || got.ID != "b" {
		t.Fatalf("cyber-excluded account must be skipped: got %s err=%v", got.ID, err)
	}
	excluded.SessionExclude["b"] = true
	if _, err := cyber.Acquire(context.Background(), excluded, &ydl); !errors.Is(err, ErrSessionPolicyRestricted) {
		t.Fatalf("all candidates excluded should be a session policy restriction, got %v", err)
	}
}

func TestFollowsSessionDetectsDescendants(t *testing.T) {
	cases := []struct {
		headers map[string]string
		body    map[string]any
		want    bool
	}{
		{map[string]string{"session-id": "s", "thread-id": "t"}, nil, true},
		{map[string]string{"session-id": "s", "thread-id": "s"}, nil, false},
		{map[string]string{"x-codex-turn-metadata": `{"session_id":"s","thread_id":"child"}`}, nil, true},
		{nil, map[string]any{"subagent_kind": "review"}, true},
		{map[string]string{"session-id": "s"}, nil, false},
	}
	for i, tc := range cases {
		if got := followsSession(tc.headers, tc.body); got != tc.want {
			t.Errorf("case %d: got %v want %v", i, got, tc.want)
		}
	}
}
