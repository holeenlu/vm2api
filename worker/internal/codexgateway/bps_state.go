package codexgateway

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/dofastted/kin-gateway/worker/internal/basispoints"
)

// BPS 工具回放与会话目录的跨重启存储（basispoints.StateStore）：进程内保存、延迟落盘到数据目录，
// 配置了凭据包密钥时与账号库同样加密。按 账号/调用方/会话/授权代次 的 scope 隔离，空闲 2 小时过期，
// 单条不超过 MaxStateEntryBytes、合计不超过 MaxStateBytes（超出时先淘汰最早过期的条目）。
const (
	bpsStateTTL        = 2 * time.Hour
	bpsStateFlushDelay = 2 * time.Second
)

type bpsDiskEntry struct {
	Data    []byte    `json:"data"`
	Version uint64    `json:"version"`
	Expires time.Time `json:"expires"`
}

type bpsDiskState struct {
	mu      sync.Mutex
	path    string
	store   *Store
	entries map[string]*bpsDiskEntry
	bytes   int
	timer   *time.Timer
	now     func() time.Time
}

func newBPSDiskState(path string, store *Store) *bpsDiskState {
	state := &bpsDiskState{path: path, store: store, entries: map[string]*bpsDiskEntry{}, now: time.Now}
	state.load()
	return state
}

func bpsStateKey(scope, name string) string { return scope + "\x00" + name }

func (d *bpsDiskState) load() {
	data, err := os.ReadFile(d.path)
	if err != nil || len(data) == 0 {
		return
	}
	if bytes.HasPrefix(data, []byte(accountStoreSealPrefix)) {
		if data, err = d.store.open(data); err != nil {
			return
		}
	}
	var entries map[string]*bpsDiskEntry
	if json.Unmarshal(data, &entries) != nil {
		return
	}
	now := d.now()
	for key, entry := range entries {
		if entry != nil && entry.Expires.After(now) {
			d.entries[key] = entry
			d.bytes += len(entry.Data)
		}
	}
}

func (d *bpsDiskState) LoadBPSState(_ context.Context, scope, name string) ([]byte, uint64, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	key := bpsStateKey(scope, name)
	entry := d.entries[key]
	if entry == nil {
		return nil, 0, nil
	}
	now := d.now()
	if !entry.Expires.After(now) {
		d.removeLocked(key)
		return nil, 0, nil
	}
	entry.Expires = now.Add(bpsStateTTL)
	return append([]byte(nil), entry.Data...), entry.Version, nil
}

func (d *bpsDiskState) SaveBPSState(_ context.Context, scope, name string, expected *uint64, data []byte) (bool, error) {
	if len(data) > basispoints.MaxStateEntryBytes {
		return false, basispoints.ErrStateCapacity
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	key := bpsStateKey(scope, name)
	now := d.now()
	current := d.entries[key]
	if current != nil && !current.Expires.After(now) {
		d.removeLocked(key)
		current = nil
	}
	version := uint64(0)
	if current != nil {
		version = current.Version
	}
	// 目录写入比较读取时的版本（并发请求以先写者为准）
	if expected != nil && *expected != version {
		return false, nil
	}
	if current != nil {
		d.removeLocked(key)
	}
	d.entries[key] = &bpsDiskEntry{Data: append([]byte(nil), data...), Version: version + 1, Expires: now.Add(bpsStateTTL)}
	d.bytes += len(data)
	for d.bytes > basispoints.MaxStateBytes {
		oldest := ""
		for candidate, entry := range d.entries {
			if candidate != key && (oldest == "" || entry.Expires.Before(d.entries[oldest].Expires)) {
				oldest = candidate
			}
		}
		if oldest == "" {
			break
		}
		d.removeLocked(oldest)
	}
	d.scheduleLocked()
	return true, nil
}

func (d *bpsDiskState) removeLocked(key string) {
	if entry := d.entries[key]; entry != nil {
		d.bytes -= len(entry.Data)
		delete(d.entries, key)
	}
}

func (d *bpsDiskState) scheduleLocked() {
	if d.timer != nil {
		return
	}
	d.timer = time.AfterFunc(bpsStateFlushDelay, func() { _ = d.Flush() })
}

// Flush 把当前条目写入数据目录（先写临时文件再原子替换）。
func (d *bpsDiskState) Flush() error {
	d.mu.Lock()
	d.timer = nil
	now := d.now()
	for key, entry := range d.entries {
		if !entry.Expires.After(now) {
			d.removeLocked(key)
		}
	}
	data, err := json.Marshal(d.entries)
	d.mu.Unlock()
	if err != nil {
		return err
	}
	if d.store != nil && d.store.sealKey != nil {
		if data, err = d.store.seal(data); err != nil {
			return err
		}
	}
	if err := os.MkdirAll(filepath.Dir(d.path), 0o700); err != nil {
		return err
	}
	tmp := d.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, d.path)
}

// bpsCaches 返回本请求使用的回放与目录缓存：有跨重启存储时以它为准，否则用进程内缓存。
func (s *Server) bpsCaches(ctx context.Context) (*basispoints.ReplayCache, *basispoints.CatalogCache) {
	if s.bps.disk != nil {
		return basispoints.NewPersistentCaches(ctx, s.bps.disk)
	}
	return &s.bps.replay, &s.bps.catalog
}
