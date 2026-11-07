package codexgateway

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// 原生密文签发账号记录：加密推理、压缩与输出回放密文只有签发它的账号能读取。Worker 记录每个已交付原生响应的
// 输出密文摘要由哪个账号签发；下一轮历史带有这些密文时，原生选号优先回到该账号（selectRequest.HistoryOwner，
// 对齐 sub2api 续接归属的思路），换号会被上游以 invalid_encrypted_content 拒绝（生产：换号后同一会话连续被拒，
// 客户端反复重发同一段历史）。
//
// 历史来源不决定通道（对齐 sub2api，2026-11-05 取代 codex2api 的“历史来源锁定”）：原生与 BPS 可互相承接对方
// 产生的历史，读不了的密文在生成前被拒后由 encrypted_history_recovery.go 在同一账号缩减重发。BPS 输出不记录。
//
// 记录只保存（调用方范围 + 密文）的 SHA-256 与通道名、账号 ID，不保存密文或内容；24 小时过期，最多 200000 条，
// 写入 Worker 数据目录（配置凭据包密钥时加密），重启后保留（只支持同机单个 Worker，Redis 共享于 2026-11-07 S3 删除）。
// 升级前写入的 BPS 与 response id 记录不再被读取，24 小时内自然过期。
const (
	routeNative = "native"

	// Key 级通道策略（SchedulingPolicy.RoutePolicy）
	routePolicyNativeOnly = "native_only"
	routePolicyBPSOnly    = "bps_only"

	provenanceTTL        = 24 * time.Hour
	provenanceMaxEntries = 200000
	provenanceMaxKeys    = 1024
	provenanceFlushDelay = 2 * time.Second
)

type provenanceEntry struct {
	Route   string    `json:"r"`
	Account string    `json:"a,omitempty"`
	Expires time.Time `json:"e"`
}

type routeProvenance struct {
	mu      sync.Mutex
	path    string
	store   *Store
	entries map[string]provenanceEntry
	timer   *time.Timer
	now     func() time.Time
}

func newRouteProvenance(path string, store *Store) *routeProvenance {
	p := &routeProvenance{path: path, store: store, entries: map[string]provenanceEntry{}, now: time.Now}
	data, err := os.ReadFile(path)
	if err == nil && len(data) > 0 {
		if bytes.HasPrefix(data, []byte(accountStoreSealPrefix)) && store != nil {
			data, err = store.open(data)
		}
		var entries map[string]provenanceEntry
		if err == nil && json.Unmarshal(data, &entries) == nil {
			now := p.now()
			for key, entry := range entries {
				if entry.Expires.After(now) {
					p.entries[key] = entry
				}
			}
		}
	}
	return p
}

func provenanceKey(clientScope, key string) string {
	sum := sha256.Sum256([]byte(clientScope + "\x00" + key))
	return hex.EncodeToString(sum[:16])
}

// recordOwned 记录一批原生输出密文（enc:<摘要>）及签发它们的账号。
func (p *routeProvenance) recordOwned(clientScope, route, account string, keys []string) {
	if p == nil || len(keys) == 0 {
		return
	}
	p.mu.Lock()
	expires := p.now().Add(provenanceTTL)
	for i, key := range keys {
		if i >= provenanceMaxKeys {
			break
		}
		p.entries[provenanceKey(clientScope, key)] = provenanceEntry{Route: route, Account: account, Expires: expires}
	}
	if len(p.entries) > provenanceMaxEntries {
		now := p.now()
		for key, entry := range p.entries {
			if !entry.Expires.After(now) || len(p.entries) > provenanceMaxEntries {
				delete(p.entries, key)
			}
			if len(p.entries) <= provenanceMaxEntries*9/10 {
				break
			}
		}
	}
	if p.timer == nil {
		p.timer = time.AfterFunc(provenanceFlushDelay, func() { _ = p.Flush() })
	}
	p.mu.Unlock()
}

// resolve 返回标识（已取摘要）对应的本地记录。
func (p *routeProvenance) resolve(clientScope string, keys []string) map[string]provenanceEntry {
	if len(keys) > provenanceMaxKeys {
		keys = keys[:provenanceMaxKeys]
	}
	out := make(map[string]provenanceEntry, len(keys))
	p.mu.Lock()
	defer p.mu.Unlock()
	now := p.now()
	for _, key := range keys {
		id := provenanceKey(clientScope, key)
		if entry, ok := p.entries[id]; ok && entry.Expires.After(now) {
			out[id] = entry
		}
	}
	return out
}

// owner 返回历史里最新一段已知原生密文的签发账号：历史按时间顺序排列，最近一轮的密文最需要可读，
// 更早轮次若来自其他账号或 BPS，由密文被拒恢复（encrypted_history_recovery.go）处理。previous_response_id
// 由续接逻辑钉住原账号。
func (p *routeProvenance) owner(clientScope string, keys []string) string {
	if p == nil {
		return ""
	}
	if len(keys) > provenanceMaxKeys {
		keys = keys[:provenanceMaxKeys]
	}
	entries := p.resolve(clientScope, keys)
	for i := len(keys) - 1; i >= 0; i-- {
		entry, ok := entries[provenanceKey(clientScope, keys[i])]
		if ok && entry.Route == routeNative && entry.Account != "" {
			return entry.Account
		}
	}
	return ""
}

func (p *routeProvenance) Flush() error {
	if p == nil {
		return nil
	}
	p.mu.Lock()
	p.timer = nil
	now := p.now()
	for key, entry := range p.entries {
		if !entry.Expires.After(now) {
			delete(p.entries, key)
		}
	}
	data, err := json.Marshal(p.entries)
	p.mu.Unlock()
	if err != nil {
		return err
	}
	if p.store != nil && p.store.sealKey != nil {
		if data, err = p.store.seal(data); err != nil {
			return err
		}
	}
	if err := os.MkdirAll(filepath.Dir(p.path), 0o700); err != nil {
		return err
	}
	tmp := p.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, p.path)
}

func encryptedKey(value string) string {
	sum := sha256.Sum256([]byte(value))
	return "enc:" + hex.EncodeToString(sum[:])
}

// collectEncrypted 收集一个输出项或历史项中的 encrypted_content（项本身与其内容块）。
func collectEncrypted(item map[string]any, add func(string)) {
	if value, ok := item["encrypted_content"].(string); ok && value != "" {
		add(encryptedKey(value))
	}
	for _, field := range []string{"content", "output"} {
		parts, _ := item[field].([]any)
		for _, raw := range parts {
			if part, ok := raw.(map[string]any); ok {
				if value, ok := part["encrypted_content"].(string); ok && value != "" {
					add(encryptedKey(value))
				}
			}
		}
	}
}

// historyKeys 返回请求历史里各项密文的摘要（enc:<摘要>）。
func historyKeys(body []byte) []string {
	if !bytes.Contains(body, []byte("encrypted_content")) {
		return nil
	}
	var root struct {
		Input []map[string]any `json:"input"`
	}
	if json.Unmarshal(body, &root) != nil {
		return nil
	}
	var keys []string
	for _, item := range root.Input {
		collectEncrypted(item, func(key string) { keys = append(keys, key) })
	}
	return keys
}
