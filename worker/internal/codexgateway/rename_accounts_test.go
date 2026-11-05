package codexgateway

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alicebob/miniredis/v2"
)

func renameFixture(t *testing.T, mr *miniredis.Miniredis) Config {
	t.Helper()
	cfg := Config{DataDir: t.TempDir(), CredentialBundleKey: "bundle-key", InstanceID: "gw-01", RedisURL: "redis://" + mr.Addr()}
	store, err := OpenSealedStore(cfg.AccountsPath(), cfg.CredentialBundleKey)
	if err != nil {
		t.Fatal(err)
	}
	for _, account := range []Account{
		{ID: "gwacct_account_a", AuthType: "oauth", RefreshToken: "rt-a", InstallationID: "install-a"},
		{ID: "gwacct_other", AuthType: "oauth", RefreshToken: "rt-o"},
	} {
		if _, err := store.Upsert(account); err != nil {
			t.Fatal(err)
		}
	}
	if err := store.Flush(); err != nil {
		t.Fatal(err)
	}
	provenance := newRouteProvenance(filepath.Join(cfg.DataDir, "route_provenance.json"), store)
	provenance.recordOwned("scope", routeNative, "gwacct_account_a", []string{"enc:1"})
	provenance.recordOwned("scope", routeNative, "gwacct_other", []string{"enc:2"})
	if err := provenance.Flush(); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(cfg.ReceiptDir(), 0o700); err != nil {
		t.Fatal(err)
	}
	_, receipt, err := signReceipt(map[string]any{"dispatch_id": "d1", "runtime_account_id": "gwacct_account_a",
		"attempts": []any{map[string]any{"account": "gwacct_account_a"}, map[string]any{"account": "gwacct_other"}}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cfg.ReceiptDir(), "d1.json"), receipt, 0o600); err != nil {
		t.Fatal(err)
	}
	disk := newBPSDiskState(filepath.Join(cfg.DataDir, "bps_state"), store)
	if _, err := disk.SaveBPSState(context.Background(), "account:gwacct_account_a/key:k", "replay", nil, []byte("x")); err != nil {
		t.Fatal(err)
	}
	if err := disk.Flush(); err != nil {
		t.Fatal(err)
	}
	mr.Set("kin:gw:sem:abc", "1")
	mr.Set("unrelated:key", "1")
	return cfg
}

func TestRenameAccountsRewritesWorkerStateOffline(t *testing.T) {
	mr := miniredis.RunT(t)
	cfg := renameFixture(t, mr)
	plan := []AccountRename{{From: "gwacct_account_a", To: "gwacct_gw-01"}, {From: "gwacct_account_gone", To: "gwacct_gw-02"}}

	report, err := RenameAccounts(cfg, plan)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(report.Renamed, ",") != "gwacct_gw-01" || strings.Join(report.Missing, ",") != "gwacct_account_gone" ||
		report.Provenance != 1 || report.Receipts != 1 || report.BPSStateRemoved != 1 || report.RedisKeysRemoved != 1 {
		t.Fatalf("report=%+v", report)
	}

	store, err := OpenSealedStore(cfg.AccountsPath(), cfg.CredentialBundleKey)
	if err != nil {
		t.Fatal(err)
	}
	renamed, ok := store.accounts["gwacct_gw-01"]
	if !ok || renamed.InstallationID != "install-a" || renamed.RefreshToken != "rt-a" {
		t.Fatalf("renamed account=%+v ok=%v", renamed, ok)
	}
	if _, ok := store.accounts["gwacct_account_a"]; ok {
		t.Fatal("old account id must be gone")
	}
	if _, ok := store.accounts["gwacct_other"]; !ok {
		t.Fatal("unrelated account must be kept")
	}

	provenance := newRouteProvenance(filepath.Join(cfg.DataDir, "route_provenance.json"), store)
	owners := map[string]string{}
	for _, entry := range provenance.entries {
		owners[entry.Account] = entry.Route
	}
	if _, ok := owners["gwacct_gw-01"]; !ok || owners["gwacct_account_a"] != "" || owners["gwacct_other"] == "" {
		t.Fatalf("provenance owners=%v", owners)
	}

	data, err := os.ReadFile(filepath.Join(cfg.ReceiptDir(), "d1.json"))
	if err != nil {
		t.Fatal(err)
	}
	var receipt map[string]any
	if err := json.Unmarshal(data, &receipt); err != nil {
		t.Fatal(err)
	}
	attempts := receipt["attempts"].([]any)
	if receipt["runtime_account_id"] != "gwacct_gw-01" || attempts[0].(map[string]any)["account"] != "gwacct_gw-01" ||
		attempts[1].(map[string]any)["account"] != "gwacct_other" {
		t.Fatalf("receipt=%v", receipt)
	}
	// payload_hash 与 Worker 正常写回执的口径一致（控制面按同一规则校验）
	resigned, _, err := signReceipt(receipt)
	if err != nil || resigned["payload_hash"] != receipt["payload_hash"] {
		t.Fatalf("payload_hash=%v want %v err=%v", receipt["payload_hash"], resigned["payload_hash"], err)
	}

	if entries, _ := os.ReadDir(filepath.Join(cfg.DataDir, "bps_state")); len(entries) != 0 {
		t.Fatalf("bps_state entries=%d", len(entries))
	}
	if mr.Exists("kin:gw:sem:abc") || !mr.Exists("unrelated:key") {
		t.Fatalf("redis keys=%v", mr.Keys())
	}

	again, err := RenameAccounts(cfg, plan)
	if err != nil || strings.Join(again.AlreadyRenamed, ",") != "gwacct_gw-01" || len(again.Renamed) != 0 || again.Receipts != 0 {
		t.Fatalf("rerun report=%+v err=%v", again, err)
	}
}

func TestRenameAccountsRewritesOnlyUnackedEvents(t *testing.T) {
	mr := miniredis.RunT(t)
	cfg := renameFixture(t, mr)
	events, err := openEventLog(filepath.Join(cfg.DataDir, "events"), cfg.InstanceID)
	if err != nil {
		t.Fatal(err)
	}
	old := map[string]string{"runtime_account_id": "gwacct_account_a"}
	if _, err := events.append(EventProbeRecorded, old, map[string]any{"account_id": "gwacct_account_a"}); err != nil {
		t.Fatal(err)
	}
	if err := events.ack(1); err != nil {
		t.Fatal(err)
	}
	receipt, _, err := signReceipt(map[string]any{"dispatch_id": "d2", "runtime_account_id": "gwacct_account_a"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := events.append(EventRequestFinalized, old, receipt); err != nil {
		t.Fatal(err)
	}
	if _, err := events.append(EventProbeRecorded, map[string]string{"runtime_account_id": "gwacct_other"}, map[string]any{"n": 1}); err != nil {
		t.Fatal(err)
	}
	_ = events.close()

	report, err := RenameAccounts(cfg, []AccountRename{{From: "gwacct_account_a", To: "gwacct_gw-01"}})
	if err != nil || report.Events != 1 {
		t.Fatalf("report=%+v err=%v", report, err)
	}
	reopened, err := openEventLog(filepath.Join(cfg.DataDir, "events"), cfg.InstanceID)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.close()
	if reopened.head != 3 || reopened.acked != 1 {
		t.Fatalf("head=%d acked=%d", reopened.head, reopened.acked)
	}
	all, err := reopened.read(0, 10)
	if err != nil || len(all) != 3 {
		t.Fatalf("events=%d err=%v", len(all), err)
	}
	// 已确认的历史事件不改
	if all[0].Subject["runtime_account_id"] != "gwacct_account_a" {
		t.Fatalf("acked event subject=%v", all[0].Subject)
	}
	finalized := all[1]
	if err := finalized.validate(); err != nil || finalized.Subject["runtime_account_id"] != "gwacct_gw-01" {
		t.Fatalf("finalized=%+v err=%v", finalized, err)
	}
	var payload map[string]any
	if err := json.Unmarshal(finalized.Payload, &payload); err != nil || payload["runtime_account_id"] != "gwacct_gw-01" {
		t.Fatalf("payload=%s err=%v", finalized.Payload, err)
	}
	// 载荷里的回执签名与控制面 ingestReceipt 校验口径一致
	resigned, _, err := signReceipt(payload)
	if err != nil || resigned["payload_hash"] != payload["payload_hash"] {
		t.Fatalf("receipt hash=%v want %v", payload["payload_hash"], resigned["payload_hash"])
	}
	if err := all[2].validate(); err != nil || all[2].Subject["runtime_account_id"] != "gwacct_other" {
		t.Fatalf("untouched event=%+v err=%v", all[2], err)
	}
}

func TestRenameAccountsRejectsAmbiguousPlans(t *testing.T) {
	for name, plan := range map[string][]AccountRename{
		"empty":     nil,
		"self":      {{From: "a", To: "a"}},
		"slash":     {{From: "a", To: "gw/1"}},
		"duplicate": {{From: "a", To: "x"}, {From: "a", To: "y"}},
		"collision": {{From: "a", To: "x"}, {From: "b", To: "x"}},
		"chain":     {{From: "a", To: "b"}, {From: "b", To: "c"}},
	} {
		if _, err := validateAccountRenames(plan); err == nil {
			t.Fatalf("%s: plan must be rejected", name)
		}
	}
}

// 计划文件由控制面 scripts/rename-gateway-account-ids.mjs --plan 生成，字段名必须一致
func TestLoadAccountRenamePlanReadsControlPlanePlan(t *testing.T) {
	path := filepath.Join(t.TempDir(), "plan.json")
	plan := `{"kind":"gateway-account-id-rename","version":1,"seq_after":2,"accounts":[` +
		`{"resource_id_old":"account_a","resource_id_new":"gw-01","runtime_id_old":"gwacct_account_a","runtime_id_new":"gwacct_gw-01","name":"a"}]}`
	if err := os.WriteFile(path, []byte(plan), 0o600); err != nil {
		t.Fatal(err)
	}
	renames, err := LoadAccountRenamePlan(path)
	if err != nil || len(renames) != 1 || renames[0].From != "gwacct_account_a" || renames[0].To != "gwacct_gw-01" {
		t.Fatalf("renames=%+v err=%v", renames, err)
	}
}
