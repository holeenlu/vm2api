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
  usageRangeForPreset,
  type UsageRange,
} from './account-usage-dialog'
import {
  number,
  time,
  type Resource,
  type VendorUsageReport,
} from './portal-model'
import {
  UsageSummaryCards,
  UsageMetricCells,
  usageMetricKeys,
} from './usage-metrics'

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
  const [range, setRange] = useState<UsageRange>(() =>
    usageRangeForPreset('7days')
  )
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
            <UsageSummaryCards usage={s} />
            <p className='text-xs text-muted-foreground'>
              {t('details.successFailure', {
                success: number(s.success),
                failure: number(s.errors),
              })}
              {' · '}
              {t('details.opusCost')}:{' '}
              {usageCost(s.unpriced_requests ? null : s.opus_cost_usd)}
              {' · '}
              {t('details.fableCost')}:{' '}
              {usageCost(s.unpriced_requests ? null : s.fable_cost_usd)}
              {' · '}
              {t('details.otherCost')}:{' '}
              {usageCost(
                s.cost_usd == null
                  ? null
                  : Math.max(0, s.cost_usd - s.opus_cost_usd - s.fable_cost_usd)
              )}
            </p>
            <p className='text-xs text-muted-foreground'>
              {t('details.cacheEvidence')}
            </p>
            {s.unpriced_requests > 0 && (
              <p className='text-sm text-[var(--status-caution)]'>
                {t('details.unpriced', { count: s.unpriced_requests })}
              </p>
            )}
            {[
              {
                title: t('details.dailyTrend'),
                label: t('details.date'),
                rows: data.trend.map((row) => ({
                  ...row,
                  key: row.date,
                  label: row.date,
                })),
              },
              {
                title: t('details.accountBreakdown'),
                label: t('accountName'),
                rows: (data.account_usage || []).map((row) => ({
                  ...row,
                  key: row.account_id || 'history',
                  label:
                    row.account_name ||
                    row.account_id ||
                    t('details.historicalAccount'),
                })),
              },
            ].map((section) => (
              <section
                key={section.title}
                className='overflow-hidden rounded-xl border bg-card shadow-sm'
              >
                <h2 className='border-b px-4 py-4 text-sm font-semibold'>
                  {section.title}
                </h2>
                <div className='overflow-x-auto'>
                  <table className='w-full min-w-[1000px] text-sm'>
                    <thead className='bg-muted/20 text-xs text-muted-foreground'>
                      <tr>
                        <th className='px-5 py-3 text-start font-medium'>
                          {section.label}
                        </th>
                        {usageMetricKeys.map((key) => (
                          <th key={key} className='p-4 text-end font-medium'>
                            {t(`details.${key}`)}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {section.rows.map((row) => (
                        <tr
                          key={row.key}
                          className='border-t transition-colors hover:bg-muted/50'
                        >
                          <td className='px-5 py-4 whitespace-nowrap'>
                            {row.label}
                          </td>
                          <UsageMetricCells usage={row} />
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!section.rows.length && (
                    <p className='p-8 text-center text-sm text-muted-foreground'>
                      {t('noRecords')}
                    </p>
                  )}
                </div>
              </section>
            ))}
          </>
        )
      )}
    </section>
  )
}
