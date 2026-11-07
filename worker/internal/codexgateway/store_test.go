package codexgateway

import (
	"os"
	"strings"
	"testing"
	"time"
)

func TestRecoverClearsCooldownWithoutResumingPausedAccount(t *testing.T) {
	store, err := OpenStore(t.TempDir() + "/accounts.json")
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.Upsert(Account{ID: "paused", Enabled: false, Paused: true, CooldownUntil: time.Now().Add(time.Hour), LastError: "upstream_capacity"})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Recover("paused"); err != nil {
		t.Fatal(err)
	}
	account, _ := store.Get("paused")
	if account.Enabled || !account.Paused || !account.CooldownUntil.IsZero() || account.LastError != "" {
		t.Fatalf("unexpected recovered account: %+v", publicAccount(account))
	}
}

// 导入凭据（Patch 换入新令牌）同样开启新代次：旧凭据的终态、刷新失败诊断与 Cookie 都清除
func TestPatchNewCredentialResetsStaleCredentialRuntime(t *testing.T) {
	store, err := OpenStore(t.TempDir() + "/accounts.json")
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.Upsert(Account{ID: "acct", Enabled: true, RefreshToken: "old", CredentialRevision: 2, CredentialState: "expired",
		LastRefreshFailure: &RefreshFailure{Operation: "refresh", Code: "refresh_token_expired"},
		Cookies:            []StoredCookie{{Name: "__cf_bm", Value: "old", Domain: "chatgpt.com", Path: "/"}}})
	if err != nil {
		t.Fatal(err)
	}
	account, err := store.Patch("acct", map[string]any{"access_token": "new", "refresh_token": "new"})
	if err != nil {
		t.Fatal(err)
	}
	if account.CredentialRevision != 3 || account.CredentialState != "" || account.LastRefreshFailure != nil || account.Cookies != nil {
		t.Fatalf("new credential kept stale runtime: %+v", account)
	}
}

func TestStoreCASAndRPMAdmission(t *testing.T) {
	store, err := OpenStore(t.TempDir() + "/accounts.json")
	if err != nil {
		t.Fatal(err)
	}
	account := Account{ID: "acct", Enabled: true, MaxConcurrency: 2, MaxRPM: 1, Groups: []string{"1"}, Models: []string{"gpt-test"}, CredentialRevision: 1}
	if _, err := store.Upsert(account); err != nil {
		t.Fatal(err)
	}
	if _, err := store.UpsertCAS(Account{ID: "acct", Enabled: true, CredentialRevision: 2}, 0); err == nil || !strings.Contains(err.Error(), "credential revision conflict") {
		t.Fatalf("expected CAS conflict, got %v", err)
	}
	if _, err := store.Select(Scope{GroupIDs: []int64{1}, Model: "gpt-test"}, "gpt-test", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Select(Scope{GroupIDs: []int64{1}, Model: "gpt-test"}, "gpt-test", nil); err == nil {
		t.Fatal("expected RPM admission to reject the second request")
	}
}

func TestSealedStoreEncryptsCredentialsAndMigratesPlaintext(t *testing.T) {
	path := t.TempDir() + "/accounts.json"
	plain, err := OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := plain.Upsert(Account{ID: "acct", Enabled: true, AccessToken: "tok-secret", RefreshToken: "refresh-secret", ProxyURL: "socks5h://user:pass@proxy:1"}); err != nil {
		t.Fatal(err)
	}
	// 已有明文账号库在打开时改写为密文
	sealed, err := OpenSealedStore(path, "bundle-key")
	if err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(path)
	if !strings.HasPrefix(string(data), accountStoreSealPrefix) || strings.Contains(string(data), "tok-secret") || strings.Contains(string(data), "proxy") {
		t.Fatalf("account store is not sealed: %q", data)
	}
	if account, ok := sealed.Get("acct"); !ok || account.AccessToken != "tok-secret" {
		t.Fatalf("migrated account=%+v", account)
	}
	reopened, err := OpenSealedStore(path, "bundle-key")
	if err != nil {
		t.Fatal(err)
	}
	if account, ok := reopened.Get("acct"); !ok || account.RefreshToken != "refresh-secret" {
		t.Fatalf("reopened account=%+v", account)
	}
	// 缺少或错误的密钥拒绝启动，不能以空账号库覆盖原有凭据
	if _, err := OpenStore(path); err == nil {
		t.Fatal("expected sealed store to require the key")
	}
	if _, err := OpenSealedStore(path, "other-key"); err == nil {
		t.Fatal("expected wrong key to be rejected")
	}
	// 回滚：改回明文后旧版 Worker 可直接读取
	if err := UnsealAccountStore(path, "bundle-key"); err != nil {
		t.Fatal(err)
	}
	if restored, err := OpenStore(path); err != nil {
		t.Fatal(err)
	} else if account, _ := restored.Get("acct"); account.AccessToken != "tok-secret" {
		t.Fatalf("unsealed account=%+v", account)
	}
}

func TestRuntimeStateIsFlushedLaterNotOnEveryRequest(t *testing.T) {
	withRuntimeFlushDelay(t, time.Hour)
	path := t.TempDir() + "/accounts.json"
	store, err := OpenSealedStore(path, "bundle-key")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	if _, err := store.Upsert(Account{ID: "acct", Enabled: true, AccessToken: "tok"}); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(path)
	store.UpdateQuota("acct", map[string]any{"primary_window": map[string]any{"used_percent": 12.0, "window_minutes": 300.0}})
	store.Dispose("acct", "gpt-test", upstreamFailure{Category: categoryRateLimited}, time.Now())
	if after, _ := os.ReadFile(path); string(after) != string(before) {
		t.Fatal("runtime state was written synchronously on the request path")
	}
	if err := store.Flush(); err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenSealedStore(path, "bundle-key")
	if err != nil {
		t.Fatal(err)
	}
	if account, _ := reopened.Get("acct"); account.CooldownReason != string(categoryRateLimited) || account.Quota == nil {
		t.Fatalf("flushed account=%+v", publicAccount(account))
	}
}

func TestCredentialTerminalStateIsPersistedImmediately(t *testing.T) {
	withRuntimeFlushDelay(t, time.Hour)
	path := t.TempDir() + "/accounts.json"
	store, err := OpenSealedStore(path, "bundle-key")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	if _, err := store.Upsert(Account{ID: "acct", Enabled: true, AccessToken: "tok"}); err != nil {
		t.Fatal(err)
	}
	store.Dispose("acct", "gpt-test", upstreamFailure{Category: categoryBanned}, time.Now())
	// 不调用 Flush：模拟进程在延迟落盘前异常退出
	reopened, err := OpenSealedStore(path, "bundle-key")
	if err != nil {
		t.Fatal(err)
	}
	if account, _ := reopened.Get("acct"); account.CredentialState != "banned" {
		t.Fatalf("credential state on disk=%q", account.CredentialState)
	}
}
