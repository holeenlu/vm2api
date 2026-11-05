package codexgateway

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"log"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"
)

// 共享运行态（统一控制面重构 P5，设计第 8 节）：多个 Worker 实例经 Redis 共享
//   - 账号并发租约（shared_concurrency.go）；
//   - 冷却、错误保护冻结与 BPS 退避（shared_holds.go）；
//   - BPS 回放、会话目录、续接快照、图片检查点（shared_bps_state.go）与历史来源（route_provenance.go）。
//
// 开关：KIN_REDIS_URL（未设置即关闭，各项保持单实例行为）；键前缀 KIN_REDIS_PREFIX（默认 kin:gw:）。
// Redis 不可用时每项能力退回本地行为，每 5 秒探活，恢复后自动回到共享；协议状态全部可丢，丢失只会让续接或回放
// 降级为完整历史。协议内容以凭据包密钥派生的 AES-256-GCM 密钥加密（附加认证数据为 Redis 键）；没有配置凭据包
// 密钥时协议内容不进 Redis，只共享并发、冷却与历史来源（这些只含账号 ID、时刻、原因与摘要）。
const (
	sharedPingInterval = 5 * time.Second
	sharedOpTimeout    = 800 * time.Millisecond
	sharedStateInfo    = "kin-shared-state-v1"
	defaultRedisPrefix = "kin:gw:"
)

type sharedState struct {
	client   *redis.Client
	prefix   string
	instance string
	aead     cipher.AEAD
	healthy  atomic.Bool

	mu        sync.Mutex
	lastErr   string
	lastErrAt time.Time
}

// newSharedState 按配置连接 Redis；未配置时返回 nil（调用方据此保持单实例行为）。
func newSharedState(cfg Config) (*sharedState, error) {
	if strings.TrimSpace(cfg.RedisURL) == "" {
		return nil, nil
	}
	opts, err := redis.ParseURL(strings.TrimSpace(cfg.RedisURL))
	if err != nil {
		// 解析错误里带着完整地址（可能含密码），不能原样输出（R5 审查 R5-13）
		return nil, errors.New("KIN_REDIS_URL is not a valid redis:// or rediss:// URL")
	}
	opts.DialTimeout = time.Second
	opts.ReadTimeout = sharedOpTimeout
	opts.WriteTimeout = sharedOpTimeout
	// 套接字读写也受每次操作的上下文截止时间约束；连接池等待不超过一次操作的时限（R5-10）
	opts.ContextTimeoutEnabled = true
	opts.PoolTimeout = sharedOpTimeout
	opts.PoolSize = 16
	opts.MaxRetries = 0
	prefix := cfg.RedisPrefix
	if prefix == "" {
		prefix = defaultRedisPrefix
	}
	s := &sharedState{client: redis.NewClient(opts), prefix: prefix, instance: cfg.InstanceID}
	if cfg.CredentialBundleKey != "" {
		key, err := hkdf.Key(sha256.New, []byte(cfg.CredentialBundleKey), nil, sharedStateInfo, 32)
		if err != nil {
			return nil, err
		}
		block, err := aes.NewCipher(key)
		if err != nil {
			return nil, err
		}
		if s.aead, err = cipher.NewGCM(block); err != nil {
			return nil, err
		}
	}
	s.ping()
	return s, nil
}

// usable：已配置且最近一次探活或操作成功。
func (s *sharedState) usable() bool {
	return s != nil && s.healthy.Load()
}

// canStoreContent：协议内容只在能加密时进 Redis。
func (s *sharedState) canStoreContent() bool {
	return s.usable() && s.aead != nil
}

func (s *sharedState) opContext(parent context.Context) (context.Context, context.CancelFunc) {
	if parent == nil {
		parent = context.Background()
	}
	return context.WithTimeout(parent, sharedOpTimeout)
}

// observe 记录一次操作结果：成功或“键不存在”视为健康；其他错误转为降级，直到下一次探活成功。
func (s *sharedState) observe(err error) {
	if s == nil {
		return
	}
	if err == nil || errors.Is(err, redis.Nil) {
		if !s.healthy.Swap(true) {
			log.Printf("codex-gateway: shared state (redis) is available")
		}
		return
	}
	// Redis 回了错误（脚本或命令错误）：连接是好的，只记录，不转为降级；
	// 鉴权失败、只读副本、加载中、主节点不可用、内存不足等表示写不进去，按不可用处理（R5-9）
	var reply redis.Error
	if errors.As(err, &reply) && !sharedUnavailableReply(err.Error()) {
		s.mu.Lock()
		s.lastErr, s.lastErrAt = err.Error(), time.Now()
		s.mu.Unlock()
		log.Printf("codex-gateway: shared state (redis) command failed: %v", err)
		return
	}
	s.mu.Lock()
	s.lastErr, s.lastErrAt = err.Error(), time.Now()
	s.mu.Unlock()
	if s.healthy.Swap(false) {
		log.Printf("codex-gateway: shared state (redis) unavailable, falling back to local state: %v", err)
	}
}

func sharedUnavailableReply(message string) bool {
	for _, prefix := range []string{"NOAUTH", "WRONGPASS", "READONLY", "LOADING", "MASTERDOWN", "OOM", "MISCONF", "CLUSTERDOWN", "TRYAGAIN"} {
		if strings.HasPrefix(message, prefix) {
			return true
		}
	}
	return false
}

func (s *sharedState) ping() {
	ctx, cancel := s.opContext(context.Background())
	defer cancel()
	s.observe(s.client.Ping(ctx).Err())
}

func (s *sharedState) loop(ctx context.Context) {
	if s == nil {
		return
	}
	ticker := time.NewTicker(sharedPingInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.ping()
		}
	}
}

func (s *sharedState) Close() error {
	if s == nil {
		return nil
	}
	return s.client.Close()
}

// status 进入健康接口与心跳（控制面「Gateway Worker」页展示）。
func (s *sharedState) status() map[string]any {
	if s == nil {
		return map[string]any{"backend": "local"}
	}
	out := map[string]any{"backend": "redis", "healthy": s.healthy.Load(), "encrypted": s.aead != nil}
	s.mu.Lock()
	if s.lastErr != "" {
		out["last_error"] = s.lastErr
		out["last_error_at"] = s.lastErrAt.UTC().Format(time.RFC3339Nano)
	}
	s.mu.Unlock()
	return out
}

// key 拼接带前缀的键。
func (s *sharedState) key(parts ...string) string {
	return s.prefix + strings.Join(parts, ":")
}

// digest 把调用方范围等可能含标识的字符串变成定长摘要，再进键名。
func sharedDigest(parts ...string) string {
	sum := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return hex.EncodeToString(sum[:])
}

// seal / open：协议内容的 AES-256-GCM 封装，附加认证数据为 Redis 键（换键即失效）。
func (s *sharedState) seal(key string, plain []byte) ([]byte, error) {
	if s.aead == nil {
		return nil, errors.New("shared state encryption is not configured")
	}
	nonce := make([]byte, s.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return s.aead.Seal(nonce, nonce, plain, []byte(key)), nil
}

func (s *sharedState) open(key string, sealed []byte) ([]byte, error) {
	if s.aead == nil {
		return nil, errors.New("shared state encryption is not configured")
	}
	size := s.aead.NonceSize()
	if len(sealed) < size {
		return nil, errors.New("shared state entry is too short")
	}
	return s.aead.Open(nil, sealed[:size], sealed[size:], []byte(key))
}
