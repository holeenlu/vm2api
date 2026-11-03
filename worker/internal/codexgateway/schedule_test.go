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
