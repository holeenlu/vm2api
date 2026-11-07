package codexgateway

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// 审计阶段 2 W7：账号表原子写落盘、nonce 去重按分钟清理。

func TestWriteFileAtomicReplacesTheFileWithoutLeavingTheTemporaryCopy(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "accounts.json")
	if err := os.WriteFile(path, []byte("old\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := writeFileAtomic(path, []byte("new\n")); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(path)
	if err != nil || string(got) != "new\n" {
		t.Fatalf("content = %q, %v", got, err)
	}
	if _, err := os.Stat(path + ".tmp"); !os.IsNotExist(err) {
		t.Fatalf("temporary file left behind: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %v, %v", info.Mode(), err)
	}
	// 目标目录不存在时报错，不留下半成品
	if err := writeFileAtomic(filepath.Join(dir, "missing", "x.json"), []byte("x")); err == nil {
		t.Fatal("expected an error for a missing directory")
	}
}

func TestSeenNonceRejectsReplaysAndExpiresOldEntriesWithoutPerRequestScans(t *testing.T) {
	s := &Server{nonces: map[string]time.Time{}}
	if s.seenNonce("a") {
		t.Fatal("first use must not be a replay")
	}
	if !s.seenNonce("a") {
		t.Fatal("second use must be a replay")
	}
	// 过期的 nonce 即使还没被清理也不算重放；到清理周期时从表中删除
	s.mu.Lock()
	s.nonces["old"] = time.Now().Add(-nonceTTL - time.Second)
	s.noncesSweptAt = time.Now()
	s.mu.Unlock()
	if s.seenNonce("old") {
		t.Fatal("an expired nonce must not count as a replay")
	}
	s.mu.Lock()
	s.nonces["stale"] = time.Now().Add(-nonceTTL - time.Second)
	s.noncesSweptAt = time.Now().Add(-nonceSweepInterval)
	s.mu.Unlock()
	s.seenNonce("fresh")
	s.mu.Lock()
	_, kept := s.nonces["stale"]
	s.mu.Unlock()
	if kept {
		t.Fatal("expired nonces are removed on the next sweep")
	}
}
