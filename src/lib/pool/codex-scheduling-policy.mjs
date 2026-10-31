/** CPR selection weights adapted to VM capacity and commercial priority. */
export const CODEX_SMART_WEIGHTS = Object.freeze({ load: 1, quota: 0.8, health: 1, latency: 0.5, reset: 0, queue: 0 })
export function normalizeCodexScheduling(raw = {}, { strict = false } = {}) {
  const strategies = ['smart', 'quota_reset_priority', 'round_robin', 'sticky']
  const affinities = ['strict', 'preferred', 'relaxed']
  const bad = () => {
    throw Object.assign(new TypeError('Invalid codex.scheduling policy'), { code: 'invalid_codex_scheduling' })
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    if (strict) bad()
    raw = {}
  }
  if (strict && Object.keys(raw).some((key) => !['strategy', 'affinity', 'smart_weights'].includes(key))) bad()
  if (strict && raw.strategy != null && !strategies.includes(raw.strategy)) bad()
  if (strict && raw.affinity != null && !affinities.includes(raw.affinity)) bad()
  const weights = { ...CODEX_SMART_WEIGHTS }
  if (raw.smart_weights != null) {
    if (typeof raw.smart_weights !== 'object' || Array.isArray(raw.smart_weights)) {
      if (strict) bad()
    } else
      for (const [key, value] of Object.entries(raw.smart_weights)) {
        if (
          !Object.hasOwn(weights, key) ||
          typeof value !== 'number' ||
          !Number.isFinite(value) ||
          value < 0 ||
          value > 10 ||
          Math.round(value * 10) / 10 !== value
        ) {
          if (strict) bad()
        } else weights[key] = value
      }
  }
  if (!Object.values(weights).some((n) => n > 0)) {
    if (strict) bad()
    Object.assign(weights, CODEX_SMART_WEIGHTS)
  }
  return {
    strategy: strategies.includes(raw.strategy) ? raw.strategy : 'smart',
    affinity: affinities.includes(raw.affinity) ? raw.affinity : 'preferred',
    smart_weights: weights,
  }
}
