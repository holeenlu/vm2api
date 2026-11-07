/**
 * 控制面运行状态（最终审计 U8）：事件收件箱统计，供「Gateway Worker」页与排障使用。
 * 统一控制面的开关已全部移除（2026-11-07 S1b–S4：刷新租约、事件模式、Redis、实例密钥）；仍写在 .env 里的已移除开关
 * 启动时告警一次。
 */
import { createExecutorEventIngest } from './event-ingest.mjs'

const raw = (env, name) => String(env[name] ?? '').trim()

let logged = false
/** 启动时提示仍配置着的已移除开关（每个进程只提示一次；once 为 false 时总是提示，供测试）。 */
export function logRetiredSwitches({ env = process.env, log = console, once = true } = {}) {
  if (once && logged) return
  logged = true
  for (const [name, fixed] of Object.entries(RETIRED_SWITCHES))
    if (raw(env, name)) log.warn?.(`control plane switch ${name} has been removed and is ignored; ${fixed}`)
}

// 已移除的开关：仍写在 .env 里时提示可以删除（值不再生效）
const RETIRED_SWITCHES = Object.freeze({
  // 2026-11-07 S4：托管 Worker 用会话密钥，外部 Worker 用共用令牌；实例密钥、引导与批准删除
  KIN_CODEX_GATEWAY_INSTANCE_KEYS:
    'the supervised Worker uses a per-process session key; external Workers use the shared token',
  KIN_CODEX_GATEWAY_BOOTSTRAP_WINDOW_SECONDS: 'instance key bootstrap has been removed',
  // 2026-11-07 S3：只支持同机单个 Worker，Redis 共享运行态删除
  KIN_REDIS_URL: 'the shared Redis state has been removed; the single Worker keeps its state locally',
  KIN_REDIS_PREFIX: 'the shared Redis state has been removed',
  // 2026-11-07 S2：结算与账号运行态只走事件通道，回执推送与补拉删除
  KIN_EXECUTOR_EVENTS: 'Worker events are always the settlement channel',
  KIN_REFRESH_LEASE: 'the Worker writes refreshed credentials to the vault directly (no refresh leases)',
  KIN_CREDENTIAL_CUSTODY: 'credentials are always held by the control plane vault',
  // Gateway 事实直读 G4b：只支持与控制面同机的单个 Worker
  KIN_CODEX_GATEWAY_MULTI_WORKER: 'only one Worker on the control-plane host is supported',
  KIN_CODEX_GATEWAY_REQUIRE_MTLS: 'the Worker runs on the control-plane host over loopback HTTP with HMAC signatures',
})

// 汇总结果缓存 60 秒（复核 O1）：收件箱统计已走覆盖索引（迁移 121，只扫近 24 小时的索引范围）
const STATUS_CACHE_MS = 60_000
const statusCache = new WeakMap()

/** 汇总状态：近 24 小时事件收件箱。读取失败时为 null。 */
export async function controlPlaneStatus({ db, repo, sinceMs = 24 * 3600_000, now = Date.now(), cache = true } = {}) {
  const cached = cache && db ? statusCache.get(db) : null
  if (cached && now - cached.at < STATUS_CACHE_MS) return cached.value
  const safe = async (fn) => {
    try {
      return await fn()
    } catch {
      return null
    }
  }
  const events = await safe(async () => {
    const stats = await createExecutorEventIngest({ db, repo, client: null }).stats({ since: sinceMs })
    const byStatus = {}
    for (const row of stats.events) byStatus[row.status] = (byStatus[row.status] || 0) + Number(row.n || 0)
    const attempts = Object.fromEntries(stats.attempts.map((row) => [row.state, Number(row.n || 0)]))
    // 未拉取：Worker 写到的位置减去控制面已处理与 Worker 已确认中较大的一个（接收器从这里开始拉取）
    const lag = stats.instances
      .filter((item) => item.worker && item.cursor)
      .map((item) => ({
        instance_id: item.instance_id,
        lag: Math.max(
          0,
          Number(item.worker.head || 0) - Math.max(Number(item.cursor.last_seq || 0), Number(item.worker.acked || 0)),
        ),
      }))
    return { since_hours: Math.round(sinceMs / 3600_000), by_status: byStatus, attempts, lag }
  })
  const value = {
    events,
    generated_at: new Date(now).toISOString(),
  }
  if (cache && db) statusCache.set(db, { at: now, value })
  return value
}
