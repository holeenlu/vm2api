package codexgateway

import (
	"context"
	"strconv"

	"github.com/dofastted/kin-gateway/worker/internal/basispoints"
	"github.com/redis/go-redis/v9"
)

// BPS 协议状态的存储后端（basispoints.StateStore + 落盘）：数据目录（bpsDiskState）或 Redis（P5.4）。
type bpsStateBackend interface {
	basispoints.StateStore
	Flush() error
}

// sharedBPSState：BPS 工具回放、会话目录、续接快照与图片检查点存进 Redis，多实例共享（P5.4，设计第 8 节）。
// 键为 前缀 + bps: + SHA-256(scope, name)，值为加密后的数据与版本号；空闲 2 小时过期（读取时续期）。
// Redis 不可用或无法加密时读写退回数据目录（disk）；协议状态可丢，两边不做同步。
type sharedBPSState struct {
	shared *sharedState
	disk   *bpsDiskState
}

// 版本号 CAS：ARGV[1] 为期望版本（空表示不比较），ARGV[2] 为加密数据，ARGV[3] 为过期毫秒。返回新版本，CAS 失败返回 0。
var bpsStateSaveScript = redis.NewScript(`
local v = tonumber(redis.call('HGET', KEYS[1], 'v') or '0')
if ARGV[1] ~= '' and tonumber(ARGV[1]) ~= v then return 0 end
redis.call('HSET', KEYS[1], 'v', v + 1, 'd', ARGV[2])
redis.call('PEXPIRE', KEYS[1], ARGV[3])
return v + 1
`)

func (b *sharedBPSState) key(scope, name string) string {
	return b.shared.key("bps", sharedDigest(scope, name))
}

func (b *sharedBPSState) LoadBPSState(ctx context.Context, scope, name string) ([]byte, uint64, error) {
	if !b.shared.canStoreContent() {
		return b.disk.LoadBPSState(ctx, scope, name)
	}
	key := b.key(scope, name)
	opCtx, cancel := b.shared.opContext(ctx)
	defer cancel()
	pipe := b.shared.client.TxPipeline()
	values := pipe.HMGet(opCtx, key, "v", "d")
	pipe.PExpire(opCtx, key, bpsStateTTL)
	_, err := pipe.Exec(opCtx)
	b.shared.observe(err)
	if err != nil {
		return b.disk.LoadBPSState(ctx, scope, name)
	}
	fields := values.Val()
	if len(fields) != 2 || fields[0] == nil || fields[1] == nil {
		return nil, 0, nil
	}
	version, _ := strconv.ParseUint(redisString(fields[0]), 10, 64)
	data, err := b.shared.open(key, []byte(redisString(fields[1])))
	if err != nil {
		// 密钥变更或被篡改：当作不存在（协议状态可丢）
		return nil, 0, nil
	}
	return data, version, nil
}

func (b *sharedBPSState) SaveBPSState(ctx context.Context, scope, name string, expected *uint64, data []byte) (bool, error) {
	if len(data) > basispoints.MaxStateEntryBytes {
		return false, basispoints.ErrStateCapacity
	}
	if !b.shared.canStoreContent() {
		return b.disk.SaveBPSState(ctx, scope, name, expected, data)
	}
	key := b.key(scope, name)
	sealed, err := b.shared.seal(key, data)
	if err != nil {
		return b.disk.SaveBPSState(ctx, scope, name, expected, data)
	}
	want := ""
	if expected != nil {
		want = strconv.FormatUint(*expected, 10)
	}
	opCtx, cancel := b.shared.opContext(ctx)
	defer cancel()
	result, err := bpsStateSaveScript.Run(opCtx, b.shared.client, []string{key}, want, sealed, bpsStateTTL.Milliseconds()).Int64()
	b.shared.observe(err)
	if err != nil {
		return b.disk.SaveBPSState(ctx, scope, name, expected, data)
	}
	return result > 0, nil
}

func (b *sharedBPSState) Flush() error {
	return b.disk.Flush()
}

func redisString(value any) string {
	switch v := value.(type) {
	case string:
		return v
	case []byte:
		return string(v)
	case nil:
		return ""
	default:
		return ""
	}
}
