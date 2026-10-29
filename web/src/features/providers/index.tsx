import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/page-header'
import { isActive, resetTime, statusLabel } from './presentation'
import { providersQueryOptions } from './queries'

function Quota({
  value,
  reset,
}: {
  value?: number | null
  reset?: string | number | null
}) {
  const { t } = useTranslation('providers')
  return (
    <div className='min-w-28 space-y-2'>
      <div className='tabular-nums'>
        {value == null ? '—' : `${(value * 100).toFixed(1)}%`}
      </div>
      {value != null && (
        <div className='h-1.5 overflow-hidden rounded-full bg-muted'>
          <div
            className={
              value >= 0.8 ? 'h-full bg-amber-500' : 'h-full bg-primary'
            }
            style={{ width: `${Math.max(0, Math.min(100, value * 100))}%` }}
          />
        </div>
      )}
      <div className='text-xs text-muted-foreground'>{resetTime(reset, t)}</div>
    </div>
  )
}

export function ProvidersPage() {
  const { t } = useTranslation('providers')
  const query = useQuery(providersQueryOptions(5000))
  const [search, setSearch] = useState('')
  const rows = useMemo(() => {
    const value = search.trim().toLowerCase()
    return (query.data?.items || []).filter((row) =>
      value
        ? [row.name, row.email, row.vendor_name, row.provider_type]
            .filter(Boolean)
            .some((item) => String(item).toLowerCase().includes(value))
        : true
    )
  }, [query.data?.items, search])
  const active = rows.filter(isActive).length
  const limited = rows.filter(
    (row) => Number(row.utilization_7d || 0) >= 0.8
  ).length
  const totalCost = rows.reduce(
    (sum, row) => sum + Number(row.total_cost || 0),
    0
  )

  return (
    <PageHeader title={t('title')} description={t('description')}>
      <div className='grid gap-4 sm:grid-cols-3'>
        <Card>
          <CardContent className='p-4'>
            <div className='text-sm text-muted-foreground'>
              {t('activeTotal')}
            </div>
            <div className='mt-1 text-2xl font-semibold'>
              {active} / {rows.length}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className='p-4'>
            <div className='text-sm text-muted-foreground'>
              {t('nearLimit')}
            </div>
            <div className='mt-1 text-2xl font-semibold'>{limited}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className='p-4'>
            <div className='text-sm text-muted-foreground'>
              {t('totalCost')}
            </div>
            <div className='mt-1 text-2xl font-semibold'>
              ${totalCost.toFixed(2)}
            </div>
          </CardContent>
        </Card>
      </div>
      <div className='mt-6 space-y-4'>
        <Input
          className='max-w-sm'
          placeholder={t('searchPlaceholder')}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        {query.error ? (
          <p className='text-sm text-destructive'>{query.error.message}</p>
        ) : null}
        <div className='overflow-auto rounded-md border'>
          <table className='w-full min-w-[1000px] text-sm'>
            <thead>
              <tr className='border-b bg-muted/40'>
                {[
                  t('columns.account'),
                  t('columns.vendor'),
                  t('columns.status'),
                  t('columns.fiveHour'),
                  t('columns.sevenDay'),
                  t('columns.totalCost'),
                  t('columns.tokens'),
                  t('columns.schedule'),
                  t('columns.actions'),
                ].map((label) => (
                  <th key={label} className='p-3 text-left'>
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className='border-b align-top'>
                  <td className='p-3'>
                    <div className='font-medium'>{row.name}</div>
                    <div className='text-xs text-muted-foreground'>
                      {row.provider_type} ·{' '}
                      {row.email || row.vm_id || t('unboundVm')}
                    </div>
                  </td>
                  <td className='p-3'>{row.vendor_name || '—'}</td>
                  <td className='p-3'>
                    <div>{statusLabel(row, t)}</div>
                  </td>
                  <td className='p-3'>
                    <Quota value={row.utilization_5h} reset={row.reset_5h} />
                  </td>
                  <td className='p-3'>
                    <Quota value={row.utilization_7d} reset={row.reset_7d} />
                  </td>
                  <td className='p-3 tabular-nums'>
                    ${Number(row.total_cost || 0).toFixed(2)}
                    <div className='mt-2 text-xs text-muted-foreground'>
                      {t('requests', {
                        value: Number(row.requests || 0).toLocaleString(),
                      })}
                    </div>
                  </td>
                  <td className='p-3 tabular-nums'>
                    {Number(row.total_tokens || 0).toLocaleString()}
                  </td>
                  <td className='p-3 whitespace-nowrap'>
                    <div>
                      {t('concurrency', {
                        value: `${row.inflight || 0} / ${row.max_concurrency || '—'}`,
                      })}
                    </div>
                    <div className='mt-2 text-xs text-muted-foreground'>
                      {t('rpm', { value: row.max_rpm || t('unlimited') })}
                    </div>
                  </td>
                  <td className='p-3'>
                    {row.vm_id ? (
                      <Link
                        className='underline underline-offset-4'
                        to='/vm/$id'
                        params={{ id: row.vm_id }}
                      >
                        {t('viewVm')}
                      </Link>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && !query.isLoading ? (
            <p className='p-6 text-sm text-muted-foreground'>{t('empty')}</p>
          ) : null}
        </div>
      </div>
    </PageHeader>
  )
}
