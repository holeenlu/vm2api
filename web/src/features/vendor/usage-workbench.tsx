import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  UsageRangePicker,
  usageQueryString,
  usageCost,
  type UsageRange,
} from './account-usage-dialog'
import {
  number,
  time,
  type Resource,
  type VendorUsageReport,
} from './portal-model'

export function VendorUsageWorkbench({
  scope,
  scopes,
  accounts,
  onScope,
}: {
  scope: string
  scopes: { id: string; name: string }[]
  accounts: Resource[]
  onScope: (value: string) => void
}) {
  const { t } = useTranslation('vendor')
  const [account, setAccount] = useState('')
  const [range, setRange] = useState<UsageRange>({
    range: '7days',
    start_date: '',
    end_date: '',
  })
  const query = useQuery({
    queryKey: ['vendor', 'usage', scope, account, range],
    queryFn: () =>
      api<VendorUsageReport>(
        '/api/vendor/usage?' +
          usageQueryString(range) +
          (scope ? '&vendor_id=' + encodeURIComponent(scope) : '') +
          (account ? '&account_id=' + encodeURIComponent(account) : '')
      ),
    refetchOnWindowFocus: false,
  })
  const data = query.data,
    s = data?.summary
  return (
    <section className='space-y-5'>
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <div>
          <h1 className='text-2xl font-bold tracking-tight'>
            {t('view.usage')}
          </h1>
          <p className='mt-1 text-sm text-muted-foreground'>
            {t('details.usageScopeHelp')}
          </p>
        </div>
        <Button
          variant='outline'
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
        >
          <RefreshCw />
          {t('refresh')}
        </Button>
      </div>
      <div className='flex flex-wrap items-end gap-3 rounded-xl border bg-card p-4 shadow-sm'>
        <label className='grid w-full min-w-0 gap-1.5 text-xs text-muted-foreground sm:w-auto'>
          {t('vendor')}
          <select
            className='h-9 max-w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-xs transition-colors outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 sm:max-w-52'
            value={scope}
            onChange={(e) => {
              setAccount('')
              onScope(e.target.value)
            }}
          >
            {scopes.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
        </label>
        <label className='grid w-full min-w-0 gap-1.5 text-xs text-muted-foreground sm:w-auto'>
          {t('accountName')}
          <select
            className='h-9 max-w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-xs transition-colors outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 sm:max-w-64'
            value={account}
            onChange={(e) => setAccount(e.target.value)}
          >
            <option value=''>{t('details.allAccounts')}</option>
            {accounts.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <UsageRangePicker value={range} onChange={setRange} />
      </div>
      {query.error ? (
        <p role='alert' className='text-sm text-destructive'>
          {query.error.message}
        </p>
      ) : query.isPending ? (
        <p className='p-8 text-center'>{t('loading')}</p>
      ) : (
        data &&
        s && (
          <>
            <p className='text-xs text-muted-foreground'>
              {t('details.recordBasis')} · {data.period.timezone} ·{' '}
              {t('details.snapshotAt', { time: time(data.collected_at) })}
            </p>
            <div className='grid divide-y overflow-hidden rounded-xl border bg-card shadow-sm md:grid-cols-[1.8fr_1fr_1fr_1fr] md:divide-x md:divide-y-0'>
              <div className='space-y-3 p-4'>
                <h2 className='text-sm text-muted-foreground'>
                  {t('details.cost')}
                </h2>
                <p className='text-xl font-semibold text-primary tabular-nums'>
                  {usageCost(s.cost_usd)}
                </p>
                <dl className='grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-xs text-muted-foreground'>
                  {[
                    [t('details.opusCost'), s.opus_cost_usd],
                    [t('details.fableCost'), s.fable_cost_usd],
                    [
                      t('details.otherCost'),
                      s.cost_usd == null
                        ? null
                        : Math.max(
                            0,
                            s.cost_usd - s.opus_cost_usd - s.fable_cost_usd
                          ),
                    ],
                  ].map(([label, cost]) => (
                    <div className='contents' key={String(label)}>
                      <dt>{String(label)}</dt>
                      <dd>
                        {s.unpriced_requests
                          ? '—'
                          : usageCost(typeof cost === 'number' ? cost : null)}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
              <div className='space-y-3 p-4'>
                <h2 className='text-sm text-muted-foreground'>
                  {t('details.totalRequests')}
                </h2>
                <p className='text-2xl font-semibold tabular-nums'>
                  {number(s.requests)}
                </p>
                <p className='text-xs text-muted-foreground'>
                  {t('details.successFailure', {
                    success: number(s.success),
                    failure: number(s.errors),
                  })}
                </p>
              </div>
              <div className='space-y-3 p-4'>
                <h2 className='text-sm text-muted-foreground'>
                  {t('details.tokens')}
                </h2>
                <p className='text-2xl font-semibold tabular-nums'>
                  {number(s.tokens)}
                </p>
                <p className='text-xs text-muted-foreground'>
                  {t('details.inputOutput', {
                    input: number(s.input_tokens),
                    output: number(s.output_tokens),
                  })}
                </p>
              </div>
              <div className='space-y-3 p-4'>
                <h2 className='text-sm text-muted-foreground'>
                  {t('details.cache')}
                </h2>
                <p className='text-2xl font-semibold tabular-nums'>
                  {s.cache_complete === false
                    ? '—'
                    : number(s.cache_read_tokens + s.cache_creation_tokens)}
                </p>
                <p className='text-xs text-muted-foreground'>
                  {s.cache_complete === false
                    ? t('unknown')
                    : t('details.cacheTokens', {
                        write: number(s.cache_creation_tokens),
                        read: number(s.cache_read_tokens),
                      })}
                </p>
              </div>
            </div>
            {s.unpriced_requests > 0 && (
              <p className='text-sm text-[var(--status-caution)]'>
                {t('details.unpriced', { count: s.unpriced_requests })}
              </p>
            )}
            <section className='overflow-hidden rounded-xl border bg-card shadow-sm'>
              <h2 className='border-b px-4 py-4 text-sm font-semibold'>
                {t('details.dailyTrend')}
              </h2>
              <div className='overflow-x-auto'>
                <table className='w-full min-w-[650px] text-sm'>
                  <thead className='bg-muted/20 text-xs text-muted-foreground'>
                    <tr>
                      {[
                        t('details.date'),
                        t('requests'),
                        t('details.tokens'),
                        t('details.cache'),
                        t('details.cost'),
                      ].map((label) => (
                        <th
                          className='px-5 py-3 text-start font-medium'
                          key={label}
                        >
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.trend.map((row) => (
                      <tr
                        key={row.date}
                        className='border-t transition-colors hover:bg-muted/50 [&_td]:px-5 [&_td]:py-4'
                      >
                        <td>{row.date}</td>
                        <td>{number(row.requests)}</td>
                        <td className='text-xs text-muted-foreground'>
                          {t('details.inputOutput', {
                            input: number(row.input_tokens),
                            output: number(row.output_tokens),
                          })}
                        </td>
                        <td className='text-xs text-muted-foreground'>
                          {row.cache_complete === false
                            ? t('unknown')
                            : t('details.cacheTokens', {
                                write: number(row.cache_creation_tokens),
                                read: number(row.cache_read_tokens),
                              })}
                        </td>
                        <td className='font-medium tabular-nums'>
                          {usageCost(row.cost_usd)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!data.trend.length && (
                  <p className='p-8 text-center text-sm text-muted-foreground'>
                    {t('noRecords')}
                  </p>
                )}
              </div>
            </section>
          </>
        )
      )}
    </section>
  )
}
