/**
 * D 类（统计与看板）接口的并发上限与超时（docs/DATA_ACCESS_AND_API_ARCHITECTURE_20261105.md 第 3 节，技术债 M5）。
 *
 * 路由表（route-table.mjs）里类别为 `stats` 的接口由 panel-routes 在分发入口统一套用，不逐个路由修改：
 * - 并发：每条 stats 路由（方法 + 路径模式）对每个调用方（按请求凭证的摘要区分）同时最多 `route_concurrency` 个，
 *   全部 stats 路由合计最多 `concurrency` 个；
 *   超出时直接返回 503 + Retry-After，不排队（排队只会让慢查询把后面的请求一起拖到超时）。
 * - 超时：处理超过 `timeout_ms` 仍未开始响应时返回 503（stats_timeout），提示缩小时间范围或筛选条件。
 *   底层查询无法中途取消，仍会跑完（主连接上的语句同步执行，计时器只能在语句之间触发）；它占用的并发名额在真正结束时才释放，
 *   所以上限约束的是实际在跑的统计查询数。超时后处理器再写响应会被丢弃。
 *
 * 参数（优先级从高到低）：routing 配置 `panel_stats.{route_concurrency, concurrency, timeout_ms}`、
 * 环境变量 `KIN_STATS_ROUTE_CONCURRENCY` / `KIN_STATS_CONCURRENCY` / `KIN_STATS_TIMEOUT_MS`、默认值。0 表示不限。
 * 计数（放行、繁忙拒绝、超时、当前在跑）由 `/api/panel/database/metrics` 的 `route_budget` 返回。
 */

export const STATS_BUDGET_DEFAULTS = Object.freeze({ route_concurrency: 4, concurrency: 16, timeout_ms: 15_000 })
const RETRY_AFTER_SECONDS = 2
const EXPIRED = Symbol('stats-timeout')
const ENV_KEYS = Object.freeze({
  route_concurrency: 'KIN_STATS_ROUTE_CONCURRENCY',
  concurrency: 'KIN_STATS_CONCURRENCY',
  timeout_ms: 'KIN_STATS_TIMEOUT_MS',
})

function nonNegativeInt(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isInteger(n) && n >= 0 ? n : null
}

/** 生效参数：routing 配置 `panel_stats` > 环境变量 > 默认值；非法值忽略。 */
export function statsBudgetConfig(routing = null, env = process.env) {
  const fromRouting = routing?.panel_stats && typeof routing.panel_stats === 'object' ? routing.panel_stats : {}
  const out = {}
  for (const key of Object.keys(STATS_BUDGET_DEFAULTS))
    out[key] = nonNegativeInt(fromRouting[key]) ?? nonNegativeInt(env?.[ENV_KEYS[key]]) ?? STATS_BUDGET_DEFAULTS[key]
  return out
}

/** 超时后丢弃处理器对这个响应的后续写入（头已发出，再写会抛 ERR_HTTP_HEADERS_SENT）。 */
function detachResponse(res) {
  res.writeHead = () => res
  res.setHeader = () => res
  res.write = () => true
  res.end = () => res
}

/**
 * @param {{ config?: () => object, setTimer?: Function, clearTimer?: Function }} [opts]
 */
export function createStatsBudget({
  config = () => statsBudgetConfig(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const running = new Map()
  let total = 0
  const counters = { admitted: 0, rejected_busy: 0, timed_out: 0 }

  /**
   * 在名额内运行 stats 处理器。`reply(status, body)` 由调用方按面板的 JSON 格式写响应。
   * 返回处理器的返回值；被拒或超时时返回 true（已响应）。
   */
  async function run({ key, res, handler, reply }) {
    const limits = config()
    const current = running.get(key) || 0
    if (
      (limits.route_concurrency > 0 && current >= limits.route_concurrency) ||
      (limits.concurrency > 0 && total >= limits.concurrency)
    ) {
      counters.rejected_busy++
      res.setHeader?.('Retry-After', String(RETRY_AFTER_SECONDS))
      reply(503, {
        ok: false,
        error: { type: 'overloaded_error', code: 'stats_busy', message: '统计查询繁忙，请稍后重试' },
      })
      return true
    }
    counters.admitted++
    running.set(key, current + 1)
    total++
    const release = () => {
      total--
      const left = (running.get(key) || 1) - 1
      if (left > 0) running.set(key, left)
      else running.delete(key)
    }
    const work = Promise.resolve().then(handler)
    work.then(release, release)
    if (!(limits.timeout_ms > 0)) return work
    let timer = null
    const expired = new Promise((resolve) => {
      timer = setTimer(() => resolve(EXPIRED), limits.timeout_ms)
    })
    try {
      const out = await Promise.race([work, expired])
      if (out !== EXPIRED) return out
    } finally {
      clearTimer(timer)
    }
    // 已开始写响应（导出流等）时不打断，等处理器自己结束
    if (res.headersSent) return work
    counters.timed_out++
    work.catch(() => {})
    res.setHeader?.('Retry-After', String(RETRY_AFTER_SECONDS))
    reply(503, {
      ok: false,
      error: {
        type: 'timeout_error',
        code: 'stats_timeout',
        message: `统计查询超过 ${Math.round(limits.timeout_ms / 1000)} 秒未完成，请缩小时间范围或减少筛选条件后重试`,
      },
    })
    detachResponse(res)
    return true
  }

  function stats() {
    return {
      ...counters,
      running: total,
      running_by_route: Object.fromEntries(running),
      limits: config(),
    }
  }

  return { run, stats }
}
