package codexgateway

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/dofastted/kin-gateway/worker/internal/basispoints"
)

// BPS 工具回放与会话目录的跨重启存储（basispoints.StateStore）：进程内保存、延迟落盘到数据目录，
// 配置了凭据包密钥时与账号库同样加密。按 账号/调用方/会话/授权代次 的 scope 隔离，空闲 2 小时过期，
// 单条不超过 MaxStateEntryBytes、合计不超过 MaxStateBytes（超出时先淘汰最早过期的条目）。
//
// 落盘按条目分文件（目录下 <sha256(key)>.json）：每次只写有变动的条目、删除已移除条目的文件；
// 只读续期不重写内容，只更新文件修改时间，重启时过期时间取 max(记录值, 修改时间+TTL)。
// 早期版本把全部条目整写进单个 bps_state.json，满载约 60 MB，每 2 秒重写一次，持续写盘约 18 MB/s。
const (
	bpsStateTTL        = 2 * time.Hour
	bpsStateFlushDelay = 2 * time.Second
)

type bpsDiskEntry struct {
	Data    []byte    `json:"data"`
	Version uint64    `json:"version"`
	Expires time.Time `json:"expires"`
}

// bpsDiskFile 为单个条目文件的内容（加密前）。
type bpsDiskFile struct {
	Key string `json:"key"`
	bpsDiskEntry
}

type bpsDiskState struct {
	mu      sync.Mutex
	flushMu sync.Mutex // 串行化落盘，避免并发 Flush 以旧内容覆盖新内容
	dir     string
	store   *Store
	entries map[string]*bpsDiskEntry
	dirty   map[string]bool // 需要重写（或已移除需删除文件）的条目
	touched map[string]bool // 只读续期、只需更新修改时间的条目
	bytes   int
	timer   *time.Timer
	now     func() time.Time
}

func newBPSDiskState(dir string, store *Store) *bpsDiskState {
	state := &bpsDiskState{
		dir: dir, store: store, now: time.Now,
		entries: map[string]*bpsDiskEntry{}, dirty: map[string]bool{}, touched: map[string]bool{},
	}
	state.load()
	return state
}

func bpsStateKey(scope, name string) string { return scope + "\x00" + name }

func (d *bpsDiskState) fileFor(key string) string {
	sum := sha256.Sum256([]byte(key))
	return filepath.Join(d.dir, hex.EncodeToString(sum[:])+".json")
}

func (d *bpsDiskState) decode(data []byte) ([]byte, error) {
	if bytes.HasPrefix(data, []byte(accountStoreSealPrefix)) {
		if d.store == nil {
			return nil, errors.New("sealed bps state without store")
		}
		return d.store.open(data)
	}
	return data, nil
}

func (d *bpsDiskState) load() {
	files, err := os.ReadDir(d.dir)
	if err != nil {
		return
	}
	now := d.now()
	for _, file := range files {
		path := filepath.Join(d.dir, file.Name())
		if file.IsDir() {
			continue
		}
		if !strings.HasSuffix(file.Name(), ".json") {
			// 中断落盘留下的临时文件
			_ = os.Remove(path)
			continue
		}
		var record bpsDiskFile
		data, err := os.ReadFile(path)
		if err == nil {
			data, err = d.decode(data)
		}
		if err == nil {
			err = json.Unmarshal(data, &record)
		}
		// 无法解密、损坏或文件名与键不符：协议状态可丢，直接删除
		if err != nil || record.Key == "" || d.fileFor(record.Key) != path {
			_ = os.Remove(path)
			continue
		}
		if info, err := file.Info(); err == nil {
			if touched := info.ModTime().Add(bpsStateTTL); touched.After(record.Expires) {
				record.Expires = touched
			}
		}
		if !record.Expires.After(now) || len(record.Data) > basispoints.MaxStateEntryBytes {
			_ = os.Remove(path)
			continue
		}
		entry := record.bpsDiskEntry
		d.entries[record.Key] = &entry
		d.bytes += len(entry.Data)
	}
	d.evictLocked("")
}

// importLegacy 迁入早期单文件格式（bps_state.json）的条目并删除该文件。
// 兼容依据：已部署实例数据目录里仍有该文件；所有实例运行过本版本一次后即可删除本函数与调用。
func (d *bpsDiskState) importLegacy(path string) error {
	_ = os.Remove(path + ".tmp")
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err == nil {
		data, err = d.decode(data)
	}
	var legacy map[string]*bpsDiskEntry
	if err == nil && len(data) > 0 {
		err = json.Unmarshal(data, &legacy)
	}
	if err == nil {
		d.mu.Lock()
		now := d.now()
		for key, entry := range legacy {
			if entry == nil || !entry.Expires.After(now) || len(entry.Data) > basispoints.MaxStateEntryBytes || d.entries[key] != nil {
				continue
			}
			d.entries[key] = entry
			d.bytes += len(entry.Data)
			d.dirty[key] = true
		}
		d.evictLocked("")
		d.mu.Unlock()
		if err := d.Flush(); err != nil {
			return err
		}
	}
	// 无法读取或解密的旧文件同样丢弃（协议状态可丢）
	return os.Remove(path)
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
		d.scheduleLocked()
		return nil, 0, nil
	}
	entry.Expires = now.Add(bpsStateTTL)
	if !d.dirty[key] {
		d.touched[key] = true
		d.scheduleLocked()
	}
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
	d.dirty[key] = true
	delete(d.touched, key)
	d.evictLocked(key)
	d.scheduleLocked()
	return true, nil
}

// evictLocked 合计超出上限时淘汰最早过期的条目（keep 为刚写入、不参与淘汰的条目）。
func (d *bpsDiskState) evictLocked(keep string) {
	for d.bytes > basispoints.MaxStateBytes {
		oldest := ""
		for candidate, entry := range d.entries {
			if candidate != keep && (oldest == "" || entry.Expires.Before(d.entries[oldest].Expires)) {
				oldest = candidate
			}
		}
		if oldest == "" {
			return
		}
		d.removeLocked(oldest)
	}
}

// removeLocked 移除条目并标记删除其文件。
func (d *bpsDiskState) removeLocked(key string) {
	if entry := d.entries[key]; entry != nil {
		d.bytes -= len(entry.Data)
		delete(d.entries, key)
		d.dirty[key] = true
		delete(d.touched, key)
	}
}

func (d *bpsDiskState) scheduleLocked() {
	if d.timer != nil {
		return
	}
	d.timer = time.AfterFunc(bpsStateFlushDelay, func() { _ = d.Flush() })
}

// Flush 落盘自上次以来变动的条目：重写有变动的条目文件（先写临时文件再原子替换），
// 删除已移除条目的文件，只读续期的条目只更新文件修改时间。失败的条目留待下次重试。
func (d *bpsDiskState) Flush() error {
	d.flushMu.Lock()
	defer d.flushMu.Unlock()
	d.mu.Lock()
	d.timer = nil
	now := d.now()
	for key, entry := range d.entries {
		if !entry.Expires.After(now) {
			d.removeLocked(key)
		}
	}
	writes := map[string]bpsDiskEntry{}
	var removes, touches []string
	for key := range d.dirty {
		if entry := d.entries[key]; entry != nil {
			writes[key] = *entry
		} else {
			removes = append(removes, key)
		}
	}
	for key := range d.touched {
		touches = append(touches, key)
	}
	d.dirty, d.touched = map[string]bool{}, map[string]bool{}
	d.mu.Unlock()

	if len(writes) == 0 && len(removes) == 0 && len(touches) == 0 {
		return nil
	}
	var failed []string
	var firstErr error
	fail := func(key string, err error) {
		failed = append(failed, key)
		if firstErr == nil {
			firstErr = err
		}
	}
	if err := os.MkdirAll(d.dir, 0o700); err != nil {
		for key := range writes {
			fail(key, err)
		}
	} else {
		for key, entry := range writes {
			if err := d.writeEntry(key, entry); err != nil {
				fail(key, err)
			}
		}
	}
	for _, key := range removes {
		if err := os.Remove(d.fileFor(key)); err != nil && !errors.Is(err, fs.ErrNotExist) {
			fail(key, err)
		}
	}
	for _, key := range touches {
		// 文件尚未写出（例如上次写入失败）时由 dirty 重试负责
		_ = os.Chtimes(d.fileFor(key), now, now)
	}
	if len(failed) > 0 {
		d.mu.Lock()
		for _, key := range failed {
			d.dirty[key] = true
		}
		d.scheduleLocked()
		d.mu.Unlock()
	}
	return firstErr
}

func (d *bpsDiskState) writeEntry(key string, entry bpsDiskEntry) error {
	data, err := json.Marshal(bpsDiskFile{Key: key, bpsDiskEntry: entry})
	if err != nil {
		return err
	}
	if d.store != nil && d.store.sealKey != nil {
		if data, err = d.store.seal(data); err != nil {
			return err
		}
	}
	tmp, err := os.CreateTemp(d.dir, ".entry-*.tmp")
	if err != nil {
		return err
	}
	_, err = tmp.Write(data)
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(tmp.Name(), d.fileFor(key))
	}
	if err != nil {
		_ = os.Remove(tmp.Name())
	}
	return err
}

// bpsCaches 返回本请求使用的回放与目录缓存：有跨重启存储时以它为准，否则用进程内缓存。
func (s *Server) bpsCaches(ctx context.Context) (*basispoints.ReplayCache, *basispoints.CatalogCache) {
	if s.bps.disk != nil {
		return basispoints.NewPersistentCaches(ctx, s.bps.disk)
	}
	return &s.bps.replay, &s.bps.catalog
}
