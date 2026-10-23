import { i18n, t } from '@/i18n'
import { fixedNumber, localeNumber } from '@/lib/locale-format'

export function pct(value: unknown): number {
  if (value == null) return 0
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  if (n < 0) return 0
  if (n > 100) return 100
  // Extra utilization is 0–1+ (1.04 → 104%). Leftover Settings percents are whole 2–100.
  // `1` is 100% on the ratio contract. Codex `used_percent` goes through usedPctOf().
  const leftoverSettingsPct = n > 1 && n <= 100 && Number.isInteger(n)
  return leftoverSettingsPct ? n : n * 100
}

export function usedPctOf(
  source:
    | {
        utilization_5h?: unknown
        utilization_7d?: unknown
        codex_usage?: {
          windows?: Array<{ id?: string; used_percent?: unknown }>
        } | null
      }
    | null
    | undefined,
  window: '5h' | '7d'
): number {
  const hit = source?.codex_usage?.windows?.find((row) => row?.id === window)
  if (hit?.used_percent != null && hit.used_percent !== '') {
    const n = Number(hit.used_percent)
    if (Number.isFinite(n)) return Math.max(0, Math.min(100, n))
  }
  return pct(window === '5h' ? source?.utilization_5h : source?.utilization_7d)
}

export function fmtNum(n: unknown): string {
  const v = Number(n) || 0
  if (v >= 1e9) return `${fixedNumber(v / 1e9, 1)}B`
  if (v >= 1e6) return `${fixedNumber(v / 1e6, 1)}M`
  if (v >= 1e3) return `${fixedNumber(v / 1e3, 1)}K`
  return localeNumber(Math.round(v), { useGrouping: false })
}

export function fmtUsd(n: unknown, digits?: number): string {
  const v = Number(n)
  if (!Number.isFinite(v) || v === 0) return '$0'
  const d = digits ?? (Math.abs(v) >= 100 ? 2 : Math.abs(v) >= 1 ? 3 : 4)
  return `$${fixedNumber(v, d)}`
}

function nestedCached(usage: Record<string, unknown>, key: string): unknown {
  const details = usage[key]
  if (!details || typeof details !== 'object') return undefined
  return (details as Record<string, unknown>).cached_tokens
}

export function fmtTok(
  row: Record<string, unknown> | null | undefined
): string {
  if (!row) return '—'
  const usage = (row.usage as Record<string, unknown> | undefined) || {}
  const inn = row.input_tokens ?? usage.input_tokens
  const out = row.output_tokens ?? usage.output_tokens
  // OpenAI/Codex rows may only carry the cache read nested under *_tokens_details.
  const cr =
    row.cache_read_tokens ??
    usage.cache_read_input_tokens ??
    nestedCached(usage, 'input_tokens_details') ??
    nestedCached(usage, 'prompt_tokens_details')
  const cc = row.cache_creation_tokens ?? usage.cache_creation_input_tokens
  if (inn == null && out == null && cr == null && cc == null) return '—'
  let s = `${inn || 0}/${out || 0}`
  if (cr || cc) s += ` · c${Number(cr) || 0}/${Number(cc) || 0}`
  return s
}

export function fmtExpiresAt(value: unknown): string {
  if (!value) return '—'
  const ms = typeof value === 'number' ? value : Date.parse(String(value))
  if (!Number.isFinite(ms)) return String(value)
  return new Date(ms).toLocaleString(i18n.resolvedLanguage)
}

export function remainPct(used: unknown): number {
  return Math.max(0, 100 - pct(used))
}

/**
 * 剩余时长 → 分钟精度倒计时：`3d4h12m` / `2h17m` / `45m` / `<1m`。
 * 秒级抖动无运营意义，统一向下取整到分钟。
 */
export function fmtCountdown(leftMs: number): string {
  const totalMin = Math.floor(Math.max(0, leftMs) / 60000)
  if (totalMin < 1) return '<1m'
  const d = Math.floor(totalMin / 1440)
  const h = Math.floor((totalMin % 1440) / 60)
  const m = totalMin % 60
  if (d > 0)
    return `${fixedNumber(d, 0)}d${fixedNumber(h, 0)}h${fixedNumber(m, 0)}m`
  if (h > 0) return `${fixedNumber(h, 0)}h${fixedNumber(m, 0)}m`
  return `${fixedNumber(m, 0)}m`
}

/** ISO 时间 → `刚刚` / `5 分钟前` / `3 小时前` / `2 天前`；无法解析返回空串。 */
export function fmtAgo(value: unknown, now: number = Date.now()): string {
  const timestamp = Date.parse(String(value ?? ''))
  if (!Number.isFinite(timestamp)) return ''
  const min = Math.floor(Math.max(0, now - timestamp) / 60000)
  if (min < 1) return t('lib:format.justNow')
  if (min < 60) return t('lib:format.minutesAgo', { count: min })
  const h = Math.floor(min / 60)
  if (h < 24) return t('lib:format.hoursAgo', { count: h })
  return t('lib:format.daysAgo', { count: Math.floor(h / 24) })
}

export function fmtMs(ms: unknown): string {
  if (ms == null || !Number.isFinite(Number(ms))) return '—'
  const n = Number(ms)
  if (n >= 10000) return `${fixedNumber(n / 1000, 1)}s`
  return `${fixedNumber(Math.round(n), 0)}ms`
}

/** 设置项用的人读时长：`500 毫秒` / `45 秒` / `2 分钟` / `1 分 30 秒`。 */
export function fmtDuration(ms: number): string {
  const n = Math.max(0, Math.round(Number(ms) || 0))
  if (n < 1000)
    return t('lib:format.milliseconds', {
      value: localeNumber(n, { useGrouping: false }),
    })
  const sec = n / 1000
  if (sec < 60)
    return t('lib:format.seconds', {
      value: fixedNumber(sec, Number.isInteger(sec) ? 0 : 1),
    })
  const min = Math.floor(sec / 60)
  const rest = Math.round(sec - min * 60)
  return rest
    ? t('lib:format.minutesSeconds', {
        minutes: localeNumber(min),
        seconds: localeNumber(rest),
      })
    : t('lib:format.minutes', { value: localeNumber(min) })
}

export function fmtRate(n: unknown, digits?: number): string {
  if (n == null || !Number.isFinite(Number(n))) return '—'
  const v = Number(n)
  if (v >= 100) return fixedNumber(v, 0)
  if (v >= 10) return fixedNumber(v, 1)
  if (v >= 1) return fixedNumber(v, 2)
  return fixedNumber(v, digits ?? 3)
}

export function fmtBytes(n: unknown): string {
  const v = Number(n)
  if (!Number.isFinite(v) || v <= 0) return '0B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = v
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  return `${fixedNumber(value, value >= 10 || i === 0 ? 0 : 1)}${units[i]}`
}
