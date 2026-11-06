package codexgateway

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Gateway 事实直读 G2（设计第 19 节）：跨语言解密、读取契约视图、增量读取与影子比对。

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

// 控制面库的最小结构 + 真实迁移 124（视图与触发器）
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
CREATE TABLE gateway_worker_account_bindings (account_resource_id TEXT, gateway_instance_id TEXT, runtime_account_id TEXT, updated_at TEXT);
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
  geo_v6_country_code TEXT, geo_v6_region TEXT, geo_v6_city TEXT, geo_v6_timezone TEXT);`
	if _, err := db.Exec(base); err != nil {
		t.Fatal(err)
	}
	migration, err := os.ReadFile(filepath.Join("..", "..", "..", "src", "lib", "db", "migrations", "124_gateway_account_facts.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(string(migration)); err != nil {
		t.Fatalf("migration 124: %v", err)
	}
	return db, path
}

func seedFacts(t *testing.T, db *sql.DB, fixture factsFixture) {
	t.Helper()
	config := `{"platform":"openai","execution_kind":"gateway_worker","max_concurrency":3,"weight":2,"max_rpm":60,
	  "model_access":{"mode":"denylist","models":["gpt-x"]},"reset_credit_auto":true,"proxy_id":"px-1",
	  "runtime_account_id":"gwacct_gw-01","installation_id":"6f1c0e1e-5b7a-4a51-9d0e-6f6f1b3c2a10",
	  "bps":{"enabled":true,"models":["gpt-5"],"auto_move_on_403":true},"bps_grant":{"revision":1},"email":"a@example.test"}`
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
	if status.Contract != 1 || status.Accounts != 1 || len(f.Errors) != 0 {
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
	if f.BPSSettings == nil || !f.BPSSettings.Enabled || f.BPSSettings.RecoveryIntervalMinutes != 1 || f.BPSSettings.RateLimitCooldownSeconds != 5 {
		t.Fatalf("bps settings = %+v", f.BPSSettings)
	}
	if f.Native == nil || f.Native.Revision != 7 || f.Native.RefreshToken != "rt-native" || f.BPS == nil || f.BPS.RefreshToken != "rt-bps" {
		t.Fatalf("credentials = %+v %+v", f.Native, f.BPS)
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
	if _, err := writer.Exec("UPDATE gateway_fact_contract SET version=2"); err != nil {
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
	if _, err := writer.Exec("UPDATE gateway_fact_contract SET version=1"); err != nil {
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

func TestFactsShadowComparesProjectedFields(t *testing.T) {
	fact := AccountFacts{ResourceID: "gw-01", RuntimeID: "rt", Status: "active", MaxConcurrency: 4, Weight: 1, Groups: []string{"3", "9"},
		ProxyURL: "socks5h://p", Native: &FactCredential{Revision: 2, RefreshToken: "rt2"}}
	account := Account{ID: "rt", Enabled: true, MaxConcurrency: 4, Weight: 1, Groups: []string{"9", "3"}, ProxyURL: "socks5h://p", CredentialRevision: 2, RefreshToken: "rt2"}
	result := compareFactsWithStore(map[string]AccountFacts{"gw-01": fact}, []Account{account}, time.Now())
	if result.Matched != 1 || result.Mismatched != 0 {
		t.Fatalf("result = %+v", result)
	}
	account.Groups, account.CredentialRevision, account.MaxRPM = []string{"9"}, 1, 5
	result = compareFactsWithStore(map[string]AccountFacts{"gw-01": fact}, []Account{account, {ID: "stray", Enabled: true}}, time.Now())
	if result.Mismatched != 1 || len(result.Items) != 1 || len(result.MissingInFacts) != 1 {
		t.Fatalf("result = %+v", result)
	}
	want := map[string]bool{"groups": true, "credential_revision": true, "max_rpm": true}
	for _, field := range result.Items[0].Fields {
		if !want[field] {
			t.Fatalf("unexpected field %s in %v", field, result.Items[0].Fields)
		}
		delete(want, field)
	}
	if len(want) != 0 {
		t.Fatalf("missing fields %v", want)
	}
	// 暂停的账号投影不带分组
	fact.Status = "paused"
	paused := Account{ID: "rt", Paused: true, MaxConcurrency: 4, Weight: 1, ProxyURL: "socks5h://p", CredentialRevision: 2, RefreshToken: "rt2"}
	if result := compareFactsWithStore(map[string]AccountFacts{"gw-01": fact}, []Account{paused}, time.Now()); result.Matched != 1 {
		t.Fatalf("paused = %+v", result)
	}
}

// 回归（生产 2026-11-06 首次影子运行）：比对必须用含凭据的账号副本，对外视图会把令牌、代理与安装身份清空
func TestFactsShadowComparesAgainstCredentialBearingAccounts(t *testing.T) {
	store, err := OpenSealedStore(filepath.Join(t.TempDir(), "accounts.json"), "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Upsert(Account{ID: "rt", Enabled: true, MaxConcurrency: 4, Weight: 1, Groups: []string{"3"}, ProxyURL: "socks5h://u:p@h:1",
		RefreshToken: "rt-1", AccessToken: "at-1", CredentialRevision: 2, InstallationID: "6f1c0e1e-5b7a-4a51-9d0e-6f6f1b3c2a10",
		BPS: &BPSGrant{Revision: 1, TokenGeneration: 1, RefreshToken: "brt", AccessToken: "bat"}}); err != nil {
		t.Fatal(err)
	}
	stored, _ := store.Get("rt")
	fact := AccountFacts{ResourceID: "gw-01", RuntimeID: "rt", Status: "active", MaxConcurrency: 4, Weight: 1, Groups: []string{"3"},
		ProxyURL: "socks5h://u:p@h:1", InstallationID: stored.InstallationID, Native: &FactCredential{Revision: stored.CredentialRevision, RefreshToken: "rt-1"},
		BPS: &FactCredential{Revision: 2, RefreshToken: "brt"}}
	server := &Server{store: store, facts: &factsState{reader: &FactsReader{accounts: map[string]AccountFacts{"gw-01": fact}, loadedAt: time.Now()}}}
	if result := server.compareFacts(); result.Matched != 1 || result.Mismatched != 0 {
		t.Fatalf("result = %+v", result)
	}
}
