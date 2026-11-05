package codexgateway

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// 实例托管密钥（统一控制面重构 P3.5，设计第 6 节）。
//
// Worker 在数据目录保存一把 X25519 私钥（custody-key.json，权限 0600），公钥随注册与心跳提交给控制面。
// 控制面以凭据库为准托管令牌时（KIN_CREDENTIAL_CUSTODY=control），按实例封装凭据（custody_bundle）：
// 临时 X25519 密钥与本实例公钥协商，HKDF-SHA256 派生 AES-256-GCM 密钥，附加认证数据绑定实例与运行账号。
// 只有本实例能解开；解开后的令牌与过去一样写入本地账号（作为投影缓存）。数据目录重建会生成新密钥，
// 下一次注册提交新公钥，控制面随后按新公钥重新封装投影。
//
// 格式：v1.<临时公钥 base64url>.<nonce‖密文 base64url>；附加认证数据见 custodyAAD。

const (
	custodyKeyFileName = "custody-key.json"
	custodyBundleV1    = "v1"
	custodyHKDFInfo    = "kin-custody-v1"
)

var errCustodyBundleInvalid = errors.New("custody bundle is invalid")

type custodyKeyFile struct {
	PrivateKey string `json:"private_key"`
}

// loadCustodyKey 读取或生成实例托管私钥。
func loadCustodyKey(dataDir string) (*ecdh.PrivateKey, error) {
	path := filepath.Join(dataDir, custodyKeyFileName)
	if raw, err := os.ReadFile(path); err == nil {
		var file custodyKeyFile
		if err := json.Unmarshal(raw, &file); err != nil {
			return nil, err
		}
		key, err := base64.RawURLEncoding.DecodeString(file.PrivateKey)
		if err != nil {
			return nil, err
		}
		return ecdh.X25519().NewPrivateKey(key)
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	key, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	data, _ := json.Marshal(custodyKeyFile{PrivateKey: base64.RawURLEncoding.EncodeToString(key.Bytes())})
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, err
	}
	if err := writeFileSynced(path, data); err != nil {
		return nil, err
	}
	return key, nil
}

// custodyKeyFingerprint：托管公钥的短指纹（SHA-256 前 8 字节），启动日志与健康接口提供，供管理员确认公钥替换前带外核对（R3 复审 N8）。
func (s *Server) custodyKeyFingerprint() string {
	if s.custodyKey == nil {
		return ""
	}
	sum := sha256.Sum256(s.custodyKey.PublicKey().Bytes())
	return fmt.Sprintf("%x", sum[:8])
}

// custodyPublicKey：提交给控制面的公钥（base64url，32 字节）。
func (s *Server) custodyPublicKey() string {
	if s.custodyKey == nil {
		return ""
	}
	return base64.RawURLEncoding.EncodeToString(s.custodyKey.PublicKey().Bytes())
}

// custodyAAD 绑定实例、运行账号与两种代次（凭据代次、BPS 令牌代次）：导入元数据的代次与封装时不符就解不开（R3 审查 P2-2）。
func custodyAAD(instanceID, accountID string, credentialRevision, bpsGeneration int64) []byte {
	return []byte(fmt.Sprintf("custody:v1|%s|%s|%d|%d", instanceID, accountID, credentialRevision, bpsGeneration))
}

func custodyCipher(shared, ephemeral, recipient []byte) (cipher.AEAD, error) {
	key, err := hkdf.Key(sha256.New, shared, append(append([]byte{}, ephemeral...), recipient...), custodyHKDFInfo, 32)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// sealCustodyBundle 按收件实例公钥封装凭据（测试与工具使用；控制面有对应的 JS 实现）。
func sealCustodyBundle(recipient *ecdh.PublicKey, instanceID, accountID string, credentialRevision, bpsGeneration int64, bundle credentialBundle) (string, error) {
	ephemeral, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return "", err
	}
	shared, err := ephemeral.ECDH(recipient)
	if err != nil {
		return "", err
	}
	aead, err := custodyCipher(shared, ephemeral.PublicKey().Bytes(), recipient.Bytes())
	if err != nil {
		return "", err
	}
	payload, err := json.Marshal(bundle)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	sealed := aead.Seal(nonce, nonce, payload, custodyAAD(instanceID, accountID, credentialRevision, bpsGeneration))
	return custodyBundleV1 + "." + base64.RawURLEncoding.EncodeToString(ephemeral.PublicKey().Bytes()) + "." + base64.RawURLEncoding.EncodeToString(sealed), nil
}

// openCustodyBundle 用本实例私钥解开控制面封装的凭据。
func (s *Server) openCustodyBundle(encoded, accountID string, credentialRevision, bpsGeneration int64) (credentialBundle, error) {
	if s.custodyKey == nil {
		return credentialBundle{}, errCustodyBundleInvalid
	}
	parts := strings.Split(strings.TrimSpace(encoded), ".")
	if len(parts) != 3 || parts[0] != custodyBundleV1 {
		return credentialBundle{}, errCustodyBundleInvalid
	}
	ephemeralRaw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return credentialBundle{}, errCustodyBundleInvalid
	}
	sealed, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return credentialBundle{}, errCustodyBundleInvalid
	}
	ephemeral, err := ecdh.X25519().NewPublicKey(ephemeralRaw)
	if err != nil {
		return credentialBundle{}, errCustodyBundleInvalid
	}
	shared, err := s.custodyKey.ECDH(ephemeral)
	if err != nil {
		return credentialBundle{}, errCustodyBundleInvalid
	}
	aead, err := custodyCipher(shared, ephemeralRaw, s.custodyKey.PublicKey().Bytes())
	if err != nil {
		return credentialBundle{}, err
	}
	if len(sealed) < aead.NonceSize() {
		return credentialBundle{}, errCustodyBundleInvalid
	}
	payload, err := aead.Open(nil, sealed[:aead.NonceSize()], sealed[aead.NonceSize():], custodyAAD(s.cfg.InstanceID, accountID, credentialRevision, bpsGeneration))
	if err != nil {
		return credentialBundle{}, errCustodyBundleInvalid
	}
	var bundle credentialBundle
	if err := json.Unmarshal(payload, &bundle); err != nil {
		return credentialBundle{}, errCustodyBundleInvalid
	}
	return bundle, nil
}
