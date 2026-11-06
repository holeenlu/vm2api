package codexgateway

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite" // 纯 Go 驱动：镜像 CGO_ENABLED=0
)

// Gateway 事实直读（设计第 19 节）：Worker 同机以只读方式直读控制面 SQLite（kin.db）里的账号事实。
// 只读迁移 124 定义的视图 gateway_account_facts_v1（读取契约），不读其他表、不写库。
// 变更感知：同一条连接上轮询 PRAGMA data_version，变化后在一个短读事务里按事实版本增量读取；
// 解密放在事务外，读事务不能挡住控制面的 WAL checkpoint。每 10 分钟全量对账一次。
// 读到的事实合并进账号表（facts_apply.go），配置、分组与凭据以库为准；G4 起控制面不再推送投影。

const (
	factsContractMin   = 1
	factsContractMax   = 1
	factsPollInterval  = 500 * time.Millisecond
	factsFullReconcile = 10 * time.Minute
)

// FactCredential 是凭据库里一类授权（原生或 BPS）的令牌与代次。
type FactCredential struct {
	Revision     int64
	AccessToken  string
	RefreshToken string
	IDToken      string
	APIKey       string
	ExpiresAt    string
	Fingerprint  string
}

// AccountFacts 是一个 Gateway 账号在控制面的事实（已解密）。
type AccountFacts struct {
	ResourceID       string
	RuntimeID        string
	VendorID         string
	Name             string
	Status           string
	Archived         bool
	Deleted          bool
	Email            string
	Plan             string
	ChatGPTAccountID string
	MaxConcurrency   int
	MaxRPM           int
	Weight           int
	Models           []string
	DeniedModels     []string
	ResetCreditAuto  bool
	BPSSettings      *BPSSettings
	BPSGrantRevision int64
	InstallationID   string
	ProxyID          string
	ProxyURL         string
	ProxyMaxWS       int
	RequestLocation  *RequestLocation
	Groups           []string
	Native           *FactCredential
	BPS              *FactCredential
	FactRevision     int64
	// Errors 是该账号读不出的部分（主密钥缺失、密文校验失败等）；有错误的账号不能以库为准调度
	Errors []string
}

// Schedulable 是账号在控制面的启停：只有 active 才接单（与投影的 enabled/paused 同一口径）。
func (f AccountFacts) Schedulable() bool { return f.Status == "active" && !f.Archived && !f.Deleted }

// factsRow 是视图的一行原始值（事务内只做扫描，解密在事务外）。
type factsRow map[string]any

// FactsReader 持有最近一次完好的事实快照；读失败时保留上一份快照并记录错误。
type FactsReader struct {
	db      *sql.DB
	keyring *factsKeyring
	secret  string

	mu          sync.RWMutex
	accounts    map[string]AccountFacts // 按资源 ID
	seq         int64
	contract    int
	dataVersion int64
	loadedAt    time.Time
	fullAt      time.Time
	lastErr     string
	loads       int64
	// onChange 在快照更新后调用（primary 模式把事实合并进账号表）；在读取循环里同步执行
	onChange func(map[string]AccountFacts)
}

// OpenFactsReader 以只读方式打开 kin.db（mode=ro + query_only），不执行任何迁移。
func OpenFactsReader(path, keyFile, secret string) (*FactsReader, error) {
	if strings.TrimSpace(path) == "" {
		return nil, errors.New("facts database path is required")
	}
	dsn := "file:" + (&url.URL{Path: path}).EscapedPath() + "?mode=ro&_pragma=busy_timeout(5000)&_pragma=query_only(1)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	// 固定一条连接：PRAGMA data_version 只在同一条连接上可比较
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(0)
	db.SetConnMaxIdleTime(0)
	return &FactsReader{db: db, keyring: newFactsKeyring(keyFile), secret: secret, accounts: map[string]AccountFacts{}}, nil
}

func (r *FactsReader) Close() error { return r.db.Close() }

// Run 轮询事实变化直到 ctx 结束。
func (r *FactsReader) Run(ctx context.Context) {
	if err := r.Refresh(ctx, true); err != nil {
		log.Printf("codex-gateway: facts initial load failed: %v", err)
	}
	ticker := time.NewTicker(factsPollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			_ = r.Close()
			return
		case <-ticker.C:
			r.mu.RLock()
			full := time.Since(r.fullAt) >= factsFullReconcile
			r.mu.RUnlock()
			_ = r.Refresh(ctx, full)
		}
	}
}

// Refresh 读取变化（full 为真时全量）。没有变化时只执行一次 PRAGMA data_version。
func (r *FactsReader) Refresh(ctx context.Context, full bool) error {
	err := r.refresh(ctx, full)
	r.mu.Lock()
	if err != nil {
		r.lastErr = err.Error()
	} else {
		r.lastErr = ""
	}
	r.mu.Unlock()
	return err
}

func (r *FactsReader) refresh(ctx context.Context, full bool) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	var version int64
	if err := r.db.QueryRowContext(ctx, "PRAGMA data_version").Scan(&version); err != nil {
		return fmt.Errorf("facts data_version: %w", err)
	}
	r.mu.RLock()
	unchanged := !full && r.loads > 0 && version == r.dataVersion
	lastSeq := r.seq
	r.mu.RUnlock()
	if unchanged {
		return nil
	}
	contract, seq, rows, changed, err := r.read(ctx, full, lastSeq)
	if err != nil {
		return err
	}
	if contract < factsContractMin || contract > factsContractMax {
		return fmt.Errorf("facts contract version %d is outside the supported range %d-%d", contract, factsContractMin, factsContractMax)
	}
	decoded := make(map[string]AccountFacts, len(rows))
	for _, row := range rows {
		facts := r.decode(row)
		decoded[facts.ResourceID] = facts
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if full {
		r.accounts = decoded
		r.fullAt = time.Now()
	} else {
		for _, id := range changed {
			if facts, ok := decoded[id]; ok {
				r.accounts[id] = facts
			} else {
				delete(r.accounts, id) // 视图里已没有（物理删除或不再是 Gateway 账号）
			}
		}
	}
	r.seq, r.contract, r.dataVersion, r.loadedAt = seq, contract, version, time.Now()
	r.loads++
	if r.onChange != nil && (full || len(changed) > 0) {
		snapshot := make(map[string]AccountFacts, len(r.accounts))
		for id, facts := range r.accounts {
			snapshot[id] = facts
		}
		r.mu.Unlock()
		r.onChange(snapshot)
		r.mu.Lock()
	}
	return nil
}

// read 在一个只读事务里读契约版本、事实序列与（变化的）账号行；只扫描，不解密。
func (r *FactsReader) read(ctx context.Context, full bool, lastSeq int64) (int, int64, []factsRow, []string, error) {
	tx, err := r.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return 0, 0, nil, nil, err
	}
	defer func() { _ = tx.Rollback() }()
	var contract int
	if err := tx.QueryRowContext(ctx, "SELECT version FROM gateway_fact_contract WHERE id=1").Scan(&contract); err != nil {
		return 0, 0, nil, nil, fmt.Errorf("facts contract: %w", err)
	}
	var seq int64
	if err := tx.QueryRowContext(ctx, "SELECT value FROM gateway_fact_seq WHERE id=1").Scan(&seq); err != nil {
		return 0, 0, nil, nil, fmt.Errorf("facts seq: %w", err)
	}
	var changed []string
	query := "SELECT * FROM gateway_account_facts_v1"
	args := []any{}
	if !full {
		if seq == lastSeq {
			return contract, seq, nil, nil, tx.Commit()
		}
		ids, err := tx.QueryContext(ctx, "SELECT account_resource_id FROM gateway_account_fact_revisions WHERE revision > ?", lastSeq)
		if err != nil {
			return 0, 0, nil, nil, err
		}
		for ids.Next() {
			var id string
			if err := ids.Scan(&id); err != nil {
				_ = ids.Close()
				return 0, 0, nil, nil, err
			}
			changed = append(changed, id)
		}
		if err := ids.Close(); err != nil {
			return 0, 0, nil, nil, err
		}
		if len(changed) == 0 {
			return contract, seq, nil, nil, tx.Commit()
		}
		query += " WHERE account_resource_id IN (SELECT account_resource_id FROM gateway_account_fact_revisions WHERE revision > ?)"
		args = append(args, lastSeq)
	}
	rows, err := tx.QueryContext(ctx, query, args...)
	if err != nil {
		return 0, 0, nil, nil, fmt.Errorf("facts view: %w", err)
	}
	defer rows.Close()
	columns, err := rows.Columns()
	if err != nil {
		return 0, 0, nil, nil, err
	}
	var out []factsRow
	for rows.Next() {
		values := make([]any, len(columns))
		pointers := make([]any, len(columns))
		for i := range values {
			pointers[i] = &values[i]
		}
		if err := rows.Scan(pointers...); err != nil {
			return 0, 0, nil, nil, err
		}
		row := make(factsRow, len(columns))
		for i, name := range columns {
			if b, ok := values[i].([]byte); ok {
				row[name] = string(b)
			} else {
				row[name] = values[i]
			}
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return 0, 0, nil, nil, err
	}
	if err := rows.Close(); err != nil {
		return 0, 0, nil, nil, err
	}
	return contract, seq, out, changed, tx.Commit()
}

func (row factsRow) str(name string) string {
	switch value := row[name].(type) {
	case nil:
		return ""
	case string:
		return value
	case int64:
		return strconv.FormatInt(value, 10)
	case float64:
		return strconv.FormatFloat(value, 'f', -1, 64)
	default:
		return fmt.Sprint(value)
	}
}

func (row factsRow) int(name string) (int64, bool) {
	switch value := row[name].(type) {
	case int64:
		return value, true
	case float64:
		return int64(value), true
	case string:
		n, err := strconv.ParseInt(value, 10, 64)
		return n, err == nil
	default:
		return 0, false
	}
}

// decode 把一行原始值转成事实：口径与控制面账号配置一致（缺省并发 4、权重 1）。
func (r *FactsReader) decode(row factsRow) AccountFacts {
	f := AccountFacts{
		ResourceID:       row.str("account_resource_id"),
		RuntimeID:        row.str("runtime_account_id"),
		VendorID:         row.str("vendor_id"),
		Name:             row.str("name"),
		Status:           row.str("status"),
		Archived:         row.str("archived_at") != "",
		Deleted:          row.str("deleted_at") != "",
		Email:            row.str("email"),
		Plan:             row.str("plan"),
		ChatGPTAccountID: row.str("chatgpt_account_id"),
		InstallationID:   row.str("installation_id"),
		ProxyID:          row.str("proxy_id"),
	}
	if f.RuntimeID == "" {
		f.Errors = append(f.Errors, "runtime_account_id_missing")
	}
	if n, ok := row.int("max_concurrency"); ok && n > 0 {
		f.MaxConcurrency = int(n)
	} else {
		f.MaxConcurrency = 4
	}
	if n, ok := row.int("max_rpm"); ok && n > 0 {
		f.MaxRPM = int(n)
	}
	if n, ok := row.int("weight"); ok && n > 0 {
		f.Weight = int(n)
	} else {
		f.Weight = 1
	}
	var access struct {
		Mode   string   `json:"mode"`
		Models []string `json:"models"`
	}
	if raw := row.str("model_access_json"); raw != "" && json.Unmarshal([]byte(raw), &access) == nil {
		switch access.Mode {
		case "allowlist":
			f.Models = access.Models
		case "denylist":
			f.DeniedModels = access.Models
		}
	}
	if n, ok := row.int("reset_credit_auto"); ok && n != 0 {
		f.ResetCreditAuto = true
	}
	if raw := row.str("bps_settings_json"); raw != "" {
		var settings BPSSettings
		if json.Unmarshal([]byte(raw), &settings) == nil {
			// 与 gatewayBpsProjection 相同的缺省：恢复间隔 1 分钟、429 冷却 5 秒
			if settings.RecoveryIntervalMinutes == 0 {
				settings.RecoveryIntervalMinutes = 1
			}
			if settings.RateLimitCooldownSeconds == 0 {
				settings.RateLimitCooldownSeconds = 5
			}
			if settings.Models == nil {
				settings.Models = []string{}
			}
			f.BPSSettings = &settings
		} else {
			f.Errors = append(f.Errors, "bps_settings_invalid")
		}
	}
	if n, ok := row.int("bps_grant_revision"); ok {
		f.BPSGrantRevision = n
	}
	if n, ok := row.int("proxy_max_websocket_connections"); ok && n > 0 {
		f.ProxyMaxWS = int(n)
	}
	f.RequestLocation = proxyRequestLocation(row)
	var groups []int64
	if raw := row.str("group_ids_json"); raw != "" && json.Unmarshal([]byte(raw), &groups) == nil {
		sort.Slice(groups, func(i, j int) bool { return groups[i] < groups[j] })
		for _, id := range groups {
			f.Groups = append(f.Groups, strconv.FormatInt(id, 10))
		}
	}
	if n, ok := row.int("fact_revision"); ok {
		f.FactRevision = n
	}
	if secret := row.str("secret_json"); secret != "" {
		plain, err := decryptDBField(secret, r.secret)
		if err != nil {
			f.Errors = append(f.Errors, "secret_unreadable")
		} else {
			var parsed struct {
				ProxyURL string `json:"proxy_url"`
			}
			if json.Unmarshal([]byte(plain), &parsed) == nil {
				f.ProxyURL = parsed.ProxyURL
			}
		}
	}
	f.Native = r.credential(row, &f, "native")
	f.BPS = r.credential(row, &f, "bps")
	return f
}

func (r *FactsReader) credential(row factsRow, f *AccountFacts, grant string) *FactCredential {
	revision, ok := row.int(grant + "_revision")
	if !ok || revision <= 0 {
		return nil
	}
	secrets, err := openVaultRecord(r.keyring, f.ResourceID, grant, revision, row.str(grant+"_master_key_id"), row.str(grant+"_wrapped_key"), row.str(grant+"_ciphertext"))
	if err != nil {
		code := grant + "_credential_unreadable"
		if errors.Is(err, errMasterKeyMissing) || errors.Is(err, errMasterKeyFile) {
			code = grant + "_master_key_missing"
		}
		f.Errors = append(f.Errors, code)
		return nil
	}
	cred := &FactCredential{Revision: revision, AccessToken: secrets.AccessToken, RefreshToken: secrets.RefreshToken, IDToken: secrets.IDToken, APIKey: secrets.APIKey, ExpiresAt: row.str(grant + "_expires_at")}
	if grant == "native" {
		cred.Fingerprint = row.str("native_fingerprint")
	}
	return cred
}

// proxyRequestLocation 与控制面 request-location.mjs 的 proxyRequestLocation 一致：manual 用手动字段；
// auto 用代理池探测的出口（IPv4 与 IPv6 时区冲突时撤销）；inherit 或信息不完整时为空（账号回退全局位置）。
func proxyRequestLocation(row factsRow) *RequestLocation {
	detected := func(country, region, city, timezone string) *RequestLocation {
		location, err := RequestLocation{Country: row.str(country), Region: row.str(region), City: row.str(city), Timezone: row.str(timezone)}.normalized()
		if err != nil {
			return nil
		}
		return &location
	}
	switch row.str("proxy_request_location_mode") {
	case "manual":
		return detected("proxy_location_country", "proxy_location_region", "proxy_location_city", "proxy_location_timezone")
	case "auto":
		v4 := detected("proxy_geo_country_code", "proxy_geo_region", "proxy_geo_city", "proxy_geo_timezone")
		v6 := detected("proxy_geo_v6_country_code", "proxy_geo_v6_region", "proxy_geo_v6_city", "proxy_geo_v6_timezone")
		if v4 != nil && v6 != nil && v4.Timezone != v6.Timezone {
			return nil
		}
		if v4 != nil {
			return v4
		}
		return v6
	}
	return nil
}

// FactsStatus 是读取器的运行状态（健康接口与心跳）。
type FactsStatus struct {
	Contract   int    `json:"contract"`
	Seq        int64  `json:"seq"`
	Accounts   int    `json:"accounts"`
	WithErrors int    `json:"with_errors"`
	LoadedAt   string `json:"loaded_at,omitempty"`
	LastError  string `json:"last_error,omitempty"`
}

// Snapshot 返回事实快照的拷贝与状态。
func (r *FactsReader) Snapshot() (map[string]AccountFacts, FactsStatus) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make(map[string]AccountFacts, len(r.accounts))
	status := FactsStatus{Contract: r.contract, Seq: r.seq, Accounts: len(r.accounts), LastError: r.lastErr}
	for id, facts := range r.accounts {
		out[id] = facts
		if len(facts.Errors) > 0 {
			status.WithErrors++
		}
	}
	if !r.loadedAt.IsZero() {
		status.LoadedAt = r.loadedAt.UTC().Format(time.RFC3339)
	}
	return out, status
}
