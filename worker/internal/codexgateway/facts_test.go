package codexgateway

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Gateway 事实直读（设计第 19 节）：跨语言解密、读取契约视图、增量读取与合并进账号表。

type factsFixture struct {
	DBSecret    string          `json:"db_secret"`
	SecretJSON  string          `json:"secret_json"`
	SecretPlain map[string]any  `json:"secret_plain"`
	Keyring     json.RawMessage `json:"keyring"`
	Credentials []struct {
		Account     string `json:"account_resource_id"`
		Grant       string `json:"grant_kind"`
		Revision    int64  `json:"revision"`
		MasterKeyID string `json:"master_key_id"`
		Wrapped     string `json:"wrapped_key"`
		Ciphertext  string `json:"ciphertext"`
		Fingerprint string `json:"token_fingerprint"`
	} `json:"credentials"`
	Plain map[string]vaultSecrets `json:"plain"`
}

func loadFactsFixture(t *testing.T) (factsFixture, string) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "test", "fixtures", "executor-contract", "facts.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture factsFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	keyFile := filepath.Join(t.TempDir(), "credential-master-keys.json")
	if err := os.WriteFile(keyFile, fixture.Keyring, 0o600); err != nil {
		t.Fatal(err)
	}
	return fixture, keyFile
}

func TestFactsCryptoOpensControlPlaneCiphertexts(t *testing.T) {
	fixture, keyFile := loadFactsFixture(t)
	plain, err := decryptDBField(fixture.SecretJSON, fixture.DBSecret)
	if err != nil {
		t.Fatal(err)
	}
	var secret map[string]any
	_ = json.Unmarshal([]byte(plain), &secret)
	if secret["proxy_url"] != fixture.SecretPlain["proxy_url"] {
		t.Fatalf("secret_json = %v", secret)
	}
	if _, err := decryptDBField(fixture.SecretJSON, "wrong"); err == nil {
		t.Fatal("a wrong database secret must fail")
	}
	if _, err := decryptDBField(fixture.SecretJSON, ""); err == nil {
		t.Fatal("an encrypted field without a secret must fail")
	}
	if value, _ := decryptDBField(`{"proxy_url":"x"}`, ""); value != `{"proxy_url":"x"}` {
		t.Fatal("plain fields pass through")
	}
	keyring := newFactsKeyring(keyFile)
	for _, record := range fixture.Credentials {
		got, err := openVaultRecord(keyring, record.Account, record.Grant, record.Revision, record.MasterKeyID, record.Wrapped, record.Ciphertext)
		if err != nil {
			t.Fatalf("%s: %v", record.Grant, err)
		}
		if got != fixture.Plain[record.Grant] {
			t.Fatalf("%s secrets = %+v", record.Grant, got)
		}
		// 附加认证数据绑定账号与代次：挪到别的账号或改代次都解不开
		if _, err := openVaultRecord(keyring, "gw-other", record.Grant, record.Revision, record.MasterKeyID, record.Wrapped, record.Ciphertext); err == nil {
			t.Fatal("record moved to another account must fail")
		}
		if _, err := openVaultRecord(keyring, record.Account, record.Grant, record.Revision+1, record.MasterKeyID, record.Wrapped, record.Ciphertext); err == nil {
			t.Fatal("record with another revision must fail")
		}
	}
	if _, err := openVaultRecord(newFactsKeyring(filepath.Join(t.TempDir(), "missing.json")), "gw-01", "native", 7, "mk", "", ""); err == nil {
		t.Fatal("a missing master key file fails closed")
	}
}

// 控制面库的最小结构 + 真实迁移 124、129、133（视图与触发器）
func openFactsTestDB(t *testing.T) (*sql.DB, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "kin.db")
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)")
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = db.Close() })
	base := `
CREATE TABLE vendor_resources (id TEXT PRIMARY KEY, vendor_id TEXT, resource_type TEXT NOT NULL, name TEXT NOT NULL,
  external_id TEXT, status TEXT NOT NULL DEFAULT 'active', config_json TEXT NOT NULL DEFAULT '{}', secret_json TEXT,
  created_by TEXT NOT NULL DEFAULT 't', created_at TEXT NOT NULL DEFAULT 'x', updated_at TEXT NOT NULL DEFAULT 'x',
  archived_at TEXT, deleted_at TEXT);
CREATE TABLE gateway_worker_account_bindings (account_resource_id TEXT, gateway_instance_id TEXT, runtime_account_id TEXT, updated_at TEXT,
  bps_state TEXT, bps_error TEXT, bps_blocked_at TEXT, bps_recovery TEXT, bps_next_probe_at TEXT, bps_cooldown_until TEXT);
CREATE TABLE gateway_bps_probes (id INTEGER PRIMARY KEY);
CREATE TABLE executor_settings (id TEXT PRIMARY KEY, values_json TEXT NOT NULL DEFAULT '{}');
CREATE TABLE api_keys (id TEXT PRIMARY KEY, codex_route TEXT);
CREATE TABLE executor_event_inbox (event_id TEXT PRIMARY KEY, type TEXT NOT NULL);
CREATE TABLE gateway_worker_instances (id TEXT PRIMARY KEY);
CREATE TABLE executor_credentials (account_resource_id TEXT NOT NULL, grant_kind TEXT NOT NULL, revision INTEGER NOT NULL,
  master_key_id TEXT NOT NULL, wrapped_key TEXT NOT NULL, ciphertext TEXT NOT NULL, token_fingerprint TEXT, expires_at TEXT,
  source TEXT NOT NULL DEFAULT 't', source_instance_id TEXT, updated_at TEXT NOT NULL DEFAULT 'x',
  PRIMARY KEY (account_resource_id, grant_kind));
CREATE TABLE group_resources (group_id INTEGER NOT NULL, resource_kind TEXT NOT NULL, resource_id TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 50, PRIMARY KEY (group_id, resource_kind, resource_id));
CREATE TABLE proxies (id TEXT PRIMARY KEY, latency_ms INTEGER, max_websocket_connections INTEGER NOT NULL DEFAULT 0,
  request_location_mode TEXT NOT NULL DEFAULT 'inherit', location_country TEXT, location_region TEXT, location_city TEXT,
  location_timezone TEXT, geo_country_code TEXT, geo_region TEXT, geo_city TEXT, geo_timezone TEXT,
  geo_v6_country_code TEXT, geo_v6_region TEXT, geo_v6_city TEXT, geo_v6_timezone TEXT);
CREATE TABLE vendors (id TEXT PRIMARY KEY, parent_id TEXT, status TEXT NOT NULL DEFAULT 'active',
  groups_json TEXT NOT NULL DEFAULT '[]', platforms_json TEXT NOT NULL DEFAULT '[]', deleted_at TEXT);
CREATE TABLE groups (id INTEGER PRIMARY KEY, name TEXT NOT NULL);`
	if _, err := db.Exec(base); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"124_gateway_account_facts.sql", "129_gateway_facts_vendor_gate.sql", "133_remove_bps.sql"} {
		migration, err := os.ReadFile(filepath.Join("..", "..", "..", "src", "lib", "db", "migrations", name))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(string(migration)); err != nil {
			t.Fatalf("migration %s: %v", name, err)
		}
	}
	return db, path
}

func seedFacts(t *testing.T, db *sql.DB, fixture factsFixture) {
	t.Helper()
	config := `{"platform":"openai","execution_kind":"gateway_worker","max_concurrency":3,"weight":2,"max_rpm":60,
	  "model_access":{"mode":"denylist","models":["gpt-x"]},"reset_credit_auto":true,"proxy_id":"px-1",
	  "runtime_account_id":"gwacct_gw-01","installation_id":"6f1c0e1e-5b7a-4a51-9d0e-6f6f1b3c2a10",
	  "email":"a@example.test"}`
	statements := []struct {
		query string
		args  []any
	}{
		{"INSERT INTO proxies(id,max_websocket_connections,request_location_mode,geo_country_code,geo_region,geo_city,geo_timezone) VALUES('px-1',4,'auto','JP','Tokyo','Tokyo','Asia/Tokyo')", nil},
		{"INSERT INTO vendor_resources(id,resource_type,name,status,config_json,secret_json) VALUES('gw-01','account','A','active',?,?)", []any{config, fixture.SecretJSON}},
		{"INSERT INTO group_resources(group_id,resource_kind,resource_id) VALUES(9,'gateway_worker_account','gw-01'),(3,'gateway_worker_account','gw-01')", nil},
	}
	for _, record := range fixture.Credentials {
		statements = append(statements, struct {
			query string
			args  []any
		}{"INSERT INTO executor_credentials(account_resource_id,grant_kind,revision,master_key_id,wrapped_key,ciphertext,token_fingerprint) VALUES(?,?,?,?,?,?,?)",
			[]any{record.Account, record.Grant, record.Revision, record.MasterKeyID, record.Wrapped, record.Ciphertext, record.Fingerprint}})
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement.query, statement.args...); err != nil {
			t.Fatalf("%s: %v", statement.query, err)
		}
	}
}

func TestFactsReaderLoadsTheContractViewAndFollowsChanges(t *testing.T) {
	fixture, keyFile := loadFactsFixture(t)
	writer, path := openFactsTestDB(t)
	seedFacts(t, writer, fixture)
	reader, err := OpenFactsReader(path, keyFile, fixture.DBSecret)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	ctx := context.Background()
	if err := reader.Refresh(ctx, true); err != nil {
		t.Fatal(err)
	}
	facts, status := reader.Snapshot()
	f := facts["gw-01"]
	if status.Contract != 2 || status.Accounts != 1 || len(f.Errors) != 0 {
		t.Fatalf("status = %+v errors = %v", status, f.Errors)
	}
	if f.RuntimeID != "gwacct_gw-01" || f.MaxConcurrency != 3 || f.Weight != 2 || f.MaxRPM != 60 || !f.ResetCreditAuto || !f.Schedulable() {
		t.Fatalf("facts = %+v", f)
	}
	if len(f.DeniedModels) != 1 || f.DeniedModels[0] != "gpt-x" || len(f.Models) != 0 {
		t.Fatalf("model access = %v / %v", f.Models, f.DeniedModels)
	}
	if len(f.Groups) != 2 || f.Groups[0] != "3" || f.Groups[1] != "9" {
		t.Fatalf("groups = %v", f.Groups)
	}
	if f.ProxyURL != fixture.SecretPlain["proxy_url"] || f.ProxyMaxWS != 4 || f.RequestLocation == nil || f.RequestLocation.Timezone != "Asia/Tokyo" {
		t.Fatalf("proxy = %q %d %+v", f.ProxyURL, f.ProxyMaxWS, f.RequestLocation)
	}
	if f.Native == nil || f.Native.Revision != 7 || f.Native.RefreshToken != "rt-native" {
		t.Fatalf("credentials = %+v", f.Native)
	}
	// 没有变化时不读视图
	seq := status.Seq
	if err := reader.Refresh(ctx, false); err != nil {
		t.Fatal(err)
	}
	// 只推进 Worker 读取的字段；备注等不推进
	if _, err := writer.Exec("UPDATE vendor_resources SET config_json=json_set(config_json,'$.notes','x') WHERE id='gw-01'"); err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Exec("UPDATE vendor_resources SET status='paused',config_json=json_set(config_json,'$.max_concurrency',8) WHERE id='gw-01'"); err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Exec("DELETE FROM group_resources WHERE group_id=9"); err != nil {
		t.Fatal(err)
	}
	if err := reader.Refresh(ctx, false); err != nil {
		t.Fatal(err)
	}
	facts, status = reader.Snapshot()
	f = facts["gw-01"]
	if status.Seq <= seq || f.MaxConcurrency != 8 || f.Schedulable() || len(f.Groups) != 1 || f.Groups[0] != "3" {
		t.Fatalf("after change: seq %d→%d facts %+v", seq, status.Seq, f)
	}
	// 读事务已结束：控制面的 checkpoint 能截断 WAL
	var busy, logFrames, checkpointed int
	if err := writer.QueryRow("PRAGMA wal_checkpoint(TRUNCATE)").Scan(&busy, &logFrames, &checkpointed); err != nil || busy != 0 {
		t.Fatalf("checkpoint busy=%d err=%v", busy, err)
	}
	// 契约版本超出支持区间：拒绝加载，保留上一份快照
	if _, err := writer.Exec("UPDATE gateway_fact_contract SET version=3"); err != nil {
		t.Fatal(err)
	}
	if err := reader.Refresh(ctx, true); err == nil {
		t.Fatal("an unsupported contract version must be refused")
	}
	facts, status = reader.Snapshot()
	if len(facts) != 1 || status.LastError == "" {
		t.Fatalf("snapshot kept = %d last_error %q", len(facts), status.LastError)
	}
	// 主密钥缺失：该账号标出错误，不带凭据
	if _, err := writer.Exec("UPDATE gateway_fact_contract SET version=2"); err != nil {
		t.Fatal(err)
	}
	_ = os.Remove(keyFile)
	reader2, _ := OpenFactsReader(path, keyFile, fixture.DBSecret)
	defer reader2.Close()
	if err := reader2.Refresh(ctx, true); err != nil {
		t.Fatal(err)
	}
	facts, _ = reader2.Snapshot()
	if facts["gw-01"].Native != nil || len(facts["gw-01"].Errors) == 0 {
		t.Fatalf("missing master key = %+v", facts["gw-01"])
	}
}

// 迁移 129：供应商停用或收回分组授权后，账号不再接单、分组只剩授权范围内的；重新授权后恢复
func TestFactsFollowVendorStatusAndGroupScope(t *testing.T) {
	fixture, keyFile := loadFactsFixture(t)
	writer, path := openFactsTestDB(t)
	seedFacts(t, writer, fixture)
	for _, statement := range []string{
		"INSERT INTO groups(id,name) VALUES(3,'g3'),(9,'g9')",
		"INSERT INTO vendors(id,parent_id,groups_json,platforms_json) VALUES('root',NULL,'[\"3\",\"g9\"]','[\"openai\"]'),('child','root','[]','[]')",
		"UPDATE vendor_resources SET vendor_id='child' WHERE id='gw-01'",
	} {
		if _, err := writer.Exec(statement); err != nil {
			t.Fatalf("%s: %v", statement, err)
		}
	}
	reader, err := OpenFactsReader(path, keyFile, fixture.DBSecret)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	ctx := context.Background()
	load := func() AccountFacts {
		t.Helper()
		if err := reader.Refresh(ctx, false); err != nil {
			t.Fatal(err)
		}
		facts, _ := reader.Snapshot()
		return facts["gw-01"]
	}
	// 下级供应商分组为空时继承上级（按 ID 或名称匹配）
	if f := load(); !f.Schedulable() || len(f.Groups) != 2 {
		t.Fatalf("inherited scope: %+v", f)
	}
	// 上级停用：下级的账号停止接单
	if _, err := writer.Exec("UPDATE vendors SET status='disabled' WHERE id='root'"); err != nil {
		t.Fatal(err)
	}
	if f := load(); f.Schedulable() || !f.VendorInactive {
		t.Fatalf("parent disabled: %+v", f)
	}
	if _, err := writer.Exec("UPDATE vendors SET status='active' WHERE id='root'"); err != nil {
		t.Fatal(err)
	}
	// 上级收回分组 9 的授权（按名称授权的分组改名同样收回）
	if _, err := writer.Exec("UPDATE groups SET name='renamed' WHERE id=9"); err != nil {
		t.Fatal(err)
	}
	if f := load(); !f.Schedulable() || len(f.Groups) != 1 || f.Groups[0] != "3" {
		t.Fatalf("scope revoked: %+v", f)
	}
	// 平台授权不含 OpenAI
	if _, err := writer.Exec(`UPDATE vendors SET platforms_json='["anthropic"]' WHERE id='child'`); err != nil {
		t.Fatal(err)
	}
	if f := load(); f.Schedulable() {
		t.Fatalf("platform revoked: %+v", f)
	}
}

func TestApplyFactsTakesConfigFromFactsAndCredentialsOnlyForward(t *testing.T) {
	store, err := OpenSealedStore(filepath.Join(t.TempDir(), "accounts.json"), "")
	if err != nil {
		t.Fatal(err)
	}
	store.SetDefaultConcurrency(4)
	fact := AccountFacts{ResourceID: "gw-01", RuntimeID: "rt", Status: "active", MaxConcurrency: 3, Weight: 2, Groups: []string{"7"},
		Models: []string{"gpt-5"}, ProxyURL: "socks5h://p:1", InstallationID: "6f1c0e1e-5b7a-4a51-9d0e-6f6f1b3c2a10",
		Native: &FactCredential{Revision: 3, AccessToken: "at3", RefreshToken: "rt3"}}
	facts := map[string]AccountFacts{"gw-01": fact, "gw-02": {ResourceID: "gw-02", RuntimeID: "rt2", Status: "active"}}
	if changed, err := store.ApplyFacts(facts); err != nil || changed != 1 {
		t.Fatalf("changed=%d err=%v", changed, err)
	}
	account, ok := store.Get("rt")
	if !ok || !account.Enabled || account.Paused || account.MaxConcurrency != 3 || account.Weight != 2 || account.RefreshToken != "rt3" ||
		account.CredentialRevision != 3 || account.ProxyURL != "socks5h://p:1" || account.InstallationID != fact.InstallationID || len(account.Groups) != 1 {
		t.Fatalf("account = %+v", account)
	}
	if _, ok := store.Get("rt2"); ok {
		t.Fatal("an account without credentials is not created")
	}
	// 运行态保留；没有变化时不写
	account.CooldownUntil, account.Quota = time.Now().Add(time.Hour), map[string]any{"plan_type": "pro"}
	if _, err := store.Upsert(account); err != nil {
		t.Fatal(err)
	}
	if changed, _ := store.ApplyFacts(facts); changed != 0 {
		t.Fatalf("unchanged facts rewrote %d accounts", changed)
	}
	// 本实例刚刷新（本地代次更高）：保留本地令牌，配置照样以事实为准
	local, _ := store.Get("rt")
	local.CredentialRevision, local.RefreshToken = 4, "rt4"
	local.CredentialState = "expired"
	if _, err := store.Upsert(local); err != nil {
		t.Fatal(err)
	}
	fact.MaxConcurrency, fact.Status = 9, "paused"
	if _, err := store.ApplyFacts(map[string]AccountFacts{"gw-01": fact}); err != nil {
		t.Fatal(err)
	}
	account, _ = store.Get("rt")
	if account.RefreshToken != "rt4" || account.CredentialRevision != 4 || account.MaxConcurrency != 9 || account.Enabled || !account.Paused || len(account.Groups) != 0 || account.CooldownUntil.IsZero() || account.Quota == nil {
		t.Fatalf("after pause = %+v", account)
	}
	// 重新授权（事实代次更高）：换入新令牌并清掉旧凭据的终态
	fact.Status, fact.Native = "active", &FactCredential{Revision: 10, AccessToken: "at10", RefreshToken: "rt10"}
	if _, err := store.ApplyFacts(map[string]AccountFacts{"gw-01": fact}); err != nil {
		t.Fatal(err)
	}
	account, _ = store.Get("rt")
	if account.RefreshToken != "rt10" || account.CredentialRevision != 10 || account.CredentialState != "" {
		t.Fatalf("after reauthorization = %+v", account)
	}
	// 读取出错：保留上一份；事实里没有：停止接单；墓碑：删除
	broken := fact
	broken.MaxConcurrency, broken.Errors = 1, []string{"secret_unreadable"}
	if _, err := store.ApplyFacts(map[string]AccountFacts{"gw-01": broken}); err != nil {
		t.Fatal(err)
	}
	if account, _ = store.Get("rt"); account.MaxConcurrency != 9 || !account.Enabled {
		t.Fatalf("errored facts must not change the account: %+v", account)
	}
	if _, err := store.ApplyFacts(map[string]AccountFacts{}); err != nil {
		t.Fatal(err)
	}
	if account, _ = store.Get("rt"); account.Enabled || !account.Paused || len(account.Groups) != 0 {
		t.Fatalf("accounts missing from facts stop scheduling: %+v", account)
	}
	tomb := fact
	tomb.Deleted, tomb.Status = true, "archived"
	if _, err := store.ApplyFacts(map[string]AccountFacts{"gw-01": tomb}); err != nil {
		t.Fatal(err)
	}
	if _, ok := store.Get("rt"); ok {
		t.Fatal("tombstoned accounts are deleted")
	}
}

func TestFactsPrimaryModeAppliesDatabaseChangesToTheStore(t *testing.T) {
	fixture, keyFile := loadFactsFixture(t)
	writer, path := openFactsTestDB(t)
	seedFacts(t, writer, fixture)
	reader, err := OpenFactsReader(path, keyFile, fixture.DBSecret)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	store, err := OpenSealedStore(filepath.Join(t.TempDir(), "accounts.json"), "")
	if err != nil {
		t.Fatal(err)
	}
	server := &Server{store: store, facts: &factsState{reader: reader}}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	server.startFacts(ctx)
	waitFor := func(label string, check func(Account) bool) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			if account, ok := store.Get("gwacct_gw-01"); ok && check(account) {
				return
			}
			time.Sleep(50 * time.Millisecond)
		}
		account, _ := store.Get("gwacct_gw-01")
		t.Fatalf("%s: %+v", label, account)
	}
	waitFor("initial load", func(a Account) bool {
		return a.Enabled && a.MaxConcurrency == 3 && a.RefreshToken == "rt-native" && a.CredentialRevision == 7
	})
	// 复制分组之类的成员变化：下一次轮询即生效，不需要投影
	if _, err := writer.Exec("INSERT INTO group_resources(group_id,resource_kind,resource_id) VALUES(11,'gateway_worker_account','gw-01')"); err != nil {
		t.Fatal(err)
	}
	waitFor("group added", func(a Account) bool { return len(a.Groups) == 3 })
	if _, err := writer.Exec("UPDATE vendor_resources SET status='paused' WHERE id='gw-01'"); err != nil {
		t.Fatal(err)
	}
	waitFor("paused", func(a Account) bool { return !a.Enabled && a.Paused && len(a.Groups) == 0 })
}

// 刷新只按开始时的凭据代次提交令牌字段：期间凭据被事实换过（重新授权）时拒绝，不覆盖新令牌
func TestCommitCredentialsRefusesAStaleRevision(t *testing.T) {
	store, err := OpenStore(t.TempDir() + "/accounts.json")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Upsert(Account{ID: "rt", Enabled: true, RefreshToken: "rt1", CredentialRevision: 1, MaxConcurrency: 4, Weight: 2}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.CommitCredentials("rt", 1, func(a *Account) { a.AccessToken, a.CredentialRevision = "at2", 2 }); err != nil {
		t.Fatal(err)
	}
	if _, err := store.CommitCredentials("rt", 1, func(a *Account) { a.AccessToken = "stale" }); err == nil {
		t.Fatal("a commit against an old revision must be refused")
	}
	account, _ := store.Get("rt")
	if account.AccessToken != "at2" || account.CredentialRevision != 2 || account.Weight != 2 {
		t.Fatalf("account = %+v", account)
	}
}

// S1b：刷新结果按代次 CAS 写回凭据库；库被控制面改过（重新授权、导入）时这次刷新作废
func TestRefreshedCredentialsAreWrittenBackByRevision(t *testing.T) {
	fixture, keyFile := loadFactsFixture(t)
	writer, path := openFactsTestDB(t)
	seedFacts(t, writer, fixture)
	reader, err := OpenFactsReader(path, keyFile, fixture.DBSecret)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	ctx := context.Background()
	if err := reader.Refresh(ctx, true); err != nil {
		t.Fatal(err)
	}
	facts, _ := reader.Snapshot()
	base := facts["gw-01"].Native.Revision
	write := func(revision, from int64, refresh string) error {
		return reader.writeCredential(ctx, credentialWrite{Resource: "gw-01", Revision: revision, Base: from,
			Secrets: vaultSecrets{AccessToken: "at-" + refresh, RefreshToken: refresh}, ExpiresAt: time.Now().Add(time.Hour), InstanceID: "gw-1"})
	}
	if err := write(base+1, base, "rt-refreshed"); err != nil {
		t.Fatal(err)
	}
	if err := reader.Refresh(ctx, false); err != nil {
		t.Fatal(err)
	}
	facts, _ = reader.Snapshot()
	if got := facts["gw-01"].Native; got == nil || got.Revision != base+1 || got.RefreshToken != "rt-refreshed" {
		t.Fatalf("written back = %+v", got)
	}
	var source, instance string
	if err := writer.QueryRow("SELECT source, source_instance_id FROM executor_credentials WHERE account_resource_id='gw-01' AND grant_kind='native'").Scan(&source, &instance); err != nil || source != "refresh" || instance != "gw-1" {
		t.Fatalf("source = %q %q %v", source, instance, err)
	}
	// 重试同一次写回：幂等
	if err := write(base+1, base, "rt-refreshed"); err != nil {
		t.Fatal(err)
	}
	// 期间控制面重新授权（库里换成别的代次）：从旧代次派生的刷新作废
	if _, err := writer.Exec("UPDATE executor_credentials SET revision=revision+5 WHERE account_resource_id='gw-01' AND grant_kind='native'"); err != nil {
		t.Fatal(err)
	}
	if err := write(base+2, base+1, "rt-late"); !errors.Is(err, errCredentialSuperseded) {
		t.Fatalf("a refresh from a replaced revision must be discarded: %v", err)
	}
}

// 事实合并：本地未写回的刷新（来源代次不变）保留；库里换成别的代次（即使更低）时换入库里的凭据
func TestFactsAdoptAReplacedVaultRevisionEvenWhenLower(t *testing.T) {
	account := Account{ID: "rt", RefreshToken: "rt-local", AccessToken: "at-local", CredentialRevision: 9, CredentialBase: 8}
	applyFactCredentials(&account, AccountFacts{Native: &FactCredential{Revision: 8, RefreshToken: "rt-8", AccessToken: "at-8"}})
	if account.RefreshToken != "rt-local" || account.CredentialRevision != 9 {
		t.Fatalf("a local refresh not yet written back is kept: %+v", account)
	}
	applyFactCredentials(&account, AccountFacts{Native: &FactCredential{Revision: 9, RefreshToken: "rt-local", AccessToken: "at-local"}})
	if account.CredentialBase != 9 {
		t.Fatalf("the written-back revision becomes the base: %+v", account)
	}
	applyFactCredentials(&account, AccountFacts{Native: &FactCredential{Revision: 5, RefreshToken: "rt-reauth", AccessToken: "at-reauth"}})
	if account.RefreshToken != "rt-reauth" || account.CredentialRevision != 5 || account.CredentialBase != 5 {
		t.Fatalf("a reauthorized vault revision replaces the local tokens: %+v", account)
	}
}
