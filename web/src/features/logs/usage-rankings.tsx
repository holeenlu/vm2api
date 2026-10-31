import { useQuery } from '@tanstack/react-query'
import { i18n } from '@/i18n'
import type { UsageLogFilters } from '@/types/panel-usage-logs'
import { useTranslation } from 'react-i18next'
import { api } from '@/lib/api'
import { usageLogFiltersQuery } from './search'

type Entry = {
  id: string
  name: string
  owner: string | null
  requests: number
  tokens: number
  cost: number | null
}
export function UsageRankings({
  filters,
  scope,
  canSeeMoney,
  showOwner,
  onSelect,
}: {
  filters: UsageLogFilters
  scope: 'user' | 'key'
  canSeeMoney: boolean
  showOwner: boolean
  onSelect: (id: string) => void
}) {
  const { t: translate } = useTranslation('logs')

  const q = useQuery({
    queryKey: ['panel', 'usage-rankings', filters, scope],
    queryFn: ({ signal }) =>
      api<{ entries: Entry[]; sampled: number; capped: boolean }>(
        '/api/panel/usage-logs/ranking?' +
          usageLogFiltersQuery(filters) +
          '&scope=' +
          scope,
        { signal }
      ),
  })
  return (
    <div className='overflow-auto rounded border'>
      {q.isLoading ? (
        <p className='p-4'>{translate('logs:aggregating')}</p>
      ) : q.error ? (
        <p role='alert' className='p-4 text-destructive'>
          {q.error.message}
        </p>
      ) : (
        <>
          {q.data?.capped ? (
            <p className='bg-amber-50 p-3 text-sm text-amber-800'>
              {translate('logs:rankingTruncated', { count: q.data.sampled })}
            </p>
          ) : null}
          <table className='w-full text-sm'>
            <thead>
              <tr className='border-b bg-muted/40'>
                {[
                  translate('logs:name'),
                  ...(scope === 'key' && showOwner
                    ? [translate('logs:ownerUser')]
                    : []),
                  translate('logs:requests'),
                  'Token',
                  ...(canSeeMoney ? [translate('logs:chargedUsd')] : []),
                ].map((v) => (
                  <th key={v} className='p-3 text-left'>
                    {v}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(Array.isArray(q.data?.entries) ? q.data.entries : []).map(
                (e) => (
                  <tr key={e.id} className='border-b'>
                    <td className='p-3'>
                      <button
                        className='text-primary underline'
                        onClick={() => onSelect(e.id)}
                      >
                        {e.name}
                      </button>
                    </td>
                    {scope === 'key' && showOwner ? (
                      <td className='p-3'>{e.owner || '—'}</td>
                    ) : null}
                    <td className='p-3'>{e.requests}</td>
                    <td className='p-3'>
                      {Number(e.tokens || 0).toLocaleString(i18n.language)}
                    </td>
                    {canSeeMoney ? (
                      <td className='p-3'>
                        {e.cost == null ? '—' : e.cost.toFixed(6)}
                      </td>
                    ) : null}
                  </tr>
                )
              )}
            </tbody>
          </table>
          {!Array.isArray(q.data?.entries) || !q.data.entries.length ? (
            <p className='p-4'>{translate('logs:noRecords')}</p>
          ) : null}
        </>
      )}
    </div>
  )
}
