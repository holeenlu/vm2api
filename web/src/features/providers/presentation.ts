import type { TFunction } from 'i18next'
import type { ProviderRow } from './queries'

export function resetTime(
  value: string | number | null | undefined,
  t: TFunction
) {
  if (value == null || value === '') return '—'
  const numeric = Number(value)
  const time = Number.isFinite(numeric)
    ? numeric < 1e12
      ? numeric * 1000
      : numeric
    : Date.parse(String(value))
  if (!Number.isFinite(time) || time <= 0) return '—'
  const remaining = Math.max(0, time - Date.now())
  if (remaining < 60_000) return t('providers:recoveringSoon')
  const minutes = Math.ceil(remaining / 60_000)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  return days > 0
    ? t('providers:daysHoursLater', { days, hours: hours % 24 })
    : t('providers:hoursMinutesLater', { hours, minutes: minutes % 60 })
}

export function isActive(row: ProviderRow) {
  return (
    row.status === 'active' &&
    !!row.has_token &&
    row.schedulable !== false &&
    !row.schedule_disabled_reason
  )
}

export function statusLabel(row: ProviderRow, t: TFunction) {
  if (row.status === 'provisioning') return t('providers:status.provisioning')
  if (row.status === 'paused') return t('providers:status.paused')
  if (!row.has_token) return t('providers:status.waitingAuth')
  if (row.schedulable === false || row.schedule_disabled_reason)
    return t('providers:status.schedulePaused')
  return t('providers:status.enabled')
}
