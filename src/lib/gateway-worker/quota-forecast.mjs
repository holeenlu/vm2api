import { SUCCESS_PRED } from '../db/repos/usage-log-preds.mjs'
import { capacityEstimateStatus, scaleCapacity, windowCapacity } from '../usage/quota-capacity.mjs'
import { estimateFromForecast, usedRatioOf } from '../admin/window-estimate.mjs'

/**
 * Codex 账号额度预测（对齐 codex-proxy-rs admin quota_forecast / quota_forecast_sampling）。
 *
 * 只读估算，不参与计费或调度。周窗口（约 7 天）直接预测本周期容量；没有月窗口时
 * 用周窗口按 30/7 折算并标记 extrapolated。采样与外推见 `usage/quota-capacity.mjs`。
 */

const DAY_SECONDS = 86_400

const UNAVAILABLE_REASONS = {
  no_window: '缺少周额度窗口，请刷新账号额度',
  window_expired: '额度窗口已过期或无效，请刷新账号额度',
  no_cycle_snapshot: '缺少本周期的额度快照，请刷新账号额度',
  used_unknown: '已用比例未知，请刷新账号额度',
  resampling: '额度回落或记录不连续，正在重新积累配对样本',
  partial_cycle: '周期初记录不完整，正在积累至少 5 个百分点的配对观测',
  no_usage: '本周期没有网关用量记录，无法预测额度',
  low_progress: '有效额度进度不足 5 个百分点或采样边界无效',
  no_estimate: '本周期缺少可用于估算的 Token 或费用数据',
}

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

/**
 * 纯函数：quota 为最新额度快照（updated_at 为观测时间），observations 为本周期逐请求额度观测，
 * usageRows 为本账号的用量行（completedAt/included/tokens/missingTokens/cost）。
 */
export function computeQuotaForecast({ quota, accountAddedAt, now, observations = [], usageRows = [] }) {
  const window = weeklyQuotaWindow(quota)
  const capacity = windowCapacity({
    window,
    observedAt: Date.parse(quota?.updated_at || ''),
    observations: observations.flatMap((observation) => {
      const candidate = weeklyQuotaWindow(observation.quota)
      return candidate && candidate.key === window?.key
        ? [{ observedAt: observation.observedAt, resetAt: candidate.resetAt, usedPercent: candidate.usedPercent }]
        : []
    }),
    usageRows,
    coveredSince: accountAddedAt,
    now,
  })
  return ['weekly', 'monthly'].map((period) => {
    const extrapolated = Boolean(window) && period !== 'weekly'
    const targetSeconds = window && !extrapolated ? window.seconds : (period === 'weekly' ? 7 : 30) * DAY_SECONDS
    // Codex 只有周窗口；月预测按周窗口折算
    const factor = window ? targetSeconds / window.seconds : 1
    const tokens = capacity.capacity_tokens == null ? null : scaleCapacity(capacity.capacity_tokens, factor)
    return {
      period,
      target_seconds: targetSeconds,
      extrapolated,
      source: capacity.source ? { label: window.label, ...capacity.source } : null,
      reason: capacity.reason,
      unavailable_reason: capacity.reason ? UNAVAILABLE_REASONS[capacity.reason] : null,
      low_sample: capacity.low_sample,
      incomplete_cost: window ? capacity.incomplete_cost : false,
      incomplete_tokens: capacity.incomplete_tokens,
      estimated_tokens: tokens == null ? null : Math.round(tokens),
      estimated_usd: capacity.capacity_usd == null ? null : scaleCapacity(capacity.capacity_usd, factor),
    }
  })
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

const LIST_FORECAST_TTL_MS = 5 * 60_000
const listCache = new WeakMap()

/**
 * Codex account list rows: attach `usage.estimate_7d` (weekly capacity next to the 7D spend), the
 * same estimate shape VM rows carry. The list polls every few seconds, so each account's forecast
 * is reused until its weekly used% / reset changes or 5 minutes pass.
 */
export function attachListForecasts(db, items, now = Date.now()) {
  let cache = listCache.get(db)
  if (!cache) {
    cache = new Map()
    listCache.set(db, cache)
  }
  for (const item of items) {
    const window = weeklyQuotaWindow(item.quota)
    const key = `${window?.usedPercent ?? ''}\0${window?.resetAt ?? ''}`
    let hit = cache.get(item.id)
    if (!hit || hit.key !== key || now - hit.at >= LIST_FORECAST_TTL_MS) {
      const weekly = quotaForecastForAccount(db, item, now).forecasts.find((row) => row.period === 'weekly')
      hit = { key, at: now, weekly }
      cache.set(item.id, hit)
    }
    const weekly = hit.weekly
    if (!item.usage) continue
    item.usage.estimate_7d = estimateFromForecast({
      forecast: {
        status: capacityEstimateStatus(weekly?.reason),
        capacity_usd: weekly?.estimated_usd ?? null,
        capacity_tokens: weekly?.estimated_tokens ?? null,
        low_sample: weekly?.low_sample,
        incomplete_cost: weekly?.incomplete_cost,
      },
      spentUsd: item.usage.window_7d_cost,
      usedRatio: usedRatioOf(window?.usedPercent),
    })
  }
  return items
}
