package codexgateway

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type Account struct {
	ID                 string    `json:"id"`
	Email              string    `json:"email,omitempty"`
	ChatGPTAccountID   string    `json:"chatgpt_account_id,omitempty"`
	Plan               string    `json:"plan,omitempty"`
	AuthType           string    `json:"auth_type"`
	AccessToken        string    `json:"access_token,omitempty"`
	RefreshToken       string    `json:"refresh_token,omitempty"`
	IDToken            string    `json:"id_token,omitempty"`
	APIKey             string    `json:"api_key,omitempty"`
	ExpiresAt          time.Time `json:"expires_at,omitempty"`
	CredentialRevision int64     `json:"credential_revision"`
	// CredentialBase 是本地原生凭据来自的凭据库代次：刷新后写回前小于 CredentialRevision；库里换成别的代次
	// （控制面重新授权、导入）时事实合并换入库里的凭据（S1b，facts_write.go）
	CredentialBase int64    `json:"credential_base,omitempty"`
	Enabled        bool     `json:"enabled"`
	Paused         bool     `json:"paused"`
	MaxConcurrency int      `json:"max_concurrency"`
	MaxRPM         int      `json:"max_rpm"`
	Weight         int      `json:"weight"`
	Groups         []string `json:"groups,omitempty"`
	Models         []string `json:"models,omitempty"`
	// DeniedModels 是模型黑名单（CPR modelAccess=denylist）；Models 非空时为白名单。
	DeniedModels []string `json:"denied_models,omitempty"`
	ProxyURL     string   `json:"proxy_url,omitempty"`
	// ProxyMaxWS 是该代理共享的上游 WS 连接上限（控制面代理配置，0 不限）
	ProxyMaxWS int `json:"proxy_max_websocket_connections,omitempty"`
	// RequestLocation 是账号代理的请求位置（控制面按代理手动设置或自动探测结果投影）
	RequestLocation *RequestLocation `json:"request_location,omitempty"`
	CooldownUntil   time.Time        `json:"cooldown_until,omitempty"`
	LastError       string           `json:"last_error,omitempty"`
	LastUsedAt      time.Time        `json:"last_used_at,omitempty"`
	// InFlight 只是进程内计数：对外展示，但加载时清零，投影时不被控制面覆盖。
	InFlight         int                  `json:"in_flight"`
	GuardianInFlight int                  `json:"guardian_in_flight,omitempty"`
	Quota            map[string]any       `json:"quota,omitempty"`
	RuntimeRevision  int64                `json:"runtime_revision"`
	CooldownReason   string               `json:"cooldown_reason,omitempty"`
	ModelCooldowns   map[string]time.Time `json:"model_cooldowns,omitempty"`
	// CredentialState 记录上游对凭据的终态判定：expired/invalid/banned/unverified；空表示可用。
	CredentialState string `json:"credential_state,omitempty"`
	// InstallationID 是该账号的稳定安装身份，用于出站关联 ID 隔离；首次保存时生成，之后不变。
	InstallationID string `json:"installation_id,omitempty"`
	// Protection 是账号错误保护的计数与冻结状态（见 protection.go）。
	Protection *ProtectionState `json:"protection,omitempty"`
	// QuotaExhaustedAt 是最近一次进入额度冷却的时刻；QuotaRecovery 记录完整快照的解除进度
	QuotaExhaustedAt time.Time      `json:"quota_exhausted_at,omitempty"`
	QuotaRecovery    *QuotaRecovery `json:"quota_recovery,omitempty"`
	// Cookies 是该账号当前凭据代次下的上游 Cookie（见 cookies.go），对外视图不返回。
	Cookies []StoredCookie `json:"cookies,omitempty"`
	// ResetCreditAuto 是控制面投影的“自动使用重置卡”开关；ResetCreditPlan 是其持久计划（见 reset_credit_auto.go）
	ResetCreditAuto bool             `json:"reset_credit_auto,omitempty"`
	ResetCreditPlan *ResetCreditPlan `json:"reset_credit_plan,omitempty"`
	// LastRefreshFailure 是最近一次刷新失败的结构化诊断（脱敏的上游状态、错误码与信息），成功刷新后清除
	LastRefreshFailure *RefreshFailure `json:"last_refresh_failure,omitempty"`
}

// riskState 是 Cloudflare 挑战与路径封禁的进程内退避计数（与 CPR 相同，不写账号事实）。
type riskState struct {
	challengeCount int
	pathBlockCount int
	observedAt     time.Time
}

type Store struct {
	// eligible 是套餐与端点资格判定（由 Server 注入，见 background.go accountEligible）
	eligible func(account Account, operation, model string, now time.Time) bool
	path     string
	// persistMu 串行化落盘：持锁后再取快照，最后一次写入一定是最新状态，临时文件不会被并发写坏
	persistMu sync.Mutex
	// sealKey 非空时账号库整体以 AES-256-GCM 加密落盘（凭据、代理与 Cookie 不以明文存放）
	sealKey []byte
	// flushTimer 合并运行时状态的延迟落盘（见 persistSoon）
	flushMu            sync.Mutex
	flushTimer         *time.Timer
	closed             bool
	mu                 sync.RWMutex
	accounts           map[string]Account
	rpm                map[string][]time.Time
	risk               map[string]*riskState
	sched              *scheduler
	defaultConcurrency int
	// lastAdmit 是最近一次准入的副作用（持锁写入，Acquire 在同一持锁区间读取，用于共享租约被拒时撤回）
	lastAdmit admitUndo
	// creditOverage 由控制面 Codex 设置 credit_overage 经心跳下发：false（默认）时套餐窗口用尽的账号不靠官方点数继续出量
	creditOverage atomic.Bool
}

// runtimeFlushDelay 是运行时状态（额度、冷却、Cookie、保护计数等）合并落盘的最长延迟；0 表示同步落盘
var runtimeFlushDelay = 2 * time.Second

// accountStoreSealPrefix 标识加密的账号库文件；内容为 base64(nonce || 密文)，前缀同时作为 GCM 附加数据
const accountStoreSealPrefix = "kin-accounts-sealed-v1:"

// accountStoreKey 由 CredentialBundleKey 按独立用途派生落盘密钥，与 Worker 间凭据 bundle 的密钥不同
func accountStoreKey(secret string) []byte {
	if strings.TrimSpace(secret) == "" {
		return nil
	}
	sum := sha256.Sum256([]byte("tapmodels codex-gateway accounts-at-rest v1\n" + secret))
	return sum[:]
}

func OpenStore(path string) (*Store, error) {
	return OpenSealedStore(path, "")
}

// OpenSealedStore 打开账号库；secret 非空时以其派生密钥加密落盘。已有的明文账号库在加载后立即改写为密文；
// 密文账号库缺少或无法用该密钥解开时拒绝启动，避免以空账号库覆盖原有凭据。
func OpenSealedStore(path, secret string) (*Store, error) {
	s := &Store{path: path, sealKey: accountStoreKey(secret), accounts: map[string]Account{}, rpm: map[string][]time.Time{}, risk: map[string]*riskState{}, sched: newScheduler(), defaultConcurrency: 4}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	if len(data) == 0 {
		return s, nil
	}
	sealed := bytes.HasPrefix(data, []byte(accountStoreSealPrefix))
	if sealed {
		if data, err = s.open(data); err != nil {
			return nil, err
		}
	}
	var rows []Account
	if err := json.Unmarshal(data, &rows); err != nil {
		return nil, fmt.Errorf("decode account store: %w", err)
	}
	for _, row := range rows {
		if row.ID != "" {
			// 进程重启后没有在途请求，旧计数不能占住并发。
			row.InFlight = 0
			row.GuardianInFlight = 0
			s.accounts[row.ID] = row
		}
	}
	if !sealed && s.sealKey != nil {
		if err := s.persist(); err != nil {
			return nil, fmt.Errorf("seal account store: %w", err)
		}
	}
	return s, nil
}

// UnsealAccountStore 把加密的账号库改写为明文，仅用于回滚到不支持落盘加密的 Worker（须先停止 Worker）。
func UnsealAccountStore(path, secret string) error {
	store, err := OpenSealedStore(path, secret)
	if err != nil {
		return err
	}
	store.sealKey = nil
	return store.persist()
}

func (s *Store) seal(plain []byte) ([]byte, error) {
	block, err := aes.NewCipher(s.sealKey)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	payload := gcm.Seal(nonce, nonce, plain, []byte(accountStoreSealPrefix))
	return []byte(accountStoreSealPrefix + base64.StdEncoding.EncodeToString(payload) + "\n"), nil
}

func (s *Store) open(data []byte) ([]byte, error) {
	if s.sealKey == nil {
		return nil, errors.New("account store is encrypted: KIN_CODEX_GATEWAY_CREDENTIAL_BUNDLE_KEY is required")
	}
	payload, err := base64.StdEncoding.DecodeString(strings.TrimSpace(strings.TrimPrefix(string(data), accountStoreSealPrefix)))
	if err != nil {
		return nil, fmt.Errorf("decode sealed account store: %w", err)
	}
	block, err := aes.NewCipher(s.sealKey)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if len(payload) < gcm.NonceSize() {
		return nil, errors.New("sealed account store is truncated")
	}
	plain, err := gcm.Open(nil, payload[:gcm.NonceSize()], payload[gcm.NonceSize():], []byte(accountStoreSealPrefix))
	if err != nil {
		return nil, errors.New("account store cannot be decrypted with the configured KIN_CODEX_GATEWAY_CREDENTIAL_BUNDLE_KEY")
	}
	return plain, nil
}

// SetQueueLimits 设置 Guardian 独立并发（0 表示与普通请求共用并发）与单账号等待上限（0 关闭排队）。
func (s *Store) SetQueueLimits(guardian, waitingPerAccount int, sessionTTL time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if guardian >= 0 {
		s.sched.guardianLimit = guardian
	}
	if waitingPerAccount >= 0 {
		s.sched.maxWaitingPerAccount = waitingPerAccount
	}
	if sessionTTL > 0 {
		s.sched.sessionTTL = sessionTTL
	}
}

// SessionTTL 返回会话亲和保留时长，turn-state 归属证明沿用同一时长。
func (s *Store) SessionTTL() time.Duration {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sched.sessionTTL
}

// SetDefaultConcurrency 设置未显式配置并发时的账号并发上限（KIN_CODEX_GATEWAY_ACCOUNT_CONCURRENCY）。
func (s *Store) SetDefaultConcurrency(value int) {
	if value > 0 {
		s.mu.Lock()
		s.defaultConcurrency = value
		s.mu.Unlock()
	}
}

// preserveRuntime 让控制面投影只改配置与凭据，不覆盖 Worker 自己观察到的运行时状态。
func preserveRuntime(account *Account, previous Account) {
	if account.InstallationID == "" {
		account.InstallationID = previous.InstallationID
	}
	account.InFlight = previous.InFlight
	account.GuardianInFlight = previous.GuardianInFlight
	if account.CooldownUntil.IsZero() {
		account.CooldownUntil = previous.CooldownUntil
		account.CooldownReason = previous.CooldownReason
	}
	if account.LastError == "" {
		account.LastError = previous.LastError
	}
	if account.LastUsedAt.IsZero() {
		account.LastUsedAt = previous.LastUsedAt
	}
	if account.Quota == nil {
		account.Quota = previous.Quota
	}
	if account.ModelCooldowns == nil {
		account.ModelCooldowns = previous.ModelCooldowns
	}
	if account.Protection == nil {
		account.Protection = previous.Protection
	}
	if account.Cookies == nil && account.CredentialRevision == previous.CredentialRevision {
		account.Cookies = previous.Cookies
	}
	if account.CredentialState == "" && account.CredentialRevision == previous.CredentialRevision {
		account.CredentialState = previous.CredentialState
	}
	if account.ResetCreditPlan == nil {
		account.ResetCreditPlan = previous.ResetCreditPlan
	}
	if account.LastRefreshFailure == nil && account.CredentialRevision == previous.CredentialRevision {
		account.LastRefreshFailure = previous.LastRefreshFailure
	}
}

func (s *Store) List() []Account {
	s.mu.RLock()
	defer s.mu.RUnlock()
	rows := make([]Account, 0, len(s.accounts))
	for _, account := range s.accounts {
		rows = append(rows, account)
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].ID < rows[j].ID })
	for i := range rows {
		rows[i] = publicAccount(rows[i])
	}
	return rows
}

// snapshot 返回包含凭据的账号副本，仅供 Worker 内部后台任务使用。
func (s *Store) snapshot() []Account {
	s.mu.RLock()
	defer s.mu.RUnlock()
	rows := make([]Account, 0, len(s.accounts))
	for _, account := range s.accounts {
		rows = append(rows, account)
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].ID < rows[j].ID })
	return rows
}

// inflight 是心跳上报的各账号在途请求数（含 Guardian 独立并发池）；只列出有在途的账号。
func (s *Store) inflight() []map[string]any {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []map[string]any{}
	for id, account := range s.accounts {
		if n := account.InFlight + account.GuardianInFlight; n > 0 {
			out = append(out, map[string]any{"account_id": id, "in_flight": n})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i]["account_id"].(string) < out[j]["account_id"].(string) })
	return out
}

// credentialStates 是心跳上报的凭据终态（expired/invalid/banned/unverified）及最近错误；只列出有终态的账号，
// 控制面把未列出的账号视为凭据可用，没有请求的账号也能在列表看到“刷新失败”等状态。
func (s *Store) credentialStates() []map[string]any {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []map[string]any{}
	for id, account := range s.accounts {
		if account.CredentialState != "" {
			out = append(out, map[string]any{"account_id": id, "credential_state": account.CredentialState, "last_error": account.LastError})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i]["account_id"].(string) < out[j]["account_id"].(string) })
	return out
}

// SetCredentialState 写入凭据终态（expired/invalid/banned/unverified，空值表示恢复可用）。
func (s *Store) SetCredentialState(id, state, reason string) (Account, error) {
	s.mu.Lock()
	account, ok := s.accounts[id]
	if !ok {
		s.mu.Unlock()
		return Account{}, os.ErrNotExist
	}
	account.CredentialState = state
	if reason != "" {
		account.LastError = reason
	} else if state == "" {
		account.LastError = ""
	}
	account.RuntimeRevision++
	s.accounts[id] = account
	s.mu.Unlock()
	return account, s.persist()
}

// SetResetCreditPlan 同步落盘自动重置卡计划：未决消费的幂等键必须在发送前写入磁盘。
func (s *Store) SetResetCreditPlan(id string, plan *ResetCreditPlan) {
	s.mu.Lock()
	account, ok := s.accounts[id]
	if !ok {
		s.mu.Unlock()
		return
	}
	account.ResetCreditPlan = plan.clone()
	s.accounts[id] = account
	s.mu.Unlock()
	_ = s.persist()
}

func (s *Store) Get(id string) (Account, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	row, ok := s.accounts[id]
	return row, ok
}

func (s *Store) Upsert(account Account) (Account, error) {
	if strings.TrimSpace(account.ID) == "" {
		return Account{}, errors.New("account id is required")
	}
	if account.AuthType == "" {
		if account.APIKey != "" {
			account.AuthType = "api_key"
		} else {
			account.AuthType = "oauth"
		}
	}
	if previous, ok := s.Get(account.ID); ok {
		// Control-plane projections may omit secrets during an ordinary edit.
		// Preserve the protected credential material unless a new value is sent.
		if account.AccessToken == "" {
			account.AccessToken = previous.AccessToken
		}
		if account.RefreshToken == "" {
			account.RefreshToken = previous.RefreshToken
		}
		if account.IDToken == "" {
			account.IDToken = previous.IDToken
		}
		if account.APIKey == "" {
			account.APIKey = previous.APIKey
		}
		if account.ProxyURL == "" {
			account.ProxyURL = previous.ProxyURL
		}
		if account.CredentialRevision <= 0 {
			account.CredentialRevision = previous.CredentialRevision
		}
		preserveRuntime(&account, previous)
	} else if account.CredentialRevision <= 0 {
		account.CredentialRevision = 1
	}
	if account.RuntimeRevision <= 0 {
		if previous, ok := s.Get(account.ID); ok {
			account.RuntimeRevision = previous.RuntimeRevision
		}
		if account.RuntimeRevision <= 0 {
			account.RuntimeRevision = 1
		}
	}
	if account.InstallationID == "" {
		account.InstallationID = newUUIDv4()
	}
	s.mu.Lock()
	if account.MaxConcurrency <= 0 {
		account.MaxConcurrency = s.defaultConcurrency
	}
	if account.Weight <= 0 {
		account.Weight = 1
	}
	s.accounts[account.ID] = account
	s.mu.Unlock()
	return account, s.persist()
}

func (s *Store) UpsertCAS(account Account, expectedRevision int64) (Account, error) {
	s.mu.Lock()
	previous, exists := s.accounts[account.ID]
	if expectedRevision < 0 && exists {
		s.mu.Unlock()
		return Account{}, fmt.Errorf("credential revision conflict: account already exists")
	}
	if expectedRevision >= 0 && (!exists || previous.CredentialRevision != expectedRevision) {
		s.mu.Unlock()
		actual := int64(0)
		if exists {
			actual = previous.CredentialRevision
		}
		return Account{}, fmt.Errorf("credential revision conflict: expected %d, got %d", expectedRevision, actual)
	}
	if exists {
		if account.AccessToken == "" {
			account.AccessToken = previous.AccessToken
		}
		if account.RefreshToken == "" {
			account.RefreshToken = previous.RefreshToken
		}
		if account.IDToken == "" {
			account.IDToken = previous.IDToken
		}
		if account.APIKey == "" {
			account.APIKey = previous.APIKey
		}
		if account.ProxyURL == "" {
			account.ProxyURL = previous.ProxyURL
		}
		if account.CredentialRevision <= 0 {
			account.CredentialRevision = previous.CredentialRevision
		}
		preserveRuntime(&account, previous)
	} else if account.CredentialRevision <= 0 {
		account.CredentialRevision = 1
	}
	if account.RuntimeRevision <= 0 {
		account.RuntimeRevision = previous.RuntimeRevision + 1
	}
	if account.InstallationID == "" {
		account.InstallationID = newUUIDv4()
	}
	if account.MaxConcurrency <= 0 {
		account.MaxConcurrency = s.defaultConcurrency
	}
	if account.Weight <= 0 {
		account.Weight = 1
	}
	s.accounts[account.ID] = account
	s.mu.Unlock()
	return account, s.persist()
}

// CommitCredentials 在锁内按凭据代次 CAS 只改凭据相关字段（刷新换票的提交）。fn 作用于锁内的最新账号，
// 不回写调用方开始刷新时读到的旧快照：刷新期间合并进来的库内配置（停用、分组、代理）与运行态保持不变。
// SetCredentialBase 记下写回成功后本地原生凭据对应的凭据库代次（不改运行代次、不落盘以外的状态）。
func (s *Store) SetCredentialBase(id string, revision int64) {
	s.mu.Lock()
	account, ok := s.accounts[id]
	if !ok || account.CredentialRevision != revision || account.CredentialBase >= revision {
		s.mu.Unlock()
		return
	}
	account.CredentialBase = revision
	s.accounts[id] = account
	s.mu.Unlock()
	_ = s.persist()
}

func (s *Store) CommitCredentials(id string, expectedRevision int64, fn func(account *Account)) (Account, error) {
	s.mu.Lock()
	account, ok := s.accounts[id]
	if !ok {
		s.mu.Unlock()
		return Account{}, os.ErrNotExist
	}
	if account.CredentialRevision != expectedRevision {
		s.mu.Unlock()
		return Account{}, fmt.Errorf("credential revision conflict: expected %d, got %d", expectedRevision, account.CredentialRevision)
	}
	fn(&account)
	account.RuntimeRevision++
	s.accounts[id] = account
	s.mu.Unlock()
	return account, s.persist()
}

func (s *Store) Patch(id string, patch map[string]any) (Account, error) {
	s.mu.Lock()
	account, ok := s.accounts[id]
	if !ok {
		s.mu.Unlock()
		return Account{}, os.ErrNotExist
	}
	if value, ok := patch["enabled"].(bool); ok {
		account.Enabled = value
	}
	if value, ok := patch["paused"].(bool); ok {
		account.Paused = value
	}
	if value, ok := patch["max_concurrency"].(float64); ok {
		account.MaxConcurrency = int(value)
	}
	if value, ok := patch["max_rpm"].(float64); ok {
		account.MaxRPM = int(value)
	}
	if value, ok := patch["reset_credit_auto"].(bool); ok {
		account.ResetCreditAuto = value
	}
	if value, ok := patch["weight"].(float64); ok {
		account.Weight = int(value)
	}
	if value, ok := patch["groups"].([]any); ok {
		account.Groups = stringSlice(value)
	}
	if value, ok := patch["models"].([]any); ok {
		account.Models = stringSlice(value)
	}
	if value, ok := patch["denied_models"].([]any); ok {
		account.DeniedModels = stringSlice(value)
	}
	if value, ok := patch["email"].(string); ok {
		account.Email = value
	}
	if value, ok := patch["plan"].(string); ok {
		account.Plan = value
	}
	if value, ok := patch["proxy_max_websocket_connections"].(float64); ok && value >= 0 {
		account.ProxyMaxWS = int(value)
	}
	if raw, ok := patch["request_location"]; ok {
		account.RequestLocation = nil
		if object, ok := raw.(map[string]any); ok {
			data, _ := json.Marshal(object)
			var location RequestLocation
			if json.Unmarshal(data, &location) == nil {
				if normalized, err := location.normalized(); err == nil {
					account.RequestLocation = &normalized
				}
			}
		}
	}
	if value, ok := patch["proxy_url"].(string); ok {
		account.ProxyURL = value
	}
	if value, ok := patch["auth_type"].(string); ok {
		account.AuthType = value
	}
	if value, ok := patch["expires_at"].(string); ok {
		if parsed, err := time.Parse(time.RFC3339Nano, value); err == nil {
			account.ExpiresAt = parsed
		}
	}
	credentialChanged := false
	for key, target := range map[string]*string{"access_token": &account.AccessToken, "refresh_token": &account.RefreshToken, "id_token": &account.IDToken, "api_key": &account.APIKey} {
		if value, ok := patch[key].(string); ok && value != "" {
			*target = value
			credentialChanged = true
		}
	}
	if value, ok := patch["quota"].(map[string]any); ok {
		account.Quota = value
	}
	if credentialChanged {
		// 控制面给的代次下限（账号文件重新授权）：新令牌的代次不低于它，否则会被库里的旧令牌按代次覆盖
		next := account.CredentialRevision + 1
		if value, ok := patch["credential_revision"].(float64); ok && int64(value) > next {
			next = int64(value)
		}
		account.CredentialRevision = next
		resetCredentialRuntime(&account)
	}
	account.RuntimeRevision++
	s.accounts[id] = account
	s.mu.Unlock()
	return account, s.persist()
}

// resetCredentialRuntime 清除只属于旧凭据代次的运行态：凭据终态、刷新失败诊断与上游 Cookie。
// 换入新凭据（重授权、导入）时调用；额度、冷却与错误保护属于账号本身，保留。
func resetCredentialRuntime(account *Account) {
	account.CredentialState = ""
	account.LastRefreshFailure = nil
	account.Cookies = nil
}

// Delete 永久删除账号（控制面删除账号后调用）：移除账号记录与凭据、本地 RPM 与风控计数，并立即落盘。
// 在途请求归还租约时找不到账号会直接跳过（见 releaseLease）。
func (s *Store) Delete(id string) error {
	s.mu.Lock()
	if _, ok := s.accounts[id]; !ok {
		s.mu.Unlock()
		return os.ErrNotExist
	}
	delete(s.accounts, id)
	delete(s.rpm, id)
	delete(s.risk, id)
	s.mu.Unlock()
	return s.persist()
}

func (s *Store) Recover(id string) error {
	s.mu.Lock()
	account, ok := s.accounts[id]
	if !ok {
		s.mu.Unlock()
		return os.ErrNotExist
	}
	account.CooldownUntil = time.Time{}
	account.CooldownReason = ""
	account.QuotaRecovery = nil
	account.ModelCooldowns = nil
	account.LastError = ""
	// 人工恢复同时解除错误保护冻结并清空计数（CPR manual recover）
	clearProtection(&account)
	// 人工恢复把凭据状态重置为可用（CPR manual recover）：过期、失效、封禁与待验证都清除，由下一次真实请求重新判定
	account.CredentialState = ""
	s.accounts[id] = account
	delete(s.risk, id)
	s.mu.Unlock()
	return s.persist()
}

// ErrNoEligibleAccount 表示当前范围内没有可用账号（含全部被排除）。
var ErrNoEligibleAccount = errors.New("no eligible codex account")

// ErrUsageLimitExhausted 表示范围内所有可用账号的额度窗口都已耗尽。
var ErrUsageLimitExhausted = errors.New("all eligible codex accounts reached their usage limit")

// Select 不等待地选号并占用一个普通池在途计数；exclude 为本次请求已失败、需要换掉的账号。
func (s *Store) Select(scope Scope, model string, exclude map[string]bool) (Account, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	account, _, err := s.trySelect(selectRequest{Scope: scope, Model: model, Exclude: exclude}, time.Now(), nil)
	if errors.Is(err, errBlocked) {
		return Account{}, ErrNoEligibleAccount
	}
	return account, err
}

// credentialUsable：终态凭据不可选；过期 access token 只有带 refresh token 才可选（发送前刷新）。
// credentialUsable 对齐 CPR 账号状态：凭据终态（过期、失效、封禁、待验证）与 AT 已过期的 OAuth 账号都不可选；
// AT 过期的账号由定时刷新在恢复窗口内恢复后重新可选，不在请求内刷新。
func credentialUsable(account Account, now time.Time) bool {
	switch account.CredentialState {
	case "invalid", "banned", "unverified", "expired":
		return false
	}
	if account.APIKey != "" {
		return true
	}
	expiry := effectiveExpiry(account)
	return expiry.IsZero() || expiry.After(now)
}

// rpmEvidenceTTL：x-ratelimit-remaining-requests 只是某一时刻的观测，过期后不再作为排除依据，
// 否则被排除的账号再也拿不到新响应头，会被永久锁住。
const rpmEvidenceTTL = time.Minute

func quotaUnavailable(quota map[string]any, now time.Time) bool {
	if quota == nil {
		return false
	}
	confidence, _ := quota["confidence"].(string)
	if confidence != "unknown" {
		if value, ok := quota["rpm_remaining"].(float64); ok && value <= 0 {
			updated, _ := quota["updated_at"].(string)
			at, err := time.Parse(time.RFC3339Nano, updated)
			if err == nil && now.Sub(at) < rpmEvidenceTTL {
				return true
			}
		}
	}
	return false
}

// RecordSuccess：成功推理是额度与凭据可用的权威证据，解除限流/额度冷却与风险退避。
func (s *Store) RecordSuccess(id string) {
	s.mu.Lock()
	account, ok := s.accounts[id]
	changed := false
	if ok {
		if account.CooldownReason == string(categoryRateLimited) || account.CooldownReason == string(categoryUsageLimit) || account.CooldownReason == string(categoryQuotaExhausted) {
			account.CooldownUntil = time.Time{}
			account.CooldownReason = ""
			account.QuotaRecovery = nil
			changed = true
		}
		// 未允许点数超额时，靠点数完成的成功不能解除窗口用尽的停放
		if s.creditOverageGateLocked(&account, time.Now()) {
			changed = true
		}
		if account.CredentialState == "expired" || account.LastError != "" {
			account.CredentialState = ""
			account.LastError = ""
			changed = true
		}
		s.accounts[id] = account
		delete(s.risk, id)
	}
	s.mu.Unlock()
	if changed {
		s.persistSoon()
	}
}

// Dispose 按失败分类处置账号（对齐 CPR selector 的 record_failure）。
func (s *Store) Dispose(id, model string, failure upstreamFailure, now time.Time) {
	s.mu.Lock()
	account, ok := s.accounts[id]
	if !ok {
		s.mu.Unlock()
		return
	}
	previousCredentialState := account.CredentialState
	cooldown := func(until time.Time, reason failureCategory) {
		if reason == categoryUsageLimit || reason == categoryQuotaExhausted {
			// 额度耗尽结论总是记录（until 只是复查时刻，取较晚者）
			if !quotaExhaustedFact(account) {
				account.QuotaExhaustedAt, account.QuotaRecovery = now, nil
			}
			account.CooldownReason = string(reason)
			if until.After(account.CooldownUntil) {
				account.CooldownUntil = until
			}
			return
		}
		// 其他冷却不覆盖已有的额度耗尽结论
		if !quotaExhaustedFact(account) && until.After(account.CooldownUntil) {
			account.CooldownUntil = until
			account.CooldownReason = string(reason)
		}
	}
	risk := s.risk[id]
	if risk == nil || now.Sub(risk.observedAt) > cloudflareRecoveryStale {
		risk = &riskState{}
		s.risk[id] = risk
	}
	switch failure.Category {
	case categoryCredentialExpired:
		// CPR record_failure：AT 已过期且仍在恢复窗口内的 OAuth 账号保留（AT 过期本身已不可选），由定时刷新恢复；
		// AT 未过期却被拒、没有 refresh token 或窗口已过时判过期终态。
		expiry := effectiveExpiry(account)
		if account.APIKey != "" || account.RefreshToken == "" || expiry.IsZero() || expiry.After(now) || !now.Before(expiry.Add(refreshRecoveryWindow)) {
			account.CredentialState = "expired"
		}
	case categoryIdentityVerification:
		account.CredentialState = "unverified"
	case categoryBanned:
		account.CredentialState = "banned"
	case categoryQuotaExhausted:
		cooldown(now.Add(quotaExhaustedCooldown), failure.Category)
	case categoryUsageLimit:
		until := failure.ResetsAt
		if !until.After(now) {
			if exhausted, at := quotaExhausted(account.Quota, now); exhausted {
				until = at
			} else {
				until = now.Add(defaultUsageLimitCooldown)
			}
		}
		cooldown(until, failure.Category)
	case categoryRateLimited:
		// 上游给出的 Retry-After（含 0）优先，缺省 60s（CPR apply_rate_limit_429）
		delay := defaultRateLimitCooldown
		if failure.HasRetryAfter {
			delay = failure.RetryAfter
		}
		cooldown(now.Add(delay), failure.Category)
	case categoryCloudflareChallenge:
		// CPR：挑战不冷却账号、不写账号事实，只让该账号的 Cookie 在退避后过期，换取新的 cf_clearance
		risk.challengeCount++
		risk.observedAt = now
		delay := cloudflareChallengeBackoff[min(risk.challengeCount-1, len(cloudflareChallengeBackoff)-1)]
		if failure.HasRetryAfter && failure.RetryAfter > delay {
			delay = failure.RetryAfter
		}
		expireAt := now.Add(delay)
		for i := range account.Cookies {
			if account.Cookies[i].ExpiresAt.IsZero() || account.Cookies[i].ExpiresAt.After(expireAt) {
				account.Cookies[i].ExpiresAt = expireAt
			}
		}
	case categoryCloudflarePathBlocked:
		risk.pathBlockCount++
		risk.observedAt = now
		account.Cookies = nil
		if risk.pathBlockCount >= cloudflarePathThreshold {
			account.CredentialState = "invalid"
		}
	case categoryModelUnsupported:
		if model != "" {
			if account.ModelCooldowns == nil {
				account.ModelCooldowns = map[string]time.Time{}
			}
			account.ModelCooldowns[model] = now.Add(modelUnsupportedCooldown)
		}
	default:
		s.mu.Unlock()
		return
	}
	account.LastError = string(failure.Category)
	account.RuntimeRevision++
	s.accounts[id] = account
	s.mu.Unlock()
	// 凭据终态（过期、封禁、失效、待验证）同步落盘：进程异常退出后不能把已判定不可用的凭据恢复为可用
	if account.CredentialState != previousCredentialState {
		_ = s.persist()
		return
	}
	s.persistSoon()
}

func (s *Store) UpdateQuota(id string, quota map[string]any) {
	s.mu.Lock()
	account, ok := s.accounts[id]
	if ok {
		merged := map[string]any{}
		for key, value := range account.Quota {
			merged[key] = value
		}
		for key, value := range quota {
			if value != nil {
				merged[key] = value
			}
		}
		account.Quota = merged
		adoptPlan(&account, merged)
		// 推理响应头只合并展示事实，不推导额度访问结论（CPR merge_passive_quota）：耗尽由 usage_limit/402 错误
		// 与 /wham/usage 快照判定，成功推理由 RecordSuccess 放行
		if !quotaExhaustedFact(account) && account.CooldownUntil.Before(time.Now()) {
			account.CooldownUntil = time.Time{}
			account.CooldownReason = ""
		}
		// 例外：未允许点数超额时，窗口已用尽、只靠点数出量的账号由响应头直接停放（上游此时不会返回 usage_limit）
		s.creditOverageGateLocked(&account, time.Now())
		account.RuntimeRevision++
		s.accounts[id] = account
	}
	s.mu.Unlock()
	if ok {
		s.persistSoon()
	}
}

// ReplaceQuotaDisplay 只替换展示快照，保留额度耗尽结论与恢复进度（额度拒绝后的回读使用）。
func (s *Store) ReplaceQuotaDisplay(id string, quota map[string]any) {
	s.mu.Lock()
	account, ok := s.accounts[id]
	if ok {
		account.Quota = quota
		adoptPlan(&account, quota)
		account.RuntimeRevision++
		s.accounts[id] = account
	}
	s.mu.Unlock()
	if ok {
		s.persistSoon()
	}
}

// ReplaceQuota 用完整快照（/wham/usage）替换额度，并按新快照重算额度冷却。
func (s *Store) ReplaceQuota(id string, quota map[string]any) {
	s.mu.Lock()
	account, ok := s.accounts[id]
	if ok {
		previous := account.Quota
		account.Quota = quota
		adoptPlan(&account, quota)
		now := time.Now()
		reconcileQuotaSnapshot(&account, previous, quota, now, s.creditOverage.Load())
		s.creditOverageGateLocked(&account, now)
		account.RuntimeRevision++
		s.accounts[id] = account
	}
	s.mu.Unlock()
	if ok {
		s.persistSoon()
	}
}

// ClearQuotaCooldown 在重置卡成功后解除额度类冷却，不影响限流、风险或人工暂停。
func (s *Store) ClearQuotaCooldown(id string) {
	s.mu.Lock()
	account, ok := s.accounts[id]
	if ok && (account.CooldownReason == string(categoryUsageLimit) || account.CooldownReason == string(categoryQuotaExhausted)) {
		account.CooldownUntil = time.Time{}
		account.CooldownReason = ""
		account.QuotaRecovery = nil
		account.RuntimeRevision++
		s.accounts[id] = account
	}
	s.mu.Unlock()
	if ok {
		s.persistSoon()
	}
}

// SetCreditOverage 采用控制面下发的点数超额开关。关闭时（默认）每次下发都复核全部账号，把窗口已用尽、只能靠官方点数
// 出量的账号停放到窗口恢复；由关闭改为开启时，解除仍有可用点数的额度耗尽停放（与 /wham/usage 判定点数放行一致）。
func (s *Store) SetCreditOverage(enabled bool) {
	previous := s.creditOverage.Swap(enabled)
	if enabled && previous {
		return
	}
	now := time.Now()
	changed := false
	s.mu.Lock()
	for id, account := range s.accounts {
		updated := false
		if enabled {
			if quotaExhaustedFact(account) && quotaCreditsSpendable(account.Quota) {
				account.CooldownUntil, account.CooldownReason, account.QuotaRecovery = time.Time{}, "", nil
				updated = true
			}
		} else {
			updated = s.creditOverageGateLocked(&account, now)
		}
		if updated {
			account.RuntimeRevision++
			s.accounts[id] = account
			changed = true
		}
	}
	s.mu.Unlock()
	if changed {
		s.persistSoon()
	}
}

// creditOverageGateLocked：未允许点数超额且账号只能靠点数出量时，停放到窗口恢复（与额度耗尽同一结论，由额度刷新解除）。
func (s *Store) creditOverageGateLocked(account *Account, now time.Time) bool {
	if s.creditOverage.Load() || quotaExhaustedFact(*account) {
		return false
	}
	until, ok := creditOnlyExhausted(account.Quota, now)
	if !ok {
		return false
	}
	account.CooldownUntil, account.CooldownReason = until, string(categoryUsageLimit)
	account.QuotaExhaustedAt = now
	account.QuotaRecovery = newQuotaRecovery(now, account.Quota, until, false)
	return true
}

// MergeQuota 合并流内 codex.rate_limits 等局部额度观测，不覆盖未出现的字段。
func (s *Store) MergeQuota(id string, partial map[string]any) {
	if len(partial) == 0 {
		return
	}
	s.mu.Lock()
	account, ok := s.accounts[id]
	if ok {
		merged := mergeQuotaWindows(account.Quota, partial)
		account.Quota = merged
		adoptPlan(&account, merged)
		s.creditOverageGateLocked(&account, time.Now())
		account.RuntimeRevision++
		s.accounts[id] = account
	}
	s.mu.Unlock()
	if ok {
		s.persistSoon()
	}
}

// persistSoon 合并运行时状态的落盘：请求热路径上的额度、冷却、Cookie、保护计数与租约变化最多延迟
// runtimeFlushDelay 后一次写出，不在每个请求上整库重写。凭据与配置变更仍调用 persist 同步落盘；进程退出前调用 Flush。
func (s *Store) persistSoon() {
	if runtimeFlushDelay <= 0 {
		_ = s.persist()
		return
	}
	s.flushMu.Lock()
	defer s.flushMu.Unlock()
	if s.closed {
		_ = s.persist()
		return
	}
	if s.flushTimer != nil {
		return
	}
	s.flushTimer = time.AfterFunc(runtimeFlushDelay, func() {
		s.flushMu.Lock()
		s.flushTimer = nil
		s.flushMu.Unlock()
		_ = s.persist()
	})
}

// Flush 立即写出尚未落盘的运行时状态。
func (s *Store) Flush() error {
	s.flushMu.Lock()
	if s.flushTimer != nil {
		s.flushTimer.Stop()
		s.flushTimer = nil
	}
	s.flushMu.Unlock()
	return s.persist()
}

// Close 写出最终状态并停止延迟落盘：之后的运行时变化同步写盘，进程退出时不会留下未触发的计时器。
func (s *Store) Close() error {
	s.flushMu.Lock()
	s.closed = true
	if s.flushTimer != nil {
		s.flushTimer.Stop()
		s.flushTimer = nil
	}
	s.flushMu.Unlock()
	return s.persist()
}

func (s *Store) persist() error {
	s.persistMu.Lock()
	defer s.persistMu.Unlock()
	s.mu.RLock()
	rows := make([]Account, 0, len(s.accounts))
	for _, row := range s.accounts {
		rows = append(rows, row)
	}
	s.mu.RUnlock()
	sort.Slice(rows, func(i, j int) bool { return rows[i].ID < rows[j].ID })
	var data []byte
	var err error
	if s.sealKey != nil {
		// 密文没有人工阅读的需要，不生成带缩进的明文
		if data, err = json.Marshal(rows); err == nil {
			data, err = s.seal(data)
		}
	} else {
		data, err = json.MarshalIndent(rows, "", "  ")
	}
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, append(data, '\n'), 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, s.path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

func publicAccount(account Account) Account {
	account.InstallationID = ""
	account.AccessToken = ""
	account.RefreshToken = ""
	account.IDToken = ""
	account.APIKey = ""
	account.ProxyURL = ""
	account.Cookies = nil
	account.ResetCreditPlan = nil
	return account
}

func Fingerprint(account Account) string {
	h := sha256.Sum256([]byte(strings.Join([]string{account.ID, account.ChatGPTAccountID, account.Email}, "\x00")))
	return hex.EncodeToString(h[:])
}

func stringSlice(values []any) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		if text, ok := value.(string); ok && text != "" {
			result = append(result, text)
		}
	}
	return result
}

func intersects(values []string, allowed map[string]bool) bool {
	for _, value := range values {
		if allowed[value] {
			return true
		}
	}
	return false
}

func contains(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

// adoptPlan 用上游额度观测中的套餐更新账号套餐（套餐资格与目录作用域依赖它）。
// adoptPlan 用上游观测到的套餐更新账号（CPR observed_account_plan）：unknown 不写入；同族泛化值
// （team / business / edu）不覆盖已知的具体 SKU。
func adoptPlan(account *Account, quota map[string]any) {
	raw, _ := quota["plan_type"].(string)
	plan := strings.ToLower(strings.TrimSpace(raw))
	if plan == "" || plan == "unknown" {
		return
	}
	current := strings.ToLower(strings.TrimSpace(account.Plan))
	switch {
	case plan == "team" && (current == "self_serve_business_prolite" || current == "self_serve_business_usage_based"),
		plan == "business" && (current == "ent26" || current == "enterprise_cbp_automation" || current == "enterprise_cbp_usage_based"),
		(plan == "edu" || plan == "education") && (current == "edu_plus" || current == "edu_pro"):
		return
	}
	account.Plan = plan
}
