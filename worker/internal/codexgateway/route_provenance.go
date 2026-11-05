package codexgateway

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
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
// 写入 Worker 数据目录（配置凭据包密钥时加密），重启后保留；配置 Redis（KIN_REDIS_URL）时同时写入 Redis，多实例共享（P5.4）。
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
	// shared：配置 Redis 时同时写入共享存储，本地查不到的标识再到 Redis 查（多实例共享来源锁定，P5.4）
	shared *sharedState
	// misses：Redis 也查不到的标识短暂记住，同一请求内的多次查询不重复访问 Redis（R5-12）
	misses map[string]time.Time
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
	expires := p.now().Add(provenanceTTL)
	hashed := make([]string, 0, min(len(keys), provenanceMaxKeys))
	for i, key := range keys {
		if i >= provenanceMaxKeys {
			break
		}
		id := provenanceKey(clientScope, key)
		hashed = append(hashed, id)
		p.entries[id] = provenanceEntry{Route: route, Account: account, Expires: expires}
		delete(p.misses, id)
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
	// 同步写入 Redis（在锁外）：记录发生在响应交付之后，下一轮请求落到其他实例时已能查到（R5-12）
	p.publish(hashed, route, account)
}

// publish 把新记录写入 Redis（值为 通道 \x00 账号，24 小时过期）；Redis 不可用时只留本地。
func (p *routeProvenance) publish(hashed []string, route, account string) {
	if !p.shared.usable() || len(hashed) == 0 {
		return
	}
	ctx, cancel := p.shared.opContext(context.Background())
	defer cancel()
	pipe := p.shared.client.Pipeline()
	for _, id := range hashed {
		pipe.Set(ctx, p.shared.key("prov", id), route+"\x00"+account, provenanceTTL)
	}
	_, err := pipe.Exec(ctx)
	p.shared.observe(err)
}

const provenanceMissTTL = 2 * time.Second

// resolve 返回标识（已取摘要）对应的记录：先查本地，本地没有的再到 Redis 批量查，查到的放进本地缓存。
func (p *routeProvenance) resolve(clientScope string, keys []string) map[string]provenanceEntry {
	if len(keys) > provenanceMaxKeys {
		keys = keys[:provenanceMaxKeys]
	}
	out := make(map[string]provenanceEntry, len(keys))
	var missing []string
	p.mu.Lock()
	now := p.now()
	for _, key := range keys {
		id := provenanceKey(clientScope, key)
		if entry, ok := p.entries[id]; ok && entry.Expires.After(now) {
			out[id] = entry
		} else if p.misses[id].After(now) {
			continue
		} else {
			missing = append(missing, id)
		}
	}
	p.mu.Unlock()
	if len(missing) == 0 || !p.shared.usable() {
		return out
	}
	ctx, cancel := p.shared.opContext(context.Background())
	defer cancel()
	pipe := p.shared.client.Pipeline()
	gets := make([]*redis.StringCmd, len(missing))
	ttls := make([]*redis.DurationCmd, len(missing))
	for i, id := range missing {
		key := p.shared.key("prov", id)
		gets[i] = pipe.Get(ctx, key)
		ttls[i] = pipe.PTTL(ctx, key)
	}
	// 逐条检查：管道返回的是第一条命令的错误，前一条“不存在”会掩盖后面的网络错误（R5 复核 N2）
	_, _ = pipe.Exec(ctx)
	for i := range missing {
		for _, cmdErr := range []error{gets[i].Err(), ttls[i].Err()} {
			if cmdErr != nil && !errors.Is(cmdErr, redis.Nil) {
				p.shared.observe(cmdErr)
				return out
			}
		}
	}
	p.shared.observe(nil)
	p.mu.Lock()
	defer p.mu.Unlock()
	now = p.now()
	if p.misses == nil {
		p.misses = map[string]time.Time{}
	}
	for i, id := range missing {
		raw := gets[i].Val()
		if raw == "" {
			p.misses[id] = now.Add(provenanceMissTTL)
			continue
		}
		route, account, _ := strings.Cut(raw, "\x00")
		// 按 Redis 剩余有效期缓存，不重新给 24 小时；本地已满时只返回不缓存（R5-12）
		ttl := ttls[i].Val()
		if ttl <= 0 || ttl > provenanceTTL {
			ttl = provenanceTTL
		}
		entry := provenanceEntry{Route: route, Account: account, Expires: now.Add(ttl)}
		out[id] = entry
		if len(p.entries) < provenanceMaxEntries {
			p.entries[id] = entry
		}
	}
	for id, until := range p.misses {
		if !until.After(now) {
			delete(p.misses, id)
		}
	}
	return out
}

// lookup 返回历史标识对应的通道集合（未知的不计入）。
func (p *routeProvenance) lookup(clientScope string, keys []string) map[string]bool {
	routes := map[string]bool{}
	if p == nil {
		return routes
	}
	for _, entry := range p.resolve(clientScope, keys) {
		routes[entry.Route] = true
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
	if len(keys) > provenanceMaxKeys {
		keys = keys[:provenanceMaxKeys]
	}
	entries := p.resolve(clientScope, keys)
	for i := len(keys) - 1; i >= 0; i-- {
		if !strings.HasPrefix(keys[i], "enc:") {
			continue
		}
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
