import { i18n } from '@/i18n'
import { fmtBytes, fmtNum } from '@/lib/format'
import { SYSTEM_TIMEZONE } from '@/lib/system-time'

function finite(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null
  return value
}

export function formatMetricBytes(value: number | null): string {
  return finite(value) == null ? '—' : fmtBytes(value)
}

export function formatMetricNumber(value: number | null): string {
  return finite(value) == null ? '—' : fmtNum(value)
}

export function formatMetricPercent(value: number | null, digits = 1): string {
  const rate = finite(value)
  return rate == null ? '—' : `${(rate * 100).toFixed(digits)}%`
}

export function promptCacheRate({
  input = 0,
  read = 0,
  creation = 0,
}: {
  input?: number
  read?: number
  creation?: number
}): number | null {
  const denominator = input + read + creation
  return denominator > 0 ? read / denominator : null
}

export function formatMetricTime(value: string | null): string {
  if (!value) return '—'
  const parsed = Date.parse(value)
  return Number.isFinite(parsed)
    ? new Date(parsed).toLocaleString(i18n.language, {
        timeZone: SYSTEM_TIMEZONE,
      })
    : '—'
}
