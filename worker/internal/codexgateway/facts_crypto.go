package codexgateway

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"
)

// Gateway 事实直读（设计第 19 节）的解密与凭据库加密：与控制面 src/lib/db/secure.mjs、src/lib/executor/vault.mjs
// 逐字节同一格式。Worker 解密事实；刷新后按 vault.mjs 的格式加密写回凭据库（S1b，facts_write.go）；不创建主密钥文件。

const dbFieldPrefix = "enc:v1:"

var (
	errFactsSecretMissing = errors.New("database field is encrypted but TAPMODELS_DB_SECRET is not configured")
	errMasterKeyMissing   = errors.New("credential master key is not available")
	errMasterKeyFile      = errors.New("credential master key file is missing or invalid")
)

// decryptDBField 解开 secure.mjs 的字段密文 enc:v1:<iv>:<tag>:<ct>（AES-256-GCM，密钥 SHA-256(secret)）；
// 没有前缀的值是未加密写入的原文，原样返回。
func decryptDBField(value, secret string) (string, error) {
	if !strings.HasPrefix(value, dbFieldPrefix) {
		return value, nil
	}
	if secret == "" {
		return "", errFactsSecretMissing
	}
	parts := strings.Split(strings.TrimPrefix(value, dbFieldPrefix), ":")
	if len(parts) != 3 {
		return "", errors.New("database field ciphertext is malformed")
	}
	iv, err1 := base64.StdEncoding.DecodeString(parts[0])
	tag, err2 := base64.StdEncoding.DecodeString(parts[1])
	ct, err3 := base64.StdEncoding.DecodeString(parts[2])
	if err1 != nil || err2 != nil || err3 != nil {
		return "", errors.New("database field ciphertext is malformed")
	}
	key := sha256.Sum256([]byte(secret))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCMWithNonceSize(block, len(iv))
	if err != nil {
		return "", err
	}
	plain, err := gcm.Open(nil, iv, append(ct, tag...), nil)
	if err != nil {
		return "", errors.New("database field failed authentication")
	}
	return string(plain), nil
}

// factsKeyring 读取控制面的主密钥文件 { "active": "<id>", "keys": { "<id>": "<base64 32 字节>" } }。
// 遇到不认识的主密钥 ID 或文件变化时重读（与 vault.mjs reload / refreshIfChanged 一致）。
type factsKeyring struct {
	path   string
	mu     sync.Mutex
	keys   map[string][]byte
	active string
	mtime  time.Time
	size   int64
}

func newFactsKeyring(path string) *factsKeyring { return &factsKeyring{path: path} }

func (k *factsKeyring) load() error {
	info, err := os.Stat(k.path)
	if err != nil {
		return errMasterKeyFile
	}
	if k.keys != nil && info.ModTime().Equal(k.mtime) && info.Size() == k.size {
		return nil
	}
	data, err := os.ReadFile(k.path)
	if err != nil {
		return errMasterKeyFile
	}
	var raw struct {
		Active string            `json:"active"`
		Keys   map[string]string `json:"keys"`
	}
	if json.Unmarshal(data, &raw) != nil || raw.Keys[raw.Active] == "" {
		return errMasterKeyFile
	}
	keys := make(map[string][]byte, len(raw.Keys))
	for id, encoded := range raw.Keys {
		key, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil || len(key) != 32 {
			return errMasterKeyFile
		}
		keys[id] = key
	}
	k.keys, k.active, k.mtime, k.size = keys, raw.Active, info.ModTime(), info.Size()
	return nil
}

// activeKey 是写入用的当前主密钥（与 vault.mjs encrypt 用 keyring.active 一致）。
func (k *factsKeyring) activeKey() (string, []byte, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if err := k.load(); err != nil {
		return "", nil, err
	}
	return k.active, k.keys[k.active], nil
}

// stamp 是主密钥文件的修改时间与大小（读不到时为空），读取器据此发现文件变化
func (k *factsKeyring) stamp() string {
	info, err := os.Stat(k.path)
	if err != nil {
		return ""
	}
	return fmt.Sprintf("%d:%d", info.ModTime().UnixNano(), info.Size())
}

func (k *factsKeyring) key(id string) ([]byte, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if err := k.load(); err != nil {
		return nil, err
	}
	key, ok := k.keys[id]
	if !ok {
		return nil, fmt.Errorf("%w: %s", errMasterKeyMissing, id)
	}
	return key, nil
}

func vaultOpen(key []byte, sealed string, aad []byte) ([]byte, error) {
	raw, err := base64.StdEncoding.DecodeString(sealed)
	if err != nil || len(raw) < 12+16 {
		return nil, errors.New("sealed value is truncated")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	// vault.mjs 的封装是 nonce(12) ‖ 密文 ‖ tag(16)，与 Go GCM 的 Seal 输出顺序一致
	return gcm.Open(nil, raw[:12], raw[12:], aad)
}

func vaultSeal(key, plaintext, aad []byte) (string, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(gcm.Seal(nonce, nonce, plaintext, aad)), nil
}

// vaultSecrets 是凭据库一条记录的载荷：原生授权 { access_token, refresh_token, id_token, api_key }。
// 写入时省略空字段（与 vault.mjs 写入的 JSON 一致）。
type vaultSecrets struct {
	AccessToken  string `json:"access_token,omitempty"`
	RefreshToken string `json:"refresh_token,omitempty"`
	IDToken      string `json:"id_token,omitempty"`
	APIKey       string `json:"api_key,omitempty"`
}

// sealVaultRecord 按 vault.mjs encrypt 加密一条记录：随机数据密钥加密载荷，当前主密钥包裹数据密钥，
// 两层的附加认证数据都是 vault:v1|<账号>|<授权类别>|<代次>。
func sealVaultRecord(keyring *factsKeyring, account, grant string, revision int64, secrets vaultSecrets) (string, string, string, error) {
	masterID, master, err := keyring.activeKey()
	if err != nil {
		return "", "", "", err
	}
	aad := []byte(fmt.Sprintf("vault:v1|%s|%s|%d", account, grant, revision))
	dataKey := make([]byte, 32)
	if _, err := rand.Read(dataKey); err != nil {
		return "", "", "", err
	}
	wrapped, err := vaultSeal(master, dataKey, aad)
	if err != nil {
		return "", "", "", err
	}
	payload, err := json.Marshal(secrets)
	if err != nil {
		return "", "", "", err
	}
	ciphertext, err := vaultSeal(dataKey, payload, aad)
	if err != nil {
		return "", "", "", err
	}
	return masterID, wrapped, ciphertext, nil
}

// openVaultRecord 解开凭据库记录：先用主密钥解出数据密钥，再解载荷；两层的附加认证数据都是
// vault:v1|<账号>|<授权类别>|<代次>，记录被挪到别的账号、授权类别或改了代次都解不开。
func openVaultRecord(keyring *factsKeyring, account, grant string, revision int64, masterKeyID, wrapped, ciphertext string) (vaultSecrets, error) {
	master, err := keyring.key(masterKeyID)
	if err != nil {
		return vaultSecrets{}, err
	}
	aad := []byte(fmt.Sprintf("vault:v1|%s|%s|%d", account, grant, revision))
	dataKey, err := vaultOpen(master, wrapped, aad)
	if err != nil {
		return vaultSecrets{}, errors.New("credential record failed authentication")
	}
	plain, err := vaultOpen(dataKey, ciphertext, aad)
	if err != nil {
		return vaultSecrets{}, errors.New("credential record failed authentication")
	}
	var secrets vaultSecrets
	if err := json.Unmarshal(plain, &secrets); err != nil {
		return vaultSecrets{}, errors.New("credential record payload is invalid")
	}
	return secrets, nil
}
