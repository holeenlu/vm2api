package codexgateway

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// OAuth 恢复日志（对齐 codex-proxy-rs credential/recovery_log.rs，默认关闭）：在拿到令牌之后、本地校验与
// 落库之前，把原始 access_token / refresh_token 追加到独立的 JSON 行文件，用于凭据代次 CAS 失败、
// 落盘失败等情况下找回已在上游轮换的 refresh token。文件按 UTC+8 日期分开，目录 0700、文件 0600，
// 超过保留天数的文件自动删除；这些内容不进入普通日志、Receipt 或控制面。
const oauthRecoveryDirName = "oauth-recovery"

type oauthRecoveryLog struct {
	mu            sync.Mutex
	dir           string
	enabled       bool
	retentionDays int
	lastPrune     string
}

func newOAuthRecoveryLog(cfg Config) *oauthRecoveryLog {
	return &oauthRecoveryLog{dir: filepath.Join(cfg.DataDir, oauthRecoveryDirName), enabled: cfg.OAuthRecoveryLog, retentionDays: cfg.OAuthRecoveryRetentionDays}
}

func (l *oauthRecoveryLog) record(operation, accountID, accessToken, refreshToken string, now time.Time) {
	if l == nil || !l.enabled || (accessToken == "" && refreshToken == "") {
		return
	}
	line, _ := json.Marshal(map[string]any{
		"ts": now.UTC().Format(time.RFC3339Nano), "event": "oauth_token_received", "provider": "openai",
		"operation": operation, "account_id": accountID,
		"access_token": accessToken, "refresh_token": refreshToken, "has_refresh_token": refreshToken != "",
	})
	day := now.In(systemZone).Format("2006-01-02")
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := os.MkdirAll(l.dir, 0o700); err != nil {
		return
	}
	path := filepath.Join(l.dir, "oauth-recovery."+day+".log")
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	_, _ = file.Write(append(line, '\n'))
	_ = file.Sync()
	_ = file.Close()
	if l.lastPrune != day {
		l.lastPrune = day
		l.pruneLocked(now)
	}
}

// pruneLocked 删除早于保留天数的日志文件。
func (l *oauthRecoveryLog) pruneLocked(now time.Time) {
	entries, err := os.ReadDir(l.dir)
	if err != nil {
		return
	}
	cutoff := now.In(systemZone).AddDate(0, 0, -max(l.retentionDays, 1)).Format("2006-01-02")
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasPrefix(name, "oauth-recovery.") || !strings.HasSuffix(name, ".log") {
			continue
		}
		if day := strings.TrimSuffix(strings.TrimPrefix(name, "oauth-recovery."), ".log"); day < cutoff {
			_ = os.Remove(filepath.Join(l.dir, name))
		}
	}
}

func (s *Server) recordOAuthRecovery(operation, accountID, accessToken, refreshToken string) {
	s.oauthRecovery.record(operation, accountID, accessToken, refreshToken, time.Now())
}
