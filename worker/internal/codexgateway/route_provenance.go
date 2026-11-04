package codexgateway

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// 历史来源锁定（对齐 hloolx/codex2api docs/quota-and-history-routing_CN.md）：BPS 与原生 Codex 的加密推理、
// 压缩密文与 response id 互不通用。Worker 记录每个已交付响应的 response id 与输出密文摘要由哪条通道产生；
// 下一轮请求的历史里带有这些标识时，锁定到产生它的通道，不自动切换。
//   - 历史来自 BPS：只走 BPS，BPS 不可用时直接失败（不转原生）；
//   - 历史来自原生：不走 BPS；
//   - 同时含两条通道的历史：400 codex_route_history_conflict；
//   - 带密文或 previous_response_id 但查不到来源：保持首选通道，BPS 失败后不转原生（无法证明原生能读取）。
//
// 原生通道同时记录签发账号：加密推理与压缩密文只有签发它的账号能读取，下一轮历史带有这些密文时
// 调度优先回到该账号（selectRequest.HistoryOwner，对齐 sub2api 续接归属的思路），换号会被上游以
// invalid_encrypted_content 拒绝（生产：换号后同一会话连续被拒，客户端反复重发同一段历史）。
//
// 记录只保存（调用方范围 + 标识）的 SHA-256 与通道名、账号 ID，不保存密文或内容；24 小时过期，最多 200000 条，
// 写入 Worker 数据目录（配置凭据包密钥时加密），重启后保留；多实例之间不共享。
const (
	routeNative = "native"
	routeBPS    = "bps"

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

// record 记录一批标识（resp:<id> / enc:<摘要>）来自哪条通道。
func (p *routeProvenance) record(clientScope, route string, keys []string) {
	p.recordOwned(clientScope, route, "", keys)
}

// recordOwned 同 record，并记下签发这些标识的账号（原生通道）。
func (p *routeProvenance) recordOwned(clientScope, route, account string, keys []string) {
	if p == nil || len(keys) == 0 {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
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
}

// lookup 返回历史标识对应的通道集合（未知的不计入）。
func (p *routeProvenance) lookup(clientScope string, keys []string) map[string]bool {
	routes := map[string]bool{}
	if p == nil {
		return routes
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	now := p.now()
	for i, key := range keys {
		if i >= provenanceMaxKeys {
			break
		}
		if entry, ok := p.entries[provenanceKey(clientScope, key)]; ok && entry.Expires.After(now) {
			routes[entry.Route] = true
		}
	}
	return routes
}

// owner 返回历史里最新一段已知原生密文的签发账号：历史按时间顺序排列，最近一轮的密文最需要可读，
// 更早轮次若来自其他账号，由密文被拒恢复（encrypted_history_recovery.go）处理。只看 enc: 标识，
// previous_response_id 由续接逻辑钉住原账号。
func (p *routeProvenance) owner(clientScope string, keys []string) string {
	if p == nil {
		return ""
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	now := p.now()
	if len(keys) > provenanceMaxKeys {
		keys = keys[:provenanceMaxKeys]
	}
	for i := len(keys) - 1; i >= 0; i-- {
		if !strings.HasPrefix(keys[i], "enc:") {
			continue
		}
		entry, ok := p.entries[provenanceKey(clientScope, keys[i])]
		if ok && entry.Expires.After(now) && entry.Route == routeNative && entry.Account != "" {
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

// historyKeys 返回请求历史里无法跨通道重放的标识：previous_response_id 与各项密文摘要。
func historyKeys(body []byte) []string {
	if !bytes.Contains(body, []byte("encrypted_content")) && !bytes.Contains(body, []byte("previous_response_id")) {
		return nil
	}
	var root struct {
		PreviousResponseID string           `json:"previous_response_id"`
		Input              []map[string]any `json:"input"`
	}
	if json.Unmarshal(body, &root) != nil {
		return nil
	}
	var keys []string
	if root.PreviousResponseID != "" {
		keys = append(keys, "resp:"+root.PreviousResponseID)
	}
	for _, item := range root.Input {
		collectEncrypted(item, func(key string) { keys = append(keys, key) })
	}
	return keys
}
