package codexgateway

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// 按实例签发的内部 HMAC 密钥（中期技术债 M2；设计 5.1、6.2，运维见 SETUP 第 2、7 节）。
//
// 引导必须有授权：控制面托管的同机 Worker 由托管器在每次拉起时经环境 KIN_CODEX_GATEWAY_BOOTSTRAP_TOKEN 传入一次性引导令牌，
// Worker 注册时随正文出示；外部 Worker 由管理员在面板上“允许引导”。控制面签发实例密钥，用请求方已持有的秘密（引导令牌、
// 共用令牌或旧实例密钥）包裹后经注册响应的 instance_key 下发；响应带签名，Worker 验签后才接受。Worker 把密钥写进数据目录
// instance-key.json（0600；配了凭据包密钥时以其派生的独立密钥 AES-256-GCM 加密），之后：
//   - 发往控制面的请求（注册与心跳、租约、回执）都用实例密钥按 v2 签名串签名（覆盖方法、请求目标、实例与 key_id），
//     带 X-Kin-Gateway-Instance 与 X-Kin-Gateway-Key，不再发送共用令牌；
//   - 控制面确认过实例密钥后，控制面发来的请求只接受实例密钥（当前密钥，或轮换宽限期内的上一把）；
//     共用令牌只能用于 /health 与 /capabilities 只读探测。引导签发后、控制面确认之前仍接受共用令牌。
// 控制面轮换后，下一次心跳响应带来新密钥：先落盘再切换，上一把保留到控制面给出的到期时间。
// 控制面以已验签的响应回答 instance_key_invalid、且被拒的正是当前密钥时删除本地密钥，下一轮重新引导。

const (
	instanceKeyFileName   = "instance-key.json"
	instanceKeySealPrefix = "kin-instance-key:v1:"
	// instanceKeySupport 随注册上报：控制面只给声明支持的 Worker 签发
	instanceKeySupport = 1
	// 控制面没有给出旧密钥到期时间时的默认宽限
	defaultInstanceKeyGrace = 10 * time.Minute
)

type instanceKeyEntry struct {
	KeyID     string `json:"key_id"`
	Secret    string `json:"secret"`
	ExpiresAt string `json:"expires_at,omitempty"`
}

type instanceKeyFile struct {
	Version    int               `json:"version"`
	InstanceID string            `json:"instance_id"`
	Current    *instanceKeyEntry `json:"current,omitempty"`
	Previous   *instanceKeyEntry `json:"previous,omitempty"`
	Confirmed  bool              `json:"confirmed,omitempty"`
}

type instanceKeys struct {
	mu         sync.RWMutex
	path       string
	sealKey    []byte
	instanceID string
	current    *instanceKeyEntry
	previous   *instanceKeyEntry
	prevUntil  time.Time
	// confirmed：控制面已经接受过本实例用实例密钥签名的请求。控制面只用它确认过的密钥给发往 Worker 的请求签名，
	// 所以引导签发后、确认之前，控制面仍用共用令牌调用 Worker，这段时间 Worker 也接受共用令牌（与控制面对未确认实例
	// 仍接受共用令牌一致）。确认后一直保持，轮换不清除；删除密钥时清除。
	confirmed bool
}

// instanceKeyStoreKey 由凭据包密钥按独立用途派生落盘密钥（与账号库、凭据 bundle 的密钥都不同）
func instanceKeyStoreKey(secret string) []byte {
	if strings.TrimSpace(secret) == "" {
		return nil
	}
	sum := sha256.Sum256([]byte("tapmodels codex-gateway instance-key-at-rest v1\n" + secret))
	return sum[:]
}

// loadInstanceKeys 读取数据目录里的实例密钥；文件属于别的实例 ID（实例改名）时忽略。
// 文件已加密却解不开（凭据包密钥更换）时报错，与账号库一致：不静默丢弃后改用共用令牌。
func loadInstanceKeys(dataDir, instanceID, bundleKey string) (*instanceKeys, error) {
	k := &instanceKeys{path: filepath.Join(dataDir, instanceKeyFileName), sealKey: instanceKeyStoreKey(bundleKey), instanceID: instanceID}
	data, err := os.ReadFile(k.path)
	if errors.Is(err, os.ErrNotExist) {
		return k, nil
	}
	if err != nil {
		return nil, err
	}
	if bytes.HasPrefix(data, []byte(instanceKeySealPrefix)) {
		if data, err = k.open(data); err != nil {
			return nil, err
		}
	}
	var file instanceKeyFile
	if err := json.Unmarshal(data, &file); err != nil {
		return nil, fmt.Errorf("decode instance key file: %w", err)
	}
	if file.InstanceID != instanceID {
		log.Printf("codex-gateway: ignoring instance key issued to %q (this instance is %q)", file.InstanceID, instanceID)
		return k, nil
	}
	if file.Current != nil && file.Current.KeyID != "" && file.Current.Secret != "" {
		k.current = file.Current
		k.confirmed = file.Confirmed
	}
	if file.Previous != nil && file.Previous.KeyID != "" && file.Previous.Secret != "" {
		if until, err := time.Parse(time.RFC3339Nano, file.Previous.ExpiresAt); err == nil && until.After(time.Now()) {
			k.previous, k.prevUntil = file.Previous, until
		}
	}
	return k, nil
}

// 附加认证数据只绑定文件用途；实例 ID 记在明文里，实例改名时读出后忽略而不是解不开
func (k *instanceKeys) aad() []byte { return []byte(instanceKeySealPrefix + "instance-key.json") }

func (k *instanceKeys) seal(plain []byte) ([]byte, error) {
	block, err := aes.NewCipher(k.sealKey)
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
	return []byte(instanceKeySealPrefix + base64.StdEncoding.EncodeToString(gcm.Seal(nonce, nonce, plain, k.aad())) + "\n"), nil
}

func (k *instanceKeys) open(data []byte) ([]byte, error) {
	if k.sealKey == nil {
		return nil, errors.New("instance key file is encrypted: KIN_CODEX_GATEWAY_CREDENTIAL_BUNDLE_KEY is required")
	}
	payload, err := base64.StdEncoding.DecodeString(strings.TrimSpace(strings.TrimPrefix(string(data), instanceKeySealPrefix)))
	if err != nil {
		return nil, fmt.Errorf("decode sealed instance key file: %w", err)
	}
	block, err := aes.NewCipher(k.sealKey)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if len(payload) < gcm.NonceSize() {
		return nil, errors.New("sealed instance key file is truncated")
	}
	plain, err := gcm.Open(nil, payload[:gcm.NonceSize()], payload[gcm.NonceSize():], k.aad())
	if err != nil {
		return nil, errors.New("instance key file cannot be decrypted with KIN_CODEX_GATEWAY_CREDENTIAL_BUNDLE_KEY")
	}
	return plain, nil
}

// persistLocked 落盘当前状态（调用方持有写锁）；没有密钥时删除文件。
func (k *instanceKeys) persistLocked() error {
	if k.current == nil {
		if err := os.Remove(k.path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		syncDir(filepath.Dir(k.path))
		return nil
	}
	file := instanceKeyFile{Version: 1, InstanceID: k.instanceID, Current: k.current, Confirmed: k.confirmed}
	if k.previous != nil && time.Now().Before(k.prevUntil) {
		file.Previous = k.previous
	}
	data, err := json.Marshal(file)
	if err != nil {
		return err
	}
	if k.sealKey != nil {
		if data, err = k.seal(data); err != nil {
			return err
		}
	}
	if err := os.MkdirAll(filepath.Dir(k.path), 0o700); err != nil {
		return err
	}
	return writeFileSynced(k.path, data)
}

// held：是否持有实例密钥（持有后不再接受、也不再发送共用令牌签名）
func (k *instanceKeys) held() bool {
	if k == nil {
		return false
	}
	k.mu.RLock()
	defer k.mu.RUnlock()
	return k.current != nil
}

// acceptsSharedToken：持有的密钥还没被控制面确认（引导期），共用令牌仍可调用 Worker。
func (k *instanceKeys) acceptsSharedToken() bool {
	if k == nil {
		return true
	}
	k.mu.RLock()
	defer k.mu.RUnlock()
	return k.current == nil || !k.confirmed
}

// markConfirmed 记录控制面已接受实例密钥签名的请求（落盘失败只影响重启后的引导期判断）。
func (k *instanceKeys) markConfirmed() {
	if k == nil {
		return
	}
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.current == nil || k.confirmed {
		return
	}
	k.confirmed = true
	if err := k.persistLocked(); err != nil {
		log.Printf("codex-gateway: cannot persist instance key confirmation: %v", err)
	}
}

// signing 返回发往控制面时使用的当前密钥。
func (k *instanceKeys) signing() (keyID, secret string, ok bool) {
	if k == nil {
		return "", "", false
	}
	k.mu.RLock()
	defer k.mu.RUnlock()
	if k.current == nil {
		return "", "", false
	}
	return k.current.KeyID, k.current.Secret, true
}

// lookup 按 key_id 找控制面签名用的密钥：当前密钥，或宽限期内的上一把。
func (k *instanceKeys) lookup(keyID string, now time.Time) (string, bool) {
	if k == nil || keyID == "" {
		return "", false
	}
	k.mu.RLock()
	defer k.mu.RUnlock()
	if k.current != nil && k.current.KeyID == keyID {
		return k.current.Secret, true
	}
	if k.previous != nil && k.previous.KeyID == keyID && now.Before(k.prevUntil) {
		return k.previous.Secret, true
	}
	return "", false
}

// install 换上控制面下发的新密钥：先落盘再切换；当前密钥成为上一把，保留到 previousUntil。
// 落盘失败时不切换（控制面在下一次心跳会再次下发）。
func (k *instanceKeys) install(entry instanceKeyEntry, previousUntil time.Time) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.current != nil && k.current.KeyID == entry.KeyID {
		return nil
	}
	oldCurrent, oldPrevious, oldUntil := k.current, k.previous, k.prevUntil
	if k.current != nil {
		previous := *k.current
		if previousUntil.IsZero() {
			previousUntil = time.Now().Add(defaultInstanceKeyGrace)
		}
		previous.ExpiresAt = previousUntil.UTC().Format(time.RFC3339Nano)
		k.previous, k.prevUntil = &previous, previousUntil
	}
	installed := entry
	installed.ExpiresAt = ""
	k.current = &installed
	if err := k.persistLocked(); err != nil {
		k.current, k.previous, k.prevUntil = oldCurrent, oldPrevious, oldUntil
		return err
	}
	return nil
}

// drop 删除本地密钥（控制面已吊销或不认识它），之后回到共用令牌引导。
func (k *instanceKeys) drop() error {
	k.mu.Lock()
	defer k.mu.Unlock()
	k.current, k.previous, k.prevUntil, k.confirmed = nil, nil, time.Time{}, false
	return k.persistLocked()
}

// instanceKeyDelivery 是注册或心跳响应里的 instance_key：新密钥用请求方已持有的秘密包裹（wrapped），不明文下发。
type instanceKeyDelivery struct {
	InstanceID        string `json:"instance_id"`
	KeyID             string `json:"key_id"`
	Wrapped           string `json:"wrapped"`
	PreviousKeyID     string `json:"previous_key_id"`
	PreviousExpiresAt string `json:"previous_expires_at"`
}

// controlCall 记下一次发往控制面的请求用了哪些秘密，用来校验响应签名、解开下发的新密钥（审查 P2）。
type controlCall struct {
	keyID     string // 实例密钥 key_id；用共用令牌时为空
	keySecret string
	shared    string // 共用令牌（用实例密钥时为空）
	bootstrap string // 本次出示的一次性引导令牌（没有时为空）
	nonce     string
	target    string // 请求目标（路径与查询串），控制面按它给响应签名
}

// responseSecret 按响应头 X-Kin-Gateway-Response-Key 选出控制面签响应用的秘密：本次签名的实例密钥、
// 本次出示的引导令牌或共用令牌；不在本次请求持有的范围内时返回空。出示了引导令牌时只认引导令牌签名的响应
// （复审 P2-3），allowShared 只用于判断拒绝（引导被拒、需要授权）是否来自控制面。
func (c controlCall) responseSecret(header http.Header, allowShared bool) string {
	switch key := header.Get("X-Kin-Gateway-Response-Key"); {
	case key == "":
		return ""
	case c.keyID != "" && key == c.keyID:
		return c.keySecret
	case c.keyID == "" && key == "bootstrap" && c.bootstrap != "":
		return c.bootstrap
	case c.keyID == "" && key == "shared" && c.shared != "" && (c.bootstrap == "" || allowShared):
		return c.shared
	}
	return ""
}

// signedResponse：响应带了签名头（新版控制面总会签名；旧版控制面不签）
func signedResponse(header http.Header) bool {
	return header.Get("X-Kin-Gateway-Response-Signature") != ""
}

// acceptPolicy 判断能否采信这条成功响应里的策略与结果（复审 P2-2）：验签通过；或者本次走的是共用令牌（未持有实例密钥、
// 也没出示引导令牌）且响应完全没带签名头（旧版控制面，兼容）。持有实例密钥时一律要求验签。
func (c controlCall) acceptPolicy(verified bool, header http.Header) bool {
	return verified || (c.keyID == "" && c.bootstrap == "" && !signedResponse(header))
}

// verifyResponse 校验控制面响应签名（作用域含状态码与请求目标，绑定本次请求的随机串），返回签名用的秘密。
func (c controlCall) verifyResponse(status int, header http.Header, body []byte) (string, bool) {
	return c.verify(status, header, body, false)
}

// verifyRejection 与 verifyResponse 相同，但出示引导令牌时也认共用令牌签名（只用于识别拒绝）。
func (c controlCall) verifyRejection(status int, header http.Header, body []byte) bool {
	_, ok := c.verify(status, header, body, true)
	return ok
}

func (c controlCall) verify(status int, header http.Header, body []byte, allowShared bool) (string, bool) {
	secret := c.responseSecret(header, allowShared)
	if secret == "" {
		return "", false
	}
	hash := BodyHash(body)
	if !hmac.Equal([]byte(header.Get("X-Kin-Gateway-Response-Sha256")), []byte(hash)) {
		return "", false
	}
	want := Sign(secret, responseSignatureScope(status, c.target), c.nonce, hash, body)
	if !hmac.Equal([]byte(want), []byte(header.Get("X-Kin-Gateway-Response-Signature"))) {
		return "", false
	}
	return secret, true
}

// unwrapDeliveredKey 解开控制面下发的新密钥（与 instance-keys.mjs 的 wrapDeliveredSecret 对应）：
// HKDF-SHA256(持有的秘密, salt, "v1\n实例\nkey_id") 派生 AES-256-GCM 密钥，附加认证数据为“实例\nkey_id\n请求随机串”。
func unwrapDeliveredKey(holder, instanceID, keyID, nonce, wrapped string) (string, error) {
	raw, err := base64.RawURLEncoding.DecodeString(wrapped)
	if err != nil || len(raw) < 12+16 {
		return "", errors.New("wrapped instance key is malformed")
	}
	key, err := hkdf.Key(sha256.New, []byte(holder), []byte("kin-gateway-key-delivery"), "v1\n"+instanceID+"\n"+keyID, 32)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	plain, err := gcm.Open(nil, raw[:12], raw[12:], []byte(instanceID+"\n"+keyID+"\n"+nonce))
	if err != nil {
		return "", errors.New("wrapped instance key cannot be opened")
	}
	return string(plain), nil
}

// applyInstanceKey 处理已验签的注册或心跳成功响应：带 instance_key 时用 holder（签响应的那把秘密）解开、落盘并切换，
// 返回是否换上了新密钥（换上后立即再心跳一次，让控制面尽快确认新密钥）。
func (s *Server) applyInstanceKey(body []byte, call controlCall, holder string) bool {
	if s.instanceKeys == nil || holder == "" {
		return false
	}
	var response struct {
		InstanceKey *instanceKeyDelivery `json:"instance_key"`
	}
	if err := json.Unmarshal(body, &response); err != nil || response.InstanceKey == nil {
		return false
	}
	delivery := response.InstanceKey
	if delivery.InstanceID != s.cfg.InstanceID {
		log.Printf("codex-gateway: ignoring instance key for %q", delivery.InstanceID)
		return false
	}
	if strings.TrimSpace(delivery.KeyID) == "" {
		return false
	}
	secret, err := unwrapDeliveredKey(holder, s.cfg.InstanceID, delivery.KeyID, call.nonce, delivery.Wrapped)
	if err != nil || len(secret) < 32 {
		log.Printf("codex-gateway: ignoring instance key %s: %v", delivery.KeyID, err)
		return false
	}
	var until time.Time
	if delivery.PreviousExpiresAt != "" {
		if parsed, err := time.Parse(time.RFC3339Nano, delivery.PreviousExpiresAt); err == nil {
			until = parsed
		}
	}
	if err := s.instanceKeys.install(instanceKeyEntry{KeyID: delivery.KeyID, Secret: secret}, until); err != nil {
		log.Printf("codex-gateway: cannot persist instance key %s: %v", delivery.KeyID, err)
		return false
	}
	if call.bootstrap != "" {
		// 引导令牌只能用一次：换上密钥后不再出示
		s.bootstrapToken.Store(nil)
	}
	s.bootstrapRefusals.Store(0)
	log.Printf("codex-gateway: instance key %s installed", delivery.KeyID)
	return true
}

// handleInstanceKeyRejection 处理控制面拒绝（审查 P1-1）：
//   - instance_key_invalid（吊销、不认识或已过期）：只有响应签名已验证、且被拒请求用的正是当前密钥时才删除本地密钥，
//     下一轮用共用令牌（或引导令牌）重新注册；迟到的、针对旧密钥的拒绝不动新密钥；
//   - instance_key_required / instance_key_bootstrap_not_allowed：记日志（状态变化时一次），按心跳周期退避重试，不删除可用的密钥。
//
// 返回是否删除了密钥。
func (s *Server) handleInstanceKeyRejection(status int, body []byte, call controlCall, verified bool) bool {
	if status < 400 {
		return false
	}
	var response struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	_ = json.Unmarshal(body, &response)
	code := response.Error.Code
	switch code {
	case "instance_key_required", "instance_key_bootstrap_not_allowed", "instance_pending_approval":
		if previous, _ := s.instanceKeyNotice.Swap(code).(string); previous != code {
			log.Printf("codex-gateway: control plane requires authorization (%s); ask an administrator to allow bootstrap for %s, retrying every heartbeat", code, s.cfg.InstanceID)
		}
		if verified {
			s.noteBootstrapRefusal(call)
		}
		return false
	case "instance_key_invalid":
	default:
		return false
	}
	current, _, held := s.instanceKeys.signing()
	if !verified || !held || call.keyID == "" || call.keyID != current {
		return false
	}
	if err := s.instanceKeys.drop(); err != nil {
		log.Printf("codex-gateway: cannot remove instance key: %v", err)
		return false
	}
	log.Printf("codex-gateway: control plane rejected instance key %s; registering again without it", call.keyID)
	return true
}

// signInternal 给发往控制面的请求签名：持有实例密钥时用它（v2 签名串，不发送共用令牌），否则用共用令牌（v1）。
func (s *Server) signInternal(req *http.Request, body []byte, sharedToken string) controlCall {
	timestamp := time.Now().UTC().Format(time.RFC3339Nano)
	nonce, _ := randomURLToken(18)
	hash := BodyHash(body)
	call := controlCall{nonce: nonce, target: req.URL.RequestURI()}
	req.Header.Set("X-Kin-Gateway-Timestamp", timestamp)
	req.Header.Set("X-Kin-Gateway-Nonce", nonce)
	req.Header.Set("X-Kin-Gateway-Body-Sha256", hash)
	if keyID, keySecret, ok := s.instanceKeys.signing(); ok {
		call.keyID, call.keySecret = keyID, keySecret
		req.Header.Set("X-Kin-Gateway-Instance", s.cfg.InstanceID)
		req.Header.Set("X-Kin-Gateway-Key", keyID)
		req.Header.Set("X-Kin-Gateway-Signature", SignV2(keySecret, req.Method, call.target, s.cfg.InstanceID, keyID, timestamp, nonce, hash, body))
		return call
	}
	if sharedToken == "" {
		return call
	}
	call.shared = sharedToken
	req.Header.Set("X-Kin-Gateway-Token", sharedToken)
	req.Header.Set("X-Kin-Gateway-Signature", Sign(sharedToken, timestamp, nonce, hash, body))
	return call
}

// currentBootstrapToken：托管器给的一次性引导令牌（没有或已用过时为空）
func (s *Server) currentBootstrapToken() string {
	if value := s.bootstrapToken.Load(); value != nil {
		return *value
	}
	return ""
}

type verifiedSecretKey struct{}

// verifiedSecret 是验证本次入站请求所用的密钥（响应签名用同一把，控制面按它验签）。
func verifiedSecret(ctx context.Context, fallback string) string {
	if value, ok := ctx.Value(verifiedSecretKey{}).(string); ok && value != "" {
		return value
	}
	return fallback
}

// sharedTokenProbe：持有实例密钥后，共用令牌只能用于只读探测（健康与能力描述，scripts/codex-gateway-health.mjs）
func sharedTokenProbe(path string) bool {
	return path == "/internal/v1/health" || path == "/internal/v1/capabilities"
}

// noteInstanceKeyStatus：on 模式下没有引导授权时，控制面照常接受注册但不签发，在响应里给出 instance_key_status；
// 状态变化时提示一次
// 返回是否把这次响应记为一次引导被拒。
func (s *Server) noteInstanceKeyStatus(body []byte, call controlCall) bool {
	if s.instanceKeys.held() {
		return false
	}
	var response struct {
		Status string `json:"instance_key_status"`
	}
	if json.Unmarshal(body, &response) != nil || response.Status == "" {
		return false
	}
	if previous, _ := s.instanceKeyNotice.Swap(response.Status).(string); previous != response.Status {
		log.Printf("codex-gateway: running on the shared internal token (%s); an administrator can allow bootstrap for %s in the Gateway Worker page", response.Status, s.cfg.InstanceID)
	}
	if response.Status == "instance_key_bootstrap_not_allowed" {
		s.noteBootstrapRefusal(call)
		return true
	}
	return false
}

// heartbeatAccepted：控制面把这次心跳当作完整心跳处理了（响应带实例登记或策略）。续接（只回密钥）与待批准
// （只回状态）时控制面没有记录额度与探测，Worker 不能把它们当作已送达。
func heartbeatAccepted(body []byte) bool {
	var response struct {
		Instance json.RawMessage `json:"instance"`
		Policy   json.RawMessage `json:"policy"`
	}
	if json.Unmarshal(body, &response) != nil {
		return false
	}
	present := func(raw json.RawMessage) bool { return len(raw) > 0 && string(raw) != "null" }
	return present(response.Instance) || present(response.Policy)
}

// bootstrapRefusalLimit：持有托管器给的引导令牌、没有实例密钥，又连续这么多次被拒（需要授权、引导被拒）时退出进程，
// 由托管器拉起新进程并换发新令牌（复审 P1-2：例如控制面重启后旧令牌的摘要已不在内存里）
const bootstrapRefusalLimit = 3

// noteBootstrapRefusal 记一次出示引导令牌后被拒；达到上限时请求退出（托管器会以新令牌重新拉起）。
func (s *Server) noteBootstrapRefusal(call controlCall) {
	if call.bootstrap == "" || s.instanceKeys.held() {
		return
	}
	if n := s.bootstrapRefusals.Add(1); n >= bootstrapRefusalLimit && s.requestExit != nil {
		log.Printf("codex-gateway: bootstrap token refused %d times; exiting so the supervisor restarts the Worker with a new token", n)
		s.requestExit()
	}
}
