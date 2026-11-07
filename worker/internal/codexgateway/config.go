package codexgateway

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	// DisableReleaseCheck 关闭官方发布检查（release.go：OpenAI appcast、npm 与安装包）；默认开启。
	// 用于没有外网或要求封闭的环境（真实 Worker e2e，最终审计 U10a）；关闭后客户端画像用内置或已保存的版本
	DisableReleaseCheck bool   `json:"disable_release_check"`
	Listen              string `json:"listen"`
	AdvertiseURL        string `json:"advertise_url"`
	UnixSocket          string `json:"unix_socket"`
	InstanceID          string `json:"instance_id"`
	BootID              string `json:"boot_id"`
	Region              string `json:"region"`
	DataDir             string `json:"data_dir"`
	InternalToken       string `json:"internal_token"`
	CredentialBundleKey string `json:"credential_bundle_key"`
	ControlPlaneURL     string `json:"control_plane_url"`
	ControlPlaneToken   string `json:"control_plane_token"`
	UpstreamBaseURL     string `json:"upstream_base_url"`
	// LiveAPIBaseURL 是 Live sideband/hangup 的 OpenAI API 基址，默认 https://api.openai.com/v1
	LiveAPIBaseURL    string `json:"live_api_base_url"`
	UpstreamTransport string `json:"upstream_transport"`
	OAuthTokenURL     string `json:"oauth_token_url"`
	ClientID          string `json:"client_id"`
	// BPS（Excel Basispoints）账号的上游基址与 Excel OAuth 客户端（见 bps.go）
	BPSBaseURL  string `json:"bps_base_url"`
	BPSClientID string `json:"bps_client_id"`
	// BPSStreamIdleSec：BPS 流在这么久没有新数据时结束（sub2api 默认 120 秒）
	BPSStreamIdleSec    int  `json:"bps_stream_idle_seconds"`
	AllowInsecure       bool `json:"allow_insecure"`
	MaxConcurrency      int  `json:"max_concurrency"`
	AccountConcurrency  int  `json:"account_concurrency"`
	RequestTimeoutSec   int  `json:"request_timeout_seconds"`
	MaxRetryAfterSec    int  `json:"max_retry_after_seconds"`
	GuardianConcurrency int  `json:"guardian_concurrency"`
	MaxWaitingPerAcct   int  `json:"max_waiting_per_account"`
	SessionTTLHours     int  `json:"session_affinity_ttl_hours"`
	ClockSkewSec        int  `json:"clock_skew_seconds"`
	// OAuthRecoveryLog 开启 OAuth 恢复日志（原始令牌另存，默认关闭）；保留天数默认 7
	OAuthRecoveryLog           bool `json:"oauth_recovery_log"`
	OAuthRecoveryRetentionDays int  `json:"oauth_recovery_retention_days"`
	// Gateway 事实直读（设计第 19 节）：FactsDB 是控制面数据库 kin.db 的路径（同机托管时由控制面补齐），
	// FactsMode 缺省 primary（账号的配置与凭据以库为准，G4 起是唯一来源）；off 只用于不接控制面的本机调试；CredentialMasterKeyFile 是控制面凭据库主密钥文件；
	// DBSecret 是控制面数据库字段加密密钥（TAPMODELS_DB_SECRET / KIN_DB_SECRET，托管时随环境继承）
	FactsDB                 string        `json:"facts_db"`
	FactsMode               string        `json:"facts_mode"`
	CredentialMasterKeyFile string        `json:"credential_master_key_file"`
	DBSecret                string        `json:"-"`
	Version                 string        `json:"version"`
	ConfigPath              string        `json:"-"`
	RequestTimeout          time.Duration `json:"-"`
	ClockSkew               time.Duration `json:"-"`
}

// instanceIDPattern：实例 ID 字符集，与控制面 instance-keys.mjs 的 INSTANCE_ID_PATTERN 相同
var instanceIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

func LoadConfig(path string) (Config, error) {
	// 先放默认值再解码：配置文件缺省时取默认，显式 0 表示关闭（与 CPR 运行设置语义相同）
	cfg := Config{GuardianConcurrency: defaultGuardianLimit, MaxWaitingPerAcct: defaultMaxWaitingPerAcct, SessionTTLHours: 24, MaxRetryAfterSec: int(defaultMaxRetryAfter / time.Second)}
	if strings.TrimSpace(path) == "" {
		return cfg, errors.New("codex gateway config path is required")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return cfg, fmt.Errorf("read codex gateway config: %w", err)
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		return cfg, fmt.Errorf("decode codex gateway config: %w", err)
	}
	cfg.applyDefaults()
	if err := cfg.Validate(); err != nil {
		return cfg, err
	}
	cfg.ConfigPath = path
	return cfg, nil
}

func ConfigFromEnv() (Config, error) {
	cfg := Config{
		Listen:                     os.Getenv("KIN_CODEX_GATEWAY_LISTEN"),
		AdvertiseURL:               os.Getenv("KIN_CODEX_GATEWAY_ADVERTISE_URL"),
		UnixSocket:                 os.Getenv("KIN_CODEX_GATEWAY_SOCKET"),
		InstanceID:                 os.Getenv("KIN_CODEX_GATEWAY_INSTANCE_ID"),
		BootID:                     os.Getenv("KIN_CODEX_GATEWAY_BOOT_ID"),
		Region:                     os.Getenv("KIN_CODEX_GATEWAY_REGION"),
		DataDir:                    os.Getenv("KIN_CODEX_GATEWAY_DATA_DIR"),
		InternalToken:              os.Getenv("KIN_CODEX_GATEWAY_INTERNAL_TOKEN"),
		CredentialBundleKey:        os.Getenv("KIN_CODEX_GATEWAY_CREDENTIAL_BUNDLE_KEY"),
		ControlPlaneURL:            os.Getenv("KIN_CODEX_GATEWAY_CONTROL_PLANE_URL"),
		ControlPlaneToken:          os.Getenv("KIN_CODEX_GATEWAY_CONTROL_PLANE_TOKEN"),
		UpstreamBaseURL:            os.Getenv("KIN_CODEX_GATEWAY_UPSTREAM_BASE_URL"),
		LiveAPIBaseURL:             os.Getenv("KIN_CODEX_GATEWAY_LIVE_API_BASE_URL"),
		UpstreamTransport:          os.Getenv("KIN_CODEX_GATEWAY_UPSTREAM_TRANSPORT"),
		OAuthTokenURL:              os.Getenv("KIN_CODEX_GATEWAY_OAUTH_TOKEN_URL"),
		ClientID:                   os.Getenv("KIN_CODEX_GATEWAY_CLIENT_ID"),
		BPSBaseURL:                 os.Getenv("KIN_CODEX_GATEWAY_BPS_BASE_URL"),
		BPSClientID:                os.Getenv("KIN_CODEX_GATEWAY_BPS_CLIENT_ID"),
		BPSStreamIdleSec:           envInt("KIN_CODEX_GATEWAY_BPS_STREAM_IDLE_SECONDS", 120),
		AllowInsecure:              envBool("KIN_CODEX_GATEWAY_ALLOW_INSECURE", false),
		Version:                    os.Getenv("KIN_CODEX_GATEWAY_VERSION"),
		MaxConcurrency:             envInt("KIN_CODEX_GATEWAY_MAX_CONCURRENCY", 64),
		AccountConcurrency:         envInt("KIN_CODEX_GATEWAY_ACCOUNT_CONCURRENCY", 4),
		RequestTimeoutSec:          envInt("KIN_CODEX_GATEWAY_REQUEST_TIMEOUT_SECONDS", 900),
		MaxRetryAfterSec:           envInt("KIN_CODEX_GATEWAY_MAX_RETRY_AFTER_SECONDS", int(defaultMaxRetryAfter/time.Second)),
		GuardianConcurrency:        envInt("KIN_CODEX_GATEWAY_GUARDIAN_CONCURRENCY", defaultGuardianLimit),
		MaxWaitingPerAcct:          envInt("KIN_CODEX_GATEWAY_MAX_WAITING_PER_ACCOUNT", defaultMaxWaitingPerAcct),
		SessionTTLHours:            envInt("KIN_CODEX_GATEWAY_SESSION_AFFINITY_TTL_HOURS", 24),
		ClockSkewSec:               envInt("KIN_CODEX_GATEWAY_CLOCK_SKEW_SECONDS", 30),
		OAuthRecoveryLog:           envBool("KIN_CODEX_GATEWAY_OAUTH_RECOVERY_LOG", false),
		OAuthRecoveryRetentionDays: envInt("KIN_CODEX_GATEWAY_OAUTH_RECOVERY_RETENTION_DAYS", 7),
		DisableReleaseCheck:        releaseCheckOff(os.Getenv("KIN_CODEX_GATEWAY_RELEASE_CHECK")),
		FactsDB:                    os.Getenv("KIN_CODEX_GATEWAY_FACTS_DB"),
		FactsMode:                  strings.ToLower(strings.TrimSpace(os.Getenv("KIN_CODEX_GATEWAY_FACTS"))),
		CredentialMasterKeyFile:    os.Getenv("KIN_CREDENTIAL_MASTER_KEY_FILE"),
		DBSecret:                   firstNonEmpty(os.Getenv("TAPMODELS_DB_SECRET"), os.Getenv("KIN_DB_SECRET")),
	}
	cfg.applyDefaults()
	return cfg, cfg.Validate()
}

func (c *Config) applyDefaults() {
	if c.Listen == "" {
		c.Listen = "127.0.0.1:8790"
	}
	if c.FactsDB != "" && c.FactsMode == "" {
		c.FactsMode = "primary"
	}
	if c.FactsDB != "" && c.CredentialMasterKeyFile == "" {
		// 与控制面 vault.mjs masterKeyFile 相同：缺省为数据库同目录的 credential-master-keys.json
		c.CredentialMasterKeyFile = filepath.Join(filepath.Dir(c.FactsDB), "credential-master-keys.json")
	}
	if c.AdvertiseURL == "" {
		c.AdvertiseURL = "http://" + c.Listen
	}
	c.InstanceID = strings.TrimSpace(c.InstanceID)
	if c.InstanceID == "" {
		c.InstanceID = "gw_" + strings.ReplaceAll(strings.ReplaceAll(c.Listen, ":", "_"), "/", "_")
	}
	if c.BootID == "" {
		c.BootID = fmt.Sprintf("boot_%d", time.Now().UnixNano())
	}
	if c.OAuthRecoveryRetentionDays <= 0 {
		c.OAuthRecoveryRetentionDays = 7
	}
	if c.DataDir == "" {
		c.DataDir = "./data/codex-gateway"
	}
	if c.UpstreamBaseURL == "" {
		c.UpstreamBaseURL = "https://chatgpt.com/backend-api/codex"
	}
	if c.UpstreamTransport != "http" {
		c.UpstreamTransport = "prefer_websocket"
	}
	if c.OAuthTokenURL == "" {
		c.OAuthTokenURL = "https://auth.openai.com/oauth/token"
	}
	if c.ClientID == "" {
		c.ClientID = "app_EMoamEEZ73f0CkXaXp7hrann"
	}
	if c.BPSBaseURL == "" {
		c.BPSBaseURL = "https://bps.openai.com/basispoints/api"
	}
	if c.BPSClientID == "" {
		c.BPSClientID = "app_fnr0pYvVwwFDocDumLG3H2Bp"
	}
	if c.BPSStreamIdleSec <= 0 {
		c.BPSStreamIdleSec = 120
	}
	// 推理请求的客户端身份与 VM 槽内 kin-codex-kernel 保持一致；上游会校验
	// originator 与 User-Agent 前缀及 version 是否匹配。
	if c.MaxConcurrency <= 0 {
		c.MaxConcurrency = 64
	}
	if c.AccountConcurrency <= 0 {
		c.AccountConcurrency = 4
	}
	if c.RequestTimeoutSec <= 0 {
		c.RequestTimeoutSec = 900
	}
	if c.ClockSkewSec <= 0 {
		c.ClockSkewSec = 30
	}
	if c.Version == "" {
		c.Version = "dev"
	}
	// 只支持与控制面同机部署（Gateway 事实直读，设计第 19 节）：内部接口是环回明文 + HMAC 签名
	if !c.AllowInsecure {
		host, _, err := net.SplitHostPort(c.Listen)
		if err == nil && (host == "127.0.0.1" || host == "::1" || host == "localhost") {
			c.AllowInsecure = true
		}
	}
	c.RequestTimeout = time.Duration(c.RequestTimeoutSec) * time.Second
	c.ClockSkew = time.Duration(c.ClockSkewSec) * time.Second
}

func (c Config) Validate() error {
	if !instanceIDPattern.MatchString(c.InstanceID) {
		return errors.New("instance_id must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
	}
	if c.FactsMode != "" && c.FactsMode != "off" && c.FactsMode != "primary" {
		return errors.New("KIN_CODEX_GATEWAY_FACTS must be off or primary")
	}
	if strings.TrimSpace(c.InternalToken) == "" {
		return errors.New("internal_token is required")
	}
	if strings.TrimSpace(c.DataDir) == "" {
		return errors.New("data_dir is required")
	}
	if !c.AllowInsecure {
		return errors.New("the Worker runs on the control-plane host only: listen on a loopback address (or set allow_insecure for a private host network)")
	}
	if strings.HasPrefix(strings.ToLower(strings.TrimSpace(c.AdvertiseURL)), "https://") {
		return errors.New("https advertise_url is not supported: the Worker runs on the control-plane host only")
	}
	if strings.TrimSpace(c.ControlPlaneURL) != "" && strings.TrimSpace(c.CredentialBundleKey) == "" {
		return errors.New("credential_bundle_key is required when control_plane_url is configured")
	}
	if c.MaxConcurrency <= 0 || c.AccountConcurrency <= 0 {
		return errors.New("concurrency limits must be positive")
	}
	return nil
}

func envInt(key string, fallback int) int {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	v, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	return v
}

// releaseCheckOff：只有明确的 off/0/false/no 关闭发布检查，其他值（含拼错）保持默认开启（U10a 复核 R5）
func releaseCheckOff(raw string) bool {
	switch strings.TrimSpace(strings.ToLower(raw)) {
	case "off", "0", "false", "no":
		return true
	}
	return false
}

func envBool(key string, fallback bool) bool {
	raw := strings.TrimSpace(strings.ToLower(os.Getenv(key)))
	if raw == "" {
		return fallback
	}
	return raw == "1" || raw == "true" || raw == "yes" || raw == "on"
}

func (c Config) AccountsPath() string { return filepath.Join(c.DataDir, "accounts.json") }
