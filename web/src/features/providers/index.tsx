import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/page-header'
import { providersQueryOptions, type ProviderRow } from './queries'

function pct(value?: number | null) {
  return value == null ? '—' : `${(Number(value) * 100).toFixed(1)}%`
}

function resetTime(value: string | null | undefined, t: TFunction) {
  if (!value) return '—'
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return value
  const remaining = Math.max(0, time - Date.now())
  if (remaining < 60_000) return t('providers:recoveringSoon')
  const hours = Math.floor(remaining / 3_600_000)
  const days = Math.floor(hours / 24)
  return days > 0
    ? t('providers:daysHoursLater', { days, hours: hours % 24 })
    : t('providers:hoursLater', { hours })
}

function statusLabel(row: ProviderRow, t: TFunction) {
  if (row.status === 'provisioning') return t('providers:status.provisioning')
  if (row.status === 'paused') return t('providers:status.paused')
  if (row.status === 'archived') return t('providers:status.archived')
  if (row.schedule_disabled_reason) return t('providers:status.schedulePaused')
  if (!row.has_token) return t('providers:status.waitingAuth')
  return t('providers:status.enabled')
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
  const active = rows.filter(
    (row) => row.status === 'active' && row.has_token
  ).length
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
                  t('columns.provider'),
                  t('columns.vendor'),
                  t('columns.status'),
                  t('columns.fiveHour'),
                  t('columns.sevenDay'),
                  t('columns.totalCost'),
                  t('columns.tokens'),
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
                  <td className='p-3'>
                    {row.vendor_name || t('platformResource')}
                  </td>
                  <td className='p-3'>
                    <div>{statusLabel(row, t)}</div>
                    <div className='text-xs text-muted-foreground'>
                      {row.max_concurrency
                        ? t('concurrency', { value: row.max_concurrency })
                        : ''}
                      {row.max_rpm ? t('rpm', { value: row.max_rpm }) : ''}
                    </div>
                  </td>
                  <td className='p-3'>
                    <div>{pct(row.utilization_5h)}</div>
                    <div className='text-xs text-muted-foreground'>
                      {resetTime(row.reset_5h, t)}
                    </div>
                  </td>
                  <td className='p-3'>
                    <div>{pct(row.utilization_7d)}</div>
                    <div className='text-xs text-muted-foreground'>
                      {resetTime(row.reset_7d, t)}
                    </div>
                  </td>
                  <td className='p-3 tabular-nums'>
                    ${Number(row.total_cost || 0).toFixed(2)}
                  </td>
                  <td className='p-3 tabular-nums'>
                    {Number(row.total_tokens || 0).toLocaleString()}
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
