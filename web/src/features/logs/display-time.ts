import { i18n, t } from '@/i18n'
import { SYSTEM_TIMEZONE } from '@/lib/system-time'

/** Presentation only: preserve timestamps and API boundaries; display in UTC+8. */
function unit(value: number, name: string, digits = 0): string {
  return new Intl.NumberFormat(i18n.language, {
    style: 'unit',
    unit: name,
    unitDisplay: 'short',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value)
}

export function formatTimestamp(value: unknown): string {
  if (!value) return '—'
  const ms = typeof value === 'number' ? value : Date.parse(String(value))
  if (!Number.isFinite(ms)) return String(value)
  return new Date(ms).toLocaleString(i18n.language, {
    timeZone: SYSTEM_TIMEZONE,
  })
}

export function formatAgo(value: unknown, now = Date.now()): string {
  const ms = Date.parse(String(value ?? ''))
  if (!Number.isFinite(ms)) return ''
  const minutes = Math.floor(Math.max(0, now - ms) / 60_000)
  if (minutes < 1) return t('logs:justNow')
  const relative = new Intl.RelativeTimeFormat(i18n.language, {
    numeric: 'always',
    style: 'short',
  })
  if (minutes < 60) return relative.format(-minutes, 'minute')
  const hours = Math.floor(minutes / 60)
  return hours < 24
    ? relative.format(-hours, 'hour')
    : relative.format(-Math.floor(hours / 24), 'day')
}

export function formatCountdown(leftMs: number): string {
  const minutes = Math.floor(Math.max(0, leftMs) / 60_000)
  if (minutes < 1) return '<' + unit(1, 'minute')
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const rest = minutes % 60
  if (days)
    return [unit(days, 'day'), unit(hours, 'hour'), unit(rest, 'minute')].join(
      ' '
    )
  if (hours) return [unit(hours, 'hour'), unit(rest, 'minute')].join(' ')
  return unit(rest, 'minute')
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '-'
  return ms >= 1000
    ? unit(ms / 1000, 'second', 2)
    : unit(Math.round(ms), 'millisecond')
}

export function formatMetricDuration(value: unknown): string {
  if (value == null || !Number.isFinite(Number(value))) return '—'
  const ms = Number(value)
  return ms >= 10_000
    ? unit(ms / 1000, 'second', 1)
    : unit(Math.round(ms), 'millisecond')
}
