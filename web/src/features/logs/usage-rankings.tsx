import { useQuery } from '@tanstack/react-query'
import type { UsageLogFilters } from '@/types/panel-usage-logs'
import { api } from '@/lib/api'
import { usageLogFiltersQuery } from './search'

type Entry = {
  id: string
  name: string
  owner: string | null
  requests: number
  tokens: number
  cost: number | null
  pending: number
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
        <p className='p-4'>正在汇总…</p>
      ) : q.error ? (
        <p role='alert' className='p-4 text-destructive'>
          {q.error.message}
        </p>
      ) : (
        <>
          {q.data?.capped ? (
            <p className='bg-amber-50 p-3 text-sm text-amber-800'>
              当前仅汇总最近 {q.data.sampled}{' '}
              条匹配记录，请缩小筛选区间查看完整排行。
            </p>
          ) : null}
          <table className='w-full text-sm'>
            <thead>
              <tr className='border-b bg-muted/40'>
                {[
                  '名称',
                  ...(scope === 'key' && showOwner ? ['所属用户'] : []),
                  '请求',
                  'Token',
                  ...(canSeeMoney ? ['实扣 USD'] : []),
                  '待对账',
                ].map((v) => (
                  <th key={v} className='p-3 text-left'>
                    {v}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {q.data?.entries.map((e) => (
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
                  <td className='p-3'>{e.tokens.toLocaleString()}</td>
                  {canSeeMoney ? (
                    <td className='p-3'>
                      {e.cost == null ? '未结算' : e.cost.toFixed(6)}
                    </td>
                  ) : null}
                  <td className='p-3'>{e.pending}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!q.data?.entries.length ? <p className='p-4'>暂无记录</p> : null}
        </>
      )}
    </div>
  )
}
