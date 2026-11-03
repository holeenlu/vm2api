import { SUCCESS_PRED } from '../db/repos/usage-log-preds.mjs'

/**
 * Codex 账号额度预测（对齐 codex-proxy-rs admin quota_forecast / quota_forecast_sampling）。
 *
 * 只读估算，不参与计费或调度。周窗口（约 7 天）直接预测本周期容量；没有月窗口时
 * 用周窗口按 30/7 折算并标记 extrapolated。采样把同一周期内按时间排序的额度观测
 * 切成至少 5 个百分点的连续块，取最近 3 个完整块及尾部；剩余额度按该段的消耗比例外推：
 *   (本周期已记录 + 样本用量 × (100 − 已用%) / 样本进度%) × 目标秒数 / 窗口秒数
 */

const DAY_SECONDS = 86_400
const MIN_USED_PERCENT = 5
const LOW_SAMPLE_PERCENT = 10
const RECENT_BLOCKS = 3
const RESET_JITTER_MS = 2_000
export const MAX_FORECAST_HISTORY_POINTS = 128

function weekWindow(seconds) {
  return seconds >= 6 * DAY_SECONDS && seconds <= 8 * DAY_SECONDS
}

/** 账号级周窗口：Codex 头部的 primary/secondary 中窗口时长约 7 天、带 reset 的那个。 */
export function weeklyQuotaWindow(quota) {
  for (const key of ['secondary_window', 'primary_window']) {
    const window = quota?.[key]
    const seconds = Number(window?.window_minutes) * 60
    const resetAt = Date.parse(window?.reset_at || '')
    if (Number.isFinite(seconds) && weekWindow(seconds) && Number.isFinite(resetAt)) {
      const percent = Number(window.used_percent)
      return {
        key,
        label: '7d',
        seconds,
        resetAt,
        usedPercent: Number.isFinite(percent) && percent >= 0 && percent <= 100 ? percent : null,
      }
    }
  }
  return null
}

function emptyUsage() {
  return {
    request_count: 0,
    tokens: 0,
    missing_token_count: 0,
    known_cost_count: 0,
    unavailable_cost_count: 0,
    usd: 0,
    excluded_request_count: 0,
  }
}

function difference(current, baseline) {
  const out = {}
  for (const key of Object.keys(current)) {
    const value = current[key] - baseline[key]
    if (!Number.isFinite(value) || value < (key === 'usd' ? -1e-9 : 0)) return null
    out[key] = key === 'usd' ? Math.max(0, value) : value
  }
  return out
}

/** 累计用量：usage_logs 行按完成时间累加到每个截止点。 */
export function cumulativeUsageAt(rows, cutoff) {
  const usage = emptyUsage()
  for (const row of rows) {
    if (row.completedAt > cutoff) continue
    if (!row.included) {
      usage.excluded_request_count += 1
      continue
    }
    usage.request_count += 1
    usage.tokens += row.tokens
    if (row.missingTokens) usage.missing_token_count += 1
    if (row.cost == null) usage.unavailable_cost_count += 1
    else {
      usage.known_cost_count += 1
      usage.usd += row.cost
    }
  }
  return usage
}

/** CPR select_forecast_sample：≥5pp 连续块，最近 3 块 + 尾部；>1pp 的回落视为不连续并重建。 */
export function selectForecastSample({ startAt, current, history, interrupted = false }) {
  const points = history
    .filter(
      (point) =>
        startAt <= point.observedAt &&
        point.observedAt < current.observedAt &&
        Number.isFinite(point.usedPercent) &&
        point.usedPercent >= 0 &&
        point.usedPercent <= 100,
    )
    .sort((a, b) => a.observedAt - b.observedAt)
  const sample = {
    method: 'cumulative',
    startAt,
    endAt: current.observedAt,
    baselinePercent: 0,
    sampledPercent: current.usedPercent,
    blockCount: 0,
    observationCount: points.length,
    discontinuous: interrupted,
    cycleUsage: current.usage,
    usage: current.usage,
  }
  points.push(current)
  const cycleBaseline = interrupted ? points[0] : null
  let anchors = []
  let highWater = null
  for (const point of points) {
    if (highWater) {
      if (point.observedAt <= highWater.observedAt) continue
      if (point.usedPercent < highWater.usedPercent) {
        if (highWater.usedPercent - point.usedPercent <= 1) continue
        sample.discontinuous = true
        anchors = []
      }
    }
    highWater = point
    if (!anchors.length || point.usedPercent - anchors[anchors.length - 1].usedPercent >= MIN_USED_PERCENT) {
      anchors.push(point)
    }
  }
  const last = points[points.length - 1]
  if (cycleBaseline) {
    const usage = difference(last.usage, cycleBaseline.usage)
    if (!usage) {
      sample.discontinuous = true
      return sample
    }
    sample.cycleUsage = usage
  }
  if (anchors.length < 2) return sample
  const baselineIndex = Math.max(0, anchors.length - (RECENT_BLOCKS + 1))
  const baseline = anchors[baselineIndex]
  const progress = last.usedPercent - baseline.usedPercent
  if (!Number.isFinite(progress) || progress < MIN_USED_PERCENT) return sample
  const usage = difference(last.usage, baseline.usage)
  if (!usage) {
    sample.discontinuous = true
    return sample
  }
  if (usage.request_count === 0) return sample
  return {
    ...sample,
    method: 'incremental',
    startAt: baseline.observedAt,
    baselinePercent: baseline.usedPercent,
    sampledPercent: progress,
    blockCount: anchors.length - baselineIndex - 1,
    usage,
    discontinuous: false,
  }
}

function estimate(value, factor) {
  const result = value * factor
  return Number.isFinite(result) && result >= 0 ? result : null
}

/**
 * 纯函数：quota 为最新额度快照（updated_at 为观测时间），observations 为本周期逐请求额度观测，
 * usageRows 为本账号的用量行（completedAt/included/tokens/missingTokens/cost）。
 */
export function computeQuotaForecast({ quota, accountAddedAt, now, observations = [], usageRows = [] }) {
  const window = weeklyQuotaWindow(quota)
  const observedAt = Date.parse(quota?.updated_at || '')
  return ['weekly', 'monthly'].map((period) => {
    const forecast = {
      period,
      target_seconds: (period === 'weekly' ? 7 : 30) * DAY_SECONDS,
      extrapolated: false,
      source: null,
      unavailable_reason: '缺少周额度窗口，请刷新账号额度',
      low_sample: false,
      incomplete_cost: false,
      incomplete_tokens: false,
      estimated_tokens: null,
      estimated_usd: null,
    }
    if (!window) return forecast
    // Codex 只有周窗口；月预测按周窗口折算
    forecast.extrapolated = period !== 'weekly'
    if (!forecast.extrapolated) forecast.target_seconds = window.seconds
    const start = window.resetAt - window.seconds * 1000
    const inCycle = Number.isFinite(observedAt) && start <= observedAt && observedAt <= now
    const cycleRows = usageRows.filter(
      (row) => row.completedAt >= start && row.completedAt <= (inCycle ? observedAt : now),
    )
    const cycleUsage = cumulativeUsageAt(cycleRows, inCycle ? observedAt : now)
    let interrupted = false
    const history = []
    for (const observation of observations) {
      const candidate = weeklyQuotaWindow(observation.quota)
      if (!candidate || candidate.key !== window.key || candidate.usedPercent == null) continue
      if (Math.abs(candidate.resetAt - window.resetAt) > RESET_JITTER_MS) {
        // 同周期内 reset 漂移超出容差：窗口被重置或改写，本周期从新观测重新计数
        if (observation.observedAt >= start) interrupted = true
        continue
      }
      history.push({
        observedAt: observation.observedAt,
        usedPercent: candidate.usedPercent,
        usage: cumulativeUsageAt(cycleRows, observation.observedAt),
      })
    }
    const sample =
      inCycle && window.usedPercent != null
        ? selectForecastSample({
            startAt: start,
            current: { observedAt, usedPercent: window.usedPercent, usage: cycleUsage },
            history: thin(history),
            interrupted,
          })
        : null
    const usage = sample?.cycleUsage || cycleUsage
    forecast.source = {
      label: window.label,
      used_percent: window.usedPercent,
      observed_at: Number.isFinite(observedAt) ? new Date(observedAt).toISOString() : null,
      reset_at: new Date(window.resetAt).toISOString(),
      tokens: usage.tokens,
      usd: usage.known_cost_count > 0 ? usage.usd : null,
    }
    forecast.incomplete_cost =
      usage.unavailable_cost_count > 0 || usage.known_cost_count === 0 || usage.known_cost_count !== usage.request_count
    forecast.incomplete_tokens = usage.missing_token_count > 0
    if (!(start <= now && now < window.resetAt)) {
      forecast.unavailable_reason = '额度窗口已过期或无效，请刷新账号额度'
      return forecast
    }
    if (!inCycle) {
      forecast.unavailable_reason = '缺少本周期的额度快照，请刷新账号额度'
      return forecast
    }
    if (sample.discontinuous) {
      forecast.unavailable_reason = '额度回落或记录不连续，正在重新积累配对样本'
      return forecast
    }
    if (accountAddedAt > start && sample.method === 'cumulative') {
      forecast.unavailable_reason = '周期初记录不完整，正在积累至少 5 个百分点的配对观测'
      return forecast
    }
    if (window.usedPercent == null) {
      forecast.unavailable_reason = '已用比例未知，请刷新账号额度'
      return forecast
    }
    if (usage.request_count === 0) {
      forecast.unavailable_reason = '本周期没有网关用量记录，无法预测额度'
      return forecast
    }
    if (
      !(
        sample.startAt >= start &&
        sample.sampledPercent >= MIN_USED_PERCENT &&
        sample.sampledPercent <= window.usedPercent
      )
    ) {
      forecast.unavailable_reason = '有效额度进度不足 5 个百分点或采样边界无效'
      return forecast
    }
    forecast.low_sample =
      sample.sampledPercent < LOW_SAMPLE_PERCENT || (sample.method === 'incremental' && sample.blockCount < 2)
    const factor = forecast.target_seconds / window.seconds
    const remainingFactor = (100 - window.usedPercent) / sample.sampledPercent
    const remainingTokens = sample.usage.tokens > 0 ? estimate(sample.usage.tokens, remainingFactor) : null
    const tokens = remainingTokens == null ? null : estimate(usage.tokens + remainingTokens, factor)
    forecast.estimated_tokens = tokens == null ? null : Math.round(tokens)
    const remainingUsd =
      sample.usage.known_cost_count > 0 && sample.usage.usd >= 0 ? estimate(sample.usage.usd, remainingFactor) : null
    forecast.estimated_usd =
      usage.known_cost_count > 0 && remainingUsd != null ? estimate(usage.usd + remainingUsd, factor) : null
    forecast.unavailable_reason =
      forecast.estimated_tokens == null && forecast.estimated_usd == null
        ? '本周期缺少可用于估算的 Token 或费用数据'
        : null
    return forecast
  })
}

// 观测点按时间均匀抽取到上限，始终保留最后一个
function thin(points) {
  if (points.length <= MAX_FORECAST_HISTORY_POINTS) return points
  const sorted = [...points].sort((a, b) => a.observedAt - b.observedAt)
  const step = sorted.length / MAX_FORECAST_HISTORY_POINTS
  const out = []
  for (let i = 0; i < MAX_FORECAST_HISTORY_POINTS - 1; i++) out.push(sorted[Math.floor(i * step)])
  out.push(sorted[sorted.length - 1])
  return out
}

/** 读取 Gateway 账号的额度快照、Receipt 观测与用量行并计算预测。 */
export function quotaForecastForAccount(db, account, now = Date.now()) {
  const quota = account?.quota || null
  const window = weeklyQuotaWindow(quota)
  const start = window ? new Date(window.resetAt - window.seconds * 1000).toISOString() : new Date(now).toISOString()
  const observations = db
    .prepare(
      `SELECT r.finished_at, r.quota_json FROM gateway_worker_receipts r
         JOIN gateway_worker_account_bindings b
           ON b.gateway_instance_id=r.gateway_instance_id AND b.runtime_account_id=r.runtime_account_id
        WHERE b.account_resource_id=? AND r.quota_json IS NOT NULL AND r.finished_at>=?
        ORDER BY r.finished_at LIMIT 5000`,
    )
    .all(account.id, start)
    .map((row) => {
      let parsed = null
      try {
        parsed = JSON.parse(row.quota_json)
      } catch {}
      return { observedAt: Date.parse(row.finished_at), quota: parsed }
    })
    .filter((row) => Number.isFinite(row.observedAt) && row.quota)
  const usageRows = db
    .prepare(
      `SELECT created_at, duration_ms, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, total_cost,
              CASE WHEN ${SUCCESS_PRED} THEN 1 ELSE 0 END AS ok
         FROM usage_logs WHERE execution_kind='gateway_worker' AND account_resource_id=? AND created_at>=?`,
    )
    .all(account.id, start)
    .map((row) => {
      const tokens =
        Number(row.input_tokens || 0) +
        Number(row.output_tokens || 0) +
        Number(row.cache_read_tokens || 0) +
        Number(row.cache_creation_tokens || 0)
      return {
        completedAt: Date.parse(row.created_at) + Math.max(0, Number(row.duration_ms) || 0),
        included: row.ok === 1,
        tokens,
        missingTokens: row.input_tokens == null || row.output_tokens == null,
        cost: row.total_cost == null ? null : Number(row.total_cost),
      }
    })
    .filter((row) => Number.isFinite(row.completedAt))
  return {
    account_id: account.id,
    generated_at: new Date(now).toISOString(),
    forecasts: computeQuotaForecast({
      quota,
      accountAddedAt: Date.parse(account.created_at || '') || 0,
      now,
      observations,
      usageRows,
    }),
  }
}
