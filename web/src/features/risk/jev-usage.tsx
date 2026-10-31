import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Fold } from './blocks'
import { usageMoney } from './jev-usage-format'

type Counts = {
  requests: number
  successful: number
  input_tokens: number
  output_tokens: number
  unknown_usage_requests: number
  estimated_cost_nano_usd: number
  unknown_cost_requests: number
}
type Cursor = { created_at: string; id: string }
type UsageRow = {
  id: string
  created_at: string
  request_id: string
  model: string
  key_fingerprint: string
  http_status: number | null
  outcome: string
  duration_ms: number
  input_tokens: number | null
  output_tokens: number | null
  estimated_cost_nano_usd: number | null
}
type UsagePage = {
  started_at: string | null
  day: string
  total: Counts
  today: Counts
  rows: UsageRow[]
  has_more: boolean
  next_cursor: Cursor | null
  storage_errors_since_start: number
}
const tokens = (value: number | null, unknown: string) =>
  value === null ? unknown : value.toLocaleString('zh-CN')
const time = (value: string) =>
  new Date(value).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
  })
const QUERY_KEY = ['panel', 'jev-usage'] as const

export function JevUsagePanel({
  defaultOpen = false,
}: { defaultOpen?: boolean } = {}) {
  const client = useQueryClient()
  const { t: translate } = useTranslation('risk')
  const query = useInfiniteQuery({
    queryKey: QUERY_KEY,
    initialPageParam: null as Cursor | null,
    queryFn: ({ pageParam, signal }) => {
      const qs = new URLSearchParams({ limit: '50' })
      if (pageParam) {
        qs.set('cursor_created_at', pageParam.created_at)
        qs.set('cursor_id', pageParam.id)
      }
      return api<UsagePage>(`/api/panel/jev-usage?${qs}`, { signal })
    },
    getNextPageParam: (page) =>
      page.has_more ? (page.next_cursor ?? undefined) : undefined,
    maxPages: 5,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  })
  const summary = query.data?.pages[0]
  const rows = [
    ...new Map(
      (query.data?.pages.flatMap((page) => page.rows) ?? []).map((row) => [
        row.id,
        row,
      ])
    ).values(),
  ]
  return (
    <Fold
      title={translate('risk:jevTitle')}
      defaultOpen={defaultOpen}
      meta={
        summary
          ? translate('risk:jevMeta', {
              today: tokens(
                summary.today.requests,
                translate('risk:jevUnknownValue')
              ),
              cost: usageMoney(
                summary.total.estimated_cost_nano_usd,
                translate('risk:jevUnknownValue')
              ),
            })
          : undefined
      }
    >
      <div className='space-y-4'>
        <div className='flex flex-wrap items-center justify-between gap-2'>
          <p className='text-xs text-muted-foreground'>
            {translate('risk:jevDescription')}
            {summary?.started_at
              ? translate('risk:jevStarted', { time: time(summary.started_at) })
              : translate('risk:jevEnabledFrom')}
          </p>
          <Button
            size='sm'
            variant='outline'
            disabled={query.isFetching}
            onClick={() => void client.resetQueries({ queryKey: QUERY_KEY })}
          >
            {translate('risk:jevRefresh')}
          </Button>
        </div>
        {query.isPending && (
          <p className='text-sm text-muted-foreground'>
            {translate('risk:jevLoading')}
          </p>
        )}
        {query.isError && (
          <p role='alert' className='text-sm text-destructive'>
            {translate('risk:jevReadError')}
          </p>
        )}
        {summary && (
          <>
            <div className='grid grid-cols-2 gap-3 text-sm lg:grid-cols-4'>
              <div>
                <div className='text-muted-foreground'>
                  {translate('risk:jevToday')}
                </div>
                <strong>
                  {tokens(
                    summary.today.requests,
                    translate('risk:jevUnknownValue')
                  )}
                </strong>
              </div>
              <div>
                <div className='text-muted-foreground'>
                  {translate('risk:jevTotalSuccess')}
                </div>
                <strong>
                  {tokens(
                    summary.total.requests,
                    translate('risk:jevUnknownValue')
                  )}{' '}
                  /{' '}
                  {tokens(
                    summary.total.successful,
                    translate('risk:jevUnknownValue')
                  )}
                </strong>
              </div>
              <div>
                <div className='text-muted-foreground'>
                  {translate('risk:jevTokens')}
                </div>
                <strong>
                  {tokens(
                    summary.total.input_tokens,
                    translate('risk:jevUnknownValue')
                  )}{' '}
                  /{' '}
                  {tokens(
                    summary.total.output_tokens,
                    translate('risk:jevUnknownValue')
                  )}
                </strong>
              </div>
              <div>
                <div className='text-muted-foreground'>
                  {translate('risk:jevCost')}
                </div>
                <strong>
                  {usageMoney(
                    summary.total.estimated_cost_nano_usd,
                    translate('risk:jevUnknownValue')
                  )}
                </strong>
              </div>
            </div>
            <p className='text-xs text-muted-foreground'>
              {translate('risk:jevUnknown', {
                usage: tokens(
                  summary.total.unknown_usage_requests,
                  translate('risk:jevUnknownValue')
                ),
                cost: tokens(
                  summary.total.unknown_cost_requests,
                  translate('risk:jevUnknownValue')
                ),
              })}
            </p>
            {summary.storage_errors_since_start > 0 && (
              <p role='alert' className='text-sm text-destructive'>
                {translate('risk:jevStorageError', {
                  count: summary.storage_errors_since_start,
                })}
              </p>
            )}
            <div className='max-h-96 overflow-auto'>
              <table className='w-full min-w-[680px] text-left text-xs'>
                <thead>
                  <tr className='border-b'>
                    <th className='p-2'>{translate('risk:jevTime')}</th>
                    <th className='p-2'>{translate('risk:jevFingerprint')}</th>
                    <th className='p-2'>{translate('risk:jevModel')}</th>
                    <th className='p-2'>{translate('risk:jevOutcome')}</th>
                    <th className='p-2'>{translate('risk:jevInputOutput')}</th>
                    <th className='p-2'>{translate('risk:jevEstimatedUsd')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr
                      key={row.id}
                      className='border-b'
                      title={
                        row.request_id
                          ? translate('risk:jevRequest', { id: row.request_id })
                          : undefined
                      }
                    >
                      <td className='p-2 whitespace-nowrap'>
                        {time(row.created_at)}
                      </td>
                      <td className='p-2 font-mono'>
                        {row.key_fingerprint || translate('risk:jevNoKey')}
                      </td>
                      <td className='p-2'>
                        {row.model || translate('risk:jevUnknownValue')}
                      </td>
                      <td className='p-2'>
                        {row.http_status ?? translate('risk:jevNetworkFailure')}{' '}
                        ·{' '}
                        {row.outcome === 'success'
                          ? translate('risk:jevComplete')
                          : translate('risk:jevIncomplete')}
                        <br />
                        {row.duration_ms} ms
                      </td>
                      <td className='p-2 whitespace-nowrap'>
                        {tokens(
                          row.input_tokens,
                          translate('risk:jevUnknownValue')
                        )}{' '}
                        /{' '}
                        {tokens(
                          row.output_tokens,
                          translate('risk:jevUnknownValue')
                        )}
                      </td>
                      <td className='p-2'>
                        {usageMoney(
                          row.estimated_cost_nano_usd,
                          translate('risk:jevUnknownValue')
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!rows.length && (
                <p className='py-5 text-sm text-muted-foreground'>
                  {translate('risk:jevEmpty')}
                </p>
              )}
            </div>
            <p className='text-xs text-muted-foreground'>
              {translate('risk:jevRetention')}
            </p>
            {query.hasNextPage && (
              <Button
                size='sm'
                variant='outline'
                disabled={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                {translate('risk:jevLoadEarlier')}
              </Button>
            )}
          </>
        )}
      </div>
    </Fold>
  )
}
