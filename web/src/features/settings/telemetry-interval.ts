import { t as translate } from '@/i18n'

export const UPLOAD_INTERVAL_DEFAULT = 600
export const UPLOAD_INTERVAL_MIN = 60
export const UPLOAD_INTERVAL_MAX = 86_400

export type IntervalUnit = 'min' | 'hour'

export function getUploadIntervalPresets(): [number, string][] {
  return [
    [300, translate('settings:duration.fiveMinutes')],
    [600, translate('settings:duration.tenMinutes')],
    [1800, translate('settings:duration.thirtyMinutes')],
    [3600, translate('settings:duration.oneHour')],
    [21_600, translate('settings:duration.sixHours')],
    [86_400, translate('settings:duration.day')],
  ]
}

/** Mirrors gateway `telemetryUploadInterval`: whole minutes in 1 min–24 h, else 10 min. */
export function uploadIntervalOf(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number.NaN
  return Number.isInteger(n) &&
    n % 60 === 0 &&
    n >= UPLOAD_INTERVAL_MIN &&
    n <= UPLOAD_INTERVAL_MAX
    ? n
    : UPLOAD_INTERVAL_DEFAULT
}

export function unitOf(seconds: number): IntervalUnit {
  return seconds >= 3600 && seconds % 3600 === 0 ? 'hour' : 'min'
}

export function unitBounds(unit: IntervalUnit): [number, number] {
  return unit === 'hour' ? [1, 24] : [1, 1440]
}

export function amountIn(seconds: number, unit: IntervalUnit): number {
  return unit === 'hour' ? Math.ceil(seconds / 3600) : seconds / 60
}

/** Seconds for `amount` in `unit`, clamped to that unit's range. */
export function secondsFrom(amount: number, unit: IntervalUnit): number {
  const [min, max] = unitBounds(unit)
  const n = Math.min(max, Math.max(min, Math.round(amount)))
  return n * (unit === 'hour' ? 3600 : 60)
}

export function intervalLabel(seconds: number): string {
  if (seconds % 3600 === 0)
    return translate('settings:duration.hours', { value1: seconds / 3600 })
  if (seconds > 3600) {
    const h = Math.floor(seconds / 3600)
    return translate('settings:duration.hoursMinutes', {
      value1: h,
      value2: (seconds % 3600) / 60,
    })
  }
  return translate('settings:minutes', { value1: seconds / 60 })
}
