/**
 * 同号槽位检测：两个槽位导入的是同一个上游账号（例如同一 Claude 账号生成的两个 Setup Token）时，
 * 它们共享一份额度，但调度会当成两份独立额度。Setup Token 没有账号 UUID，无法直接比对身份，
 * 这里用已落库的额度观测判定：7 天窗口重置时间相同，且近一天内多次几乎同时的观测值完全一致、
 * 并且这个值本身在变化。两个独立账号恰好同一小时开窗、又逐次同步涨到相同百分比的概率可忽略。
 */
import { windowObservationsSince } from './repos/quota-observations-repo.mjs'

const PAIR_GAP_MS = 10 * 60 * 1000
const MIN_MATCHES = 3
const MIN_DISTINCT = 2
const LOOKBACK_MS = 24 * 3600 * 1000
const CACHE_MS = 5 * 60 * 1000

/**
 * rows: [{ vm_id, used_percent, reset_at, observed_at }]（同一窗口）。
 * 返回 Map<vmId, string[]>：判定为同一账号的其他槽位，按 id 排序。
 */
export function detectSharedQuota(
  rows,
  { gapMs = PAIR_GAP_MS, minMatches = MIN_MATCHES, minDistinct = MIN_DISTINCT } = {},
) {
  const byVm = new Map()
  for (const row of rows || []) {
    const at = Date.parse(row.observed_at)
    const pct = Number(row.used_percent)
    if (!row.vm_id || !Number.isFinite(at) || !Number.isFinite(pct)) continue
    if (!byVm.has(row.vm_id)) byVm.set(row.vm_id, [])
    byVm.get(row.vm_id).push({ at, pct, reset: String(row.reset_at || '') })
  }
  for (const list of byVm.values()) list.sort((a, b) => a.at - b.at)
  const ids = [...byVm.keys()].sort()
  const peers = new Map()
  const link = (a, b) => {
    if (!peers.has(a)) peers.set(a, new Set())
    peers.get(a).add(b)
  }
  for (let i = 0; i < ids.length; i++) {
    const a = byVm.get(ids[i])
    const latestReset = a.at(-1)?.reset
    if (!latestReset) continue
    for (let j = i + 1; j < ids.length; j++) {
      const b = byVm.get(ids[j])
      if (b.at(-1)?.reset !== latestReset) continue
      let matches = 0
      let mismatches = 0
      const values = new Set()
      let k = 0
      for (const x of a) {
        if (x.reset !== latestReset) continue
        while (k + 1 < b.length && Math.abs(b[k + 1].at - x.at) <= Math.abs(b[k].at - x.at)) k++
        const y = b[k]
        if (!y || y.reset !== latestReset || Math.abs(y.at - x.at) > gapMs) continue
        if (y.pct === x.pct) {
          matches++
          values.add(x.pct)
        } else if (Math.abs(y.pct - x.pct) > 1) mismatches++
      }
      if (matches >= minMatches && values.size >= minDistinct && mismatches === 0) {
        link(ids[i], ids[j])
        link(ids[j], ids[i])
      }
    }
  }
  return new Map([...peers].map(([id, set]) => [id, [...set].sort()]))
}

const cache = new WeakMap()

/** 带 5 分钟缓存的同号检测；列表每 5 秒轮询，不必每次重算。失败时返回空结果，不影响列表。 */
export function sharedQuotaPeers(db, now = Date.now()) {
  if (!db) return new Map()
  const hit = cache.get(db)
  if (hit && now - hit.at < CACHE_MS) return hit.peers
  let peers = new Map()
  try {
    peers = detectSharedQuota(windowObservationsSince(db, '7d', new Date(now - LOOKBACK_MS).toISOString()))
  } catch {
    peers = hit?.peers || new Map()
  }
  cache.set(db, { at: now, peers })
  return peers
}
