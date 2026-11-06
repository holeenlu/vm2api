/**
 * 控制面运行状态（最终审计 U8）：四个开关的生效值、事件收件箱统计、刷新租约状态与冲突，供「Gateway Worker」页与排障使用。
 * 开关值拼错时按默认值运行，这里标出并在启动时告警一次；Redis 地址可能带密码，只报告是否配置。
 */
import { EXECUTOR_EVENTS_MODES, executorEventsMode } from './contract.mjs'
import { refreshLeaseDenials, refreshLeaseEnabled } from './refresh-lease.mjs'
import { credentialCustodyMode } from './credential-custody.mjs'
import { createExecutorEventIngest } from './event-ingest.mjs'
import { refreshLeaseRepo } from './repos/refresh-lease-repo.mjs'

const raw = (env, name) => String(env[name] ?? '').trim()

// 拼错的原值写进日志与接口：疑似地址或密码（含 :// 或 @、过长）时只保留前 4 个字符（复核 O7）
function maskGiven(value) {
  return /:\/\/|@/.test(value) || value.length > 16 ? `${value.slice(0, 4)}…(${value.length})` : value
}

/** 各开关：生效值、是否为合法取值；非法时带上（截断后的）原始值。 */
export function controlPlaneSwitches(env = process.env) {
  const item = (name, value, allowed) => {
    const given = raw(env, name)
    const valid = !given || allowed.includes(given.toLowerCase())
    return { name, value, valid, allowed, ...(valid ? {} : { given: maskGiven(given) }) }
  }
  return [
    item('KIN_EXECUTOR_EVENTS', executorEventsMode(env), EXECUTOR_EVENTS_MODES),
    item('KIN_REFRESH_LEASE', refreshLeaseEnabled(env) ? 'on' : 'off', ['on', 'off']),
    item('KIN_CREDENTIAL_CUSTODY', credentialCustodyMode(env), ['worker', 'control']),
    // 控制面不读 Redis：这里只是控制面的环境（同机托管的 Worker 继承它），各实例实际是否在用见实例的 shared_state（复核 O2）
    {
      name: 'KIN_REDIS_URL',
      value: raw(env, 'KIN_REDIS_URL') ? 'configured' : 'unset',
      valid: true,
      scope: 'control_plane_env',
    },
  ]
}

let logged = false
/** 启动时打印一次生效的开关值，非法值告警（每个进程只打印一次；once 为 false 时总是打印，供测试）。 */
export function logControlPlaneSwitches({ env = process.env, log = console, once = true } = {}) {
  if (once && logged) return
  logged = true
  const switches = controlPlaneSwitches(env)
  log.info?.(`control plane switches: ${switches.map((item) => `${item.name}=${item.value}`).join(' ')}`)
  for (const item of switches.filter((entry) => !entry.valid))
    log.warn?.(
      `control plane switch ${item.name}=${JSON.stringify(item.given)} is not one of ${item.allowed.join('/')}; running as ${item.value}`,
    )
}

// 汇总结果缓存 60 秒（复核 O1）：收件箱统计已走覆盖索引（迁移 121，只扫近 24 小时的索引范围），
// 租约与实例列表等其他部分每次打开页面仍要查库，缓存保留
const STATUS_CACHE_MS = 60_000
const statusCache = new WeakMap()

/** 汇总状态：开关、近 24 小时事件收件箱、刷新租约。各部分读取失败时只该部分为 null，不影响其他部分。 */
export async function controlPlaneStatus({
  db,
  repo,
  env = process.env,
  sinceMs = 24 * 3600_000,
  now = Date.now(),
  cache = true,
} = {}) {
  const cached = cache && db ? statusCache.get(db) : null
  if (cached && now - cached.at < STATUS_CACHE_MS) return { ...cached.value, switches: controlPlaneSwitches(env) }
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
    // 未拉取：Worker 写到的位置减去控制面已处理与 Worker 已确认中较大的一个（接收器从这里开始拉取）；
    // off 模式不消费，不计（复核 O4）
    const lag =
      stats.mode === 'off'
        ? []
        : stats.instances
            .filter((item) => item.worker && item.cursor)
            .map((item) => ({
              instance_id: item.instance_id,
              lag: Math.max(
                0,
                Number(item.worker.head || 0) -
                  Math.max(Number(item.cursor.last_seq || 0), Number(item.worker.acked || 0)),
              ),
            }))
    return { mode: stats.mode, since_hours: Math.round(sinceMs / 3600_000), by_status: byStatus, attempts, lag }
  })
  const leases = await safe(async () => {
    const store = refreshLeaseRepo(db)
    const at = new Date(now).toISOString()
    const byState = Object.fromEntries((await store.countsByState(at)).map((row) => [row.state, Number(row.n || 0)]))
    return {
      by_state: byState,
      ambiguous: (await store.listAmbiguous(at, 20)).map((row) => ({ ...row })),
      denials: refreshLeaseDenials(),
    }
  })
  const value = {
    switches: controlPlaneSwitches(env),
    events,
    refresh_leases: leases,
    generated_at: new Date(now).toISOString(),
  }
  if (cache && db) statusCache.set(db, { at: now, value })
  return value
}
