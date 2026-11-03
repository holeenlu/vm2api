import { useTranslation } from 'react-i18next'
import { fmtNum } from '@/lib/format'
import { number } from './portal-model'

export type CacheUsage = {
  requests: number
  cache_read_tokens: number
  cache_creation_tokens: number
  cache_read_known_requests?: number
  cache_creation_known_requests?: number
  cache_complete?: boolean
}

// Partial observations are lower bounds, never zero-filled unknown values.
export function cacheTokenValue(
  row: CacheUsage,
  kind: 'read' | 'creation',
  unknown = '—',
  format: (value: number) => string = number
) {
  const known =
    row[`cache_${kind}_known_requests`] ??
    (row.cache_complete === false ? 0 : row.requests)
  if (!row.requests) return '0'
  if (!known) return unknown
  return `${known < row.requests ? '≥' : ''}${format(row[`cache_${kind}_tokens`])}`
}

export function CacheTokens({ usage }: { usage: CacheUsage }) {
  const { t } = useTranslation('vendor')
  return (
    <span
      title={t('details.cacheTokens', {
        write: cacheTokenValue(usage, 'creation', t('unknown')),
        read: cacheTokenValue(usage, 'read', t('unknown')),
      })}
    >
      {t('details.cacheTokens', {
        write: cacheTokenValue(usage, 'creation', t('unknown'), fmtNum),
        read: cacheTokenValue(usage, 'read', t('unknown'), fmtNum),
      })}
    </span>
  )
}
