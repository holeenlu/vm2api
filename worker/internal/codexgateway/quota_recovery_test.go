package codexgateway

import (
	"path/filepath"
	"testing"
	"time"
)

func quotaSnapshot(used float64, reset time.Time) map[string]any {
	return map[string]any{"primary_window": map[string]any{"used_percent": used, "reset_at": reset.UTC().Format(time.RFC3339Nano)}}
}

// 额度耗尽后只凭一次未触顶的快照不解除：同窗口需连续两次确认，或 reset 滚动且新窗口低用量。
func TestQuotaExhaustionNeedsConfirmedRecovery(t *testing.T) {
	store, err := OpenStore(filepath.Join(t.TempDir(), "accounts.json"))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	reset := now.Add(2 * time.Hour)
	exhaust := func(id string) {
		t.Helper()
		if _, err := store.Upsert(Account{ID: id, Enabled: true, AccessToken: "t", Quota: quotaSnapshot(100, reset)}); err != nil {
			t.Fatal(err)
		}
		store.Dispose(id, "", upstreamFailure{Category: categoryUsageLimit, ResetsAt: reset}, now)
	}
	cooling := func(id string) bool {
		account, _ := store.Get(id)
		return quotaCooldown(account, time.Now())
	}

	exhaust("same")
	store.ReplaceQuota("same", quotaSnapshot(40, reset))
	if !cooling("same") {
		t.Fatal("a single non-capped snapshot released the exhausted account")
	}
	store.ReplaceQuota("same", quotaSnapshot(40, reset))
	if cooling("same") {
		t.Fatal("two consecutive non-capped snapshots should release the account")
	}

	exhaust("rolled")
	store.ReplaceQuota("rolled", quotaSnapshot(3, reset.Add(5*time.Hour)))
	if cooling("rolled") {
		t.Fatal("a rolled window with low usage should release immediately")
	}

	exhaust("sliding")
	store.ReplaceQuota("sliding", quotaSnapshot(60, reset.Add(5*time.Hour)))
	if !cooling("sliding") {
		t.Fatal("a rolled window with high usage is not trusted")
	}
	// reset 已滚动但用量高（滑动窗口）：基线 reset 不可信，同窗口确认也不成立，等记录的 reset 到期后再放行（CPR 同）
	store.ReplaceQuota("sliding", quotaSnapshot(70, reset.Add(5*time.Hour)))
	store.ReplaceQuota("sliding", quotaSnapshot(70, reset.Add(5*time.Hour)))
	if !cooling("sliding") {
		t.Fatal("a sliding window above 10% must stay locked until the recorded reset passes")
	}

	// 成功推理是权威证据：直接解除并清空恢复进度
	exhaust("success")
	store.ReplaceQuota("success", quotaSnapshot(40, reset))
	store.RecordSuccess("success")
	if account, _ := store.Get("success"); quotaCooldown(account, time.Now()) || account.QuotaRecovery != nil {
		t.Fatalf("success must clear the quota cooldown: %+v", account.QuotaRecovery)
	}
}

func TestQuotaRecoveryAllowsAfterRecordedResetsPass(t *testing.T) {
	exhaustedAt := time.Now().Add(-3 * time.Hour)
	past := time.Now().Add(-time.Minute)
	recovery := newQuotaRecovery(exhaustedAt, quotaSnapshot(100, past), past, true)
	if !recovery.allowedAfterReset(false, time.Now()) {
		t.Fatal("all recorded resets passed after the exhaustion; an allowed snapshot should release")
	}
	if recovery.allowedAfterReset(true, time.Now()) {
		t.Fatal("a still-exhausted snapshot must not release")
	}
	stale := newQuotaRecovery(time.Now(), quotaSnapshot(100, past), past, true)
	if stale.allowedAfterReset(false, time.Now()) {
		t.Fatal("a reset from before the exhaustion must not release")
	}
}
