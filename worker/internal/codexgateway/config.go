package codexgateway

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Listen              string `json:"listen"`
	AdvertiseURL        string `json:"advertise_url"`
	UnixSocket          string `json:"unix_socket"`
	InstanceID          string `json:"instance_id"`
	BootID              string `json:"boot_id"`
	Region              string `json:"region"`
	DataDir             string `json:"data_dir"`
	InternalToken       string `json:"internal_token"`
	CredentialBundleKey string `json:"credential_bundle_key"`
	ReceiptURL          string `json:"receipt_url"`
	ReceiptToken        string `json:"receipt_token"`
	ControlPlaneURL     string `json:"control_plane_url"`
	ControlPlaneToken   string `json:"control_plane_token"`
	UpstreamBaseURL     string `json:"upstream_base_url"`
	// LiveAPIBaseURL 是 Live sideband/hangup 的 OpenAI API 基址，默认 https://api.openai.com/v1
	LiveAPIBaseURL      string `json:"live_api_base_url"`
	UpstreamTransport   string `json:"upstream_transport"`
	OAuthTokenURL       string `json:"oauth_token_url"`
	OAuthAuthorizeURL   string `json:"oauth_authorize_url"`
	OAuthRedirectURI    string `json:"oauth_redirect_uri"`
	OAuthScope          string `json:"oauth_scope"`
	OAuthOriginator     string `json:"oauth_originator"`
	OAuthAppVersion     string `json:"oauth_app_version"`
	OAuthDesktopAuthURL string `json:"oauth_desktop_auth_url"`
	ClientID            string `json:"client_id"`
	// BPS（Excel Basispoints）账号的上游基址与 Excel OAuth 客户端（见 bps.go）
	BPSBaseURL      string `json:"bps_base_url"`
	BPSClientID     string `json:"bps_client_id"`
	BPSAuthorizeURL string `json:"bps_authorize_url"`
	BPSRedirectURI  string `json:"bps_redirect_uri"`
	// BPSStreamIdleSec：BPS 流在这么久没有新数据时结束（sub2api 默认 120 秒）
	BPSStreamIdleSec    int    `json:"bps_stream_idle_seconds"`
	TLSCertFile         string `json:"tls_cert_file"`
	TLSKeyFile          string `json:"tls_key_file"`
	TLSCAFile           string `json:"tls_ca_file"`
	TLSClientCertFile   string `json:"tls_client_cert_file"`
	TLSClientKeyFile    string `json:"tls_client_key_file"`
	TLSClientSAN        string `json:"tls_client_san"`
	TLSServerName       string `json:"tls_server_name"`
	RequireMTLS         bool   `json:"require_mtls"`
	AllowInsecure       bool   `json:"allow_insecure"`
	MaxConcurrency      int    `json:"max_concurrency"`
	AccountConcurrency  int    `json:"account_concurrency"`
	RequestTimeoutSec   int    `json:"request_timeout_seconds"`
	MaxRetryAfterSec    int    `json:"max_retry_after_seconds"`
	GuardianConcurrency int    `json:"guardian_concurrency"`
	MaxWaitingPerAcct   int    `json:"max_waiting_per_account"`
	SessionTTLHours     int    `json:"session_affinity_ttl_hours"`
	ClockSkewSec        int    `json:"clock_skew_seconds"`
	// OAuthRecoveryLog 开启 OAuth 恢复日志（原始令牌另存，默认关闭）；保留天数默认 7
	OAuthRecoveryLog           bool `json:"oauth_recovery_log"`
	OAuthRecoveryRetentionDays int  `json:"oauth_recovery_retention_days"`
	// RedisURL：共享运行态（P5，shared_state.go）；空表示单实例行为。RedisPrefix 为键前缀（默认 kin:gw:）
	RedisURL       string        `json:"redis_url"`
	RedisPrefix    string        `json:"redis_prefix"`
	Version        string        `json:"version"`
	ConfigPath     string        `json:"-"`
	RequestTimeout time.Duration `json:"-"`
	ClockSkew      time.Duration `json:"-"`
}

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
		ReceiptURL:                 os.Getenv("KIN_CODEX_GATEWAY_RECEIPT_URL"),
		ReceiptToken:               os.Getenv("KIN_CODEX_GATEWAY_RECEIPT_TOKEN"),
		ControlPlaneURL:            os.Getenv("KIN_CODEX_GATEWAY_CONTROL_PLANE_URL"),
		ControlPlaneToken:          os.Getenv("KIN_CODEX_GATEWAY_CONTROL_PLANE_TOKEN"),
		UpstreamBaseURL:            os.Getenv("KIN_CODEX_GATEWAY_UPSTREAM_BASE_URL"),
		LiveAPIBaseURL:             os.Getenv("KIN_CODEX_GATEWAY_LIVE_API_BASE_URL"),
		UpstreamTransport:          os.Getenv("KIN_CODEX_GATEWAY_UPSTREAM_TRANSPORT"),
		OAuthTokenURL:              os.Getenv("KIN_CODEX_GATEWAY_OAUTH_TOKEN_URL"),
		OAuthAuthorizeURL:          os.Getenv("KIN_CODEX_GATEWAY_OAUTH_AUTHORIZE_URL"),
		OAuthRedirectURI:           os.Getenv("KIN_CODEX_GATEWAY_OAUTH_REDIRECT_URI"),
		OAuthScope:                 os.Getenv("KIN_CODEX_GATEWAY_OAUTH_SCOPE"),
		OAuthOriginator:            os.Getenv("KIN_CODEX_GATEWAY_OAUTH_ORIGINATOR"),
		OAuthAppVersion:            os.Getenv("KIN_CODEX_GATEWAY_OAUTH_APP_VERSION"),
		OAuthDesktopAuthURL:        os.Getenv("KIN_CODEX_GATEWAY_OAUTH_DESKTOP_AUTH_URL"),
		ClientID:                   os.Getenv("KIN_CODEX_GATEWAY_CLIENT_ID"),
		BPSBaseURL:                 os.Getenv("KIN_CODEX_GATEWAY_BPS_BASE_URL"),
		BPSClientID:                os.Getenv("KIN_CODEX_GATEWAY_BPS_CLIENT_ID"),
		BPSAuthorizeURL:            os.Getenv("KIN_CODEX_GATEWAY_BPS_AUTHORIZE_URL"),
		BPSRedirectURI:             os.Getenv("KIN_CODEX_GATEWAY_BPS_REDIRECT_URI"),
		BPSStreamIdleSec:           envInt("KIN_CODEX_GATEWAY_BPS_STREAM_IDLE_SECONDS", 120),
		TLSCertFile:                os.Getenv("KIN_CODEX_GATEWAY_TLS_CERT_FILE"),
		TLSKeyFile:                 os.Getenv("KIN_CODEX_GATEWAY_TLS_KEY_FILE"),
		TLSCAFile:                  os.Getenv("KIN_CODEX_GATEWAY_TLS_CA_FILE"),
		TLSClientCertFile:          os.Getenv("KIN_CODEX_GATEWAY_TLS_CLIENT_CERT_FILE"),
		TLSClientKeyFile:           os.Getenv("KIN_CODEX_GATEWAY_TLS_CLIENT_KEY_FILE"),
		TLSClientSAN:               os.Getenv("KIN_CODEX_GATEWAY_TLS_CLIENT_SAN"),
		TLSServerName:              os.Getenv("KIN_CODEX_GATEWAY_TLS_SERVER_NAME"),
		RequireMTLS:                envBool("KIN_CODEX_GATEWAY_REQUIRE_MTLS", false),
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
		RedisURL:                   os.Getenv("KIN_REDIS_URL"),
		RedisPrefix:                os.Getenv("KIN_REDIS_PREFIX"),
	}
	cfg.applyDefaults()
	return cfg, cfg.Validate()
}

func (c *Config) applyDefaults() {
	if c.Listen == "" {
		c.Listen = "127.0.0.1:8790"
	}
	if c.AdvertiseURL == "" {
		c.AdvertiseURL = "http://" + c.Listen
	}
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
	if c.OAuthAuthorizeURL == "" {
		c.OAuthAuthorizeURL = "https://auth.openai.com/oauth/authorize"
	}
	if c.OAuthRedirectURI == "" {
		c.OAuthRedirectURI = "http://127.0.0.1:1455/auth/callback"
	}
	if c.OAuthScope == "" {
		c.OAuthScope = "openid profile email offline_access api.connectors.read api.connectors.invoke"
	}
	if c.OAuthOriginator == "" {
		c.OAuthOriginator = "Codex Desktop"
	}
	if c.OAuthAppVersion == "" {
		c.OAuthAppVersion = "0.160.0"
	}
	if c.OAuthDesktopAuthURL == "" {
		c.OAuthDesktopAuthURL = "https://chatgpt.com/codex/desktop-auth"
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
	if c.BPSAuthorizeURL == "" {
		c.BPSAuthorizeURL = "https://auth.openai.com/api/accounts/authorize"
	}
	if c.BPSStreamIdleSec <= 0 {
		c.BPSStreamIdleSec = 120
	}
	if c.BPSRedirectURI == "" {
		c.BPSRedirectURI = "https://bps.openai.com/basispoints/extension/360590d7-f8f9-4d88-bf75-0edfe0a4b9f3/auth/callback"
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
	if !c.RequireMTLS && !c.AllowInsecure {
		host, _, err := net.SplitHostPort(c.Listen)
		if err == nil && (host == "127.0.0.1" || host == "::1" || host == "localhost") {
			c.AllowInsecure = true
		}
	}
	c.RequestTimeout = time.Duration(c.RequestTimeoutSec) * time.Second
	c.ClockSkew = time.Duration(c.ClockSkewSec) * time.Second
	if c.TLSServerName == "" {
		c.TLSServerName = c.InstanceID
	}
}

func (c Config) Validate() error {
	if strings.TrimSpace(c.InternalToken) == "" && !c.RequireMTLS {
		return errors.New("internal_token is required")
	}
	if strings.TrimSpace(c.DataDir) == "" {
		return errors.New("data_dir is required")
	}
	if c.RequireMTLS && c.AllowInsecure {
		return errors.New("require_mtls cannot be combined with allow_insecure")
	}
	if c.RequireMTLS && (strings.TrimSpace(c.TLSCertFile) == "" || strings.TrimSpace(c.TLSKeyFile) == "" || strings.TrimSpace(c.TLSCAFile) == "") {
		return errors.New("tls_cert_file, tls_key_file and tls_ca_file are required when require_mtls is enabled")
	}
	if c.RequireMTLS && (strings.HasPrefix(strings.ToLower(c.ControlPlaneURL), "https://") || strings.HasPrefix(strings.ToLower(c.ReceiptURL), "https://")) && (strings.TrimSpace(c.TLSClientCertFile) == "" || strings.TrimSpace(c.TLSClientKeyFile) == "") {
		return errors.New("tls_client_cert_file and tls_client_key_file are required for mTLS callbacks")
	}
	if !c.RequireMTLS && !c.AllowInsecure {
		return errors.New("plain HTTP is disabled; set allow_insecure only for loopback development or enable require_mtls")
	}
	if !c.RequireMTLS && strings.HasPrefix(strings.ToLower(strings.TrimSpace(c.AdvertiseURL)), "https://") {
		return errors.New("https advertise_url requires require_mtls")
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

func envBool(key string, fallback bool) bool {
	raw := strings.TrimSpace(strings.ToLower(os.Getenv(key)))
	if raw == "" {
		return fallback
	}
	return raw == "1" || raw == "true" || raw == "yes" || raw == "on"
}

func (c Config) AccountsPath() string { return filepath.Join(c.DataDir, "accounts.json") }
func (c Config) ReceiptDir() string   { return filepath.Join(c.DataDir, "receipts") }
