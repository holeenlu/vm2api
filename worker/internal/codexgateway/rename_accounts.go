package codexgateway

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// AccountRename 是一个运行账号的改名（旧运行账号 ID → 新运行账号 ID），由控制面的改名计划生成。
type AccountRename struct {
	From string `json:"runtime_id_old"`
	To   string `json:"runtime_id_new"`
}

// AccountRenameReport 汇总一次离线改名对 Worker 数据目录与共享运行态的改动。
type AccountRenameReport struct {
	Renamed          []string `json:"renamed"`
	AlreadyRenamed   []string `json:"already_renamed"`
	Missing          []string `json:"missing"`
	Provenance       int      `json:"provenance_entries_rewritten"`
	Receipts         int      `json:"receipts_rewritten"`
	Events           int      `json:"unacked_events_rewritten"`
	BPSStateRemoved  int      `json:"bps_state_entries_removed"`
	RedisKeysRemoved int      `json:"redis_keys_removed"`
}

// LoadAccountRenamePlan 读取控制面改名计划文件（scripts/rename-gateway-account-ids.mjs --plan 的输出），只取运行账号映射。
func LoadAccountRenamePlan(path string) ([]AccountRename, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var plan struct {
		Accounts []AccountRename `json:"accounts"`
	}
	if err := json.Unmarshal(data, &plan); err != nil {
		return nil, fmt.Errorf("decode rename plan: %w", err)
	}
	return plan.Accounts, nil
}

func validateAccountRenames(renames []AccountRename) (map[string]string, error) {
	if len(renames) == 0 {
		return nil, errors.New("rename plan has no accounts")
	}
	mapping := make(map[string]string, len(renames))
	targets := make(map[string]bool, len(renames))
	for _, item := range renames {
		from, to := strings.TrimSpace(item.From), strings.TrimSpace(item.To)
		switch {
		case from == "" || to == "":
			return nil, errors.New("rename plan has an empty account id")
		case from == to:
			return nil, fmt.Errorf("rename plan maps %s to itself", from)
		case strings.Contains(to, "/"):
			return nil, fmt.Errorf("new account id %s must not contain /", to)
		case mapping[from] != "":
			return nil, fmt.Errorf("rename plan lists %s twice", from)
		case targets[to]:
			return nil, fmt.Errorf("rename plan assigns %s twice", to)
		}
		mapping[from] = to
		targets[to] = true
	}
	for from := range mapping {
		if targets[from] {
			return nil, fmt.Errorf("account id %s is both renamed and a rename target", from)
		}
	}
	return mapping, nil
}

// RenameAccounts 离线把运行账号改名（统一账号编号 gw-NN，见 docs/GATEWAY_ACCOUNT_ID_RENAME.md）。必须先停止所有 Worker 实例。
//
//   - accounts.json：只改 id，installation_id、额度、冷却、Cookie 等运行态原样保留，上游看到的仍是同一个安装；
//   - route_provenance.json：签发账号改为新 ID，已有对话继续由原账号续接；
//   - receipts/ 与 events/ 中未确认的部分：替换旧 ID 后重新签名（回执 payload_hash、事件 payload_sha256），
//     控制面在重启后按新 ID 入账，不必在停机前等积压排空；已确认的事件是历史，不改；
//   - bps_state/：协议状态按含账号 ID 的作用域派生文件名，直接清空（BPS 对话缓存失效一次）；
//   - Redis（配置时）：删除本前缀下的全部共享运行态（租约、冷却、来源、BPS 状态，均带过期时间）。
//
// 重复执行是安全的：已改名的账号记为 already_renamed，其余各项已没有可替换的旧 ID。
func RenameAccounts(cfg Config, renames []AccountRename) (AccountRenameReport, error) {
	report := AccountRenameReport{Renamed: []string{}, AlreadyRenamed: []string{}, Missing: []string{}}
	mapping, err := validateAccountRenames(renames)
	if err != nil {
		return report, err
	}
	pairs := make([]string, 0, len(mapping)*2)
	for from, to := range mapping {
		pairs = append(pairs, from, to)
	}
	// 旧 ID 带 UUID，互不为子串，按子串替换即可覆盖嵌在作用域字符串等处的派生形式
	replacer := strings.NewReplacer(pairs...)

	store, err := OpenSealedStore(cfg.AccountsPath(), cfg.CredentialBundleKey)
	if err != nil {
		return report, err
	}
	for _, item := range renames {
		from := strings.TrimSpace(item.From)
		to := mapping[from]
		row, hasOld := store.accounts[from]
		_, hasNew := store.accounts[to]
		switch {
		case hasOld && hasNew:
			return report, fmt.Errorf("account store has both %s and %s", from, to)
		case hasOld:
			delete(store.accounts, from)
			row.ID = to
			store.accounts[to] = row
			report.Renamed = append(report.Renamed, to)
		case hasNew:
			report.AlreadyRenamed = append(report.AlreadyRenamed, to)
		default:
			report.Missing = append(report.Missing, from)
		}
	}
	if err := store.persist(); err != nil {
		return report, fmt.Errorf("write account store: %w", err)
	}

	provenance := newRouteProvenance(filepath.Join(cfg.DataDir, "route_provenance.json"), store)
	for key, entry := range provenance.entries {
		if to, ok := mapping[entry.Account]; ok {
			entry.Account = to
			provenance.entries[key] = entry
			report.Provenance++
		}
	}
	if err := provenance.Flush(); err != nil {
		return report, fmt.Errorf("write route provenance: %w", err)
	}

	if report.Receipts, err = renameReceipts(cfg.ReceiptDir(), replacer); err != nil {
		return report, err
	}
	if report.Events, err = renameUnackedEvents(filepath.Join(cfg.DataDir, "events"), cfg.InstanceID, replacer); err != nil {
		return report, err
	}

	stateDir := filepath.Join(cfg.DataDir, "bps_state")
	entries, err := os.ReadDir(stateDir)
	if err != nil && !os.IsNotExist(err) {
		return report, err
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		if err := os.Remove(filepath.Join(stateDir, entry.Name())); err != nil {
			return report, err
		}
		report.BPSStateRemoved++
	}

	if report.RedisKeysRemoved, err = clearSharedState(cfg); err != nil {
		return report, err
	}
	return report, nil
}

// renameJSON 替换 JSON 文本里的旧 ID；带 payload_hash 的回执载荷重新签名。changed 为 false 时原样返回。
func renameJSON(raw []byte, replacer *strings.Replacer) (map[string]any, bool, error) {
	text := replacer.Replace(string(raw))
	if text == string(raw) {
		return nil, false, nil
	}
	decoder := json.NewDecoder(strings.NewReader(text))
	decoder.UseNumber()
	var value map[string]any
	if err := decoder.Decode(&value); err != nil {
		return nil, false, err
	}
	if _, signed := value["payload_hash"]; signed {
		resigned, _, err := signReceipt(value)
		if err != nil {
			return nil, false, err
		}
		value = resigned
	}
	return value, true, nil
}

// renameReceipts 改写未确认回执里的旧 ID 并重新计算 payload_hash。
func renameReceipts(dir string, replacer *strings.Replacer) (int, error) {
	entries, err := os.ReadDir(dir)
	if os.IsNotExist(err) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	count := 0
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		path := filepath.Join(dir, entry.Name())
		data, err := os.ReadFile(path)
		if err != nil {
			return count, err
		}
		value, changed, err := renameJSON(data, replacer)
		if err != nil {
			return count, fmt.Errorf("receipt %s: %w", entry.Name(), err)
		}
		if !changed {
			continue
		}
		// renameJSON 已按 payload_hash 重新签名
		signed, err := marshalJSON(value)
		if err != nil {
			return count, err
		}
		if err := writeFileSynced(path, append(signed, '\n')); err != nil {
			return count, err
		}
		count++
	}
	return count, nil
}

// renameUnackedEvents 改写序号大于已确认位置的事件：主题与载荷里的旧 ID 替换后重算 payload_sha256（载荷是回执时
// 先重新签回执）。按分段整体重写，序号与分段边界不变。
func renameUnackedEvents(dir, instanceID string, replacer *strings.Replacer) (int, error) {
	if _, err := os.Stat(dir); os.IsNotExist(err) {
		return 0, nil
	}
	l, err := openEventLog(dir, instanceID)
	if err != nil {
		return 0, fmt.Errorf("open event log: %w", err)
	}
	acked := l.acked
	segments, err := l.segments()
	_ = l.close()
	if err != nil {
		return 0, err
	}
	count := 0
	for i, segment := range segments {
		if i+1 < len(segments) && segments[i+1].first-1 <= acked {
			continue
		}
		data, err := os.ReadFile(segment.path)
		if err != nil {
			return count, err
		}
		lines := bytes.Split(bytes.TrimSuffix(data, []byte{'\n'}), []byte{'\n'})
		changed := false
		for n, line := range lines {
			if len(line) == 0 || replacer.Replace(string(line)) == string(line) {
				continue
			}
			var event executorEvent
			if err := json.Unmarshal(line, &event); err != nil {
				return count, fmt.Errorf("%s line %d: %w", filepath.Base(segment.path), n+1, err)
			}
			if event.Seq <= acked {
				continue
			}
			for key, value := range event.Subject {
				event.Subject[key] = replacer.Replace(value)
			}
			value, renamed, err := renameJSON(event.Payload, replacer)
			if err != nil {
				return count, fmt.Errorf("event %d: %w", event.Seq, err)
			}
			if renamed {
				if event.Payload, event.PayloadSHA256, err = canonicalPayload(value); err != nil {
					return count, err
				}
			}
			if err := event.validate(); err != nil {
				return count, fmt.Errorf("event %d after rename: %w", event.Seq, err)
			}
			if lines[n], err = marshalJSON(event); err != nil {
				return count, err
			}
			changed = true
			count++
		}
		if !changed {
			continue
		}
		out := append(bytes.Join(lines, []byte{'\n'}), '\n')
		if err := writeFileSynced(segment.path, out); err != nil {
			return count, err
		}
	}
	return count, nil
}

// clearSharedState 删除本前缀下的全部 Redis 键（所有 Worker 已停止，共享运行态可重建）。未配置 Redis 时不做任何事。
func clearSharedState(cfg Config) (int, error) {
	shared, err := newSharedState(cfg)
	if err != nil || shared == nil {
		return 0, err
	}
	defer shared.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	removed := 0
	iter := shared.client.Scan(ctx, 0, shared.prefix+"*", 500).Iterator()
	batch := make([]string, 0, 500)
	flush := func() error {
		if len(batch) == 0 {
			return nil
		}
		n, err := shared.client.Unlink(ctx, batch...).Result()
		removed += int(n)
		batch = batch[:0]
		return err
	}
	for iter.Next(ctx) {
		batch = append(batch, iter.Val())
		if len(batch) == cap(batch) {
			if err := flush(); err != nil {
				return removed, fmt.Errorf("clear redis shared state: %w", err)
			}
		}
	}
	if err := iter.Err(); err != nil {
		return removed, fmt.Errorf("scan redis shared state: %w", err)
	}
	if err := flush(); err != nil {
		return removed, fmt.Errorf("clear redis shared state: %w", err)
	}
	return removed, nil
}
