import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/page-header'
import { providersQueryOptions, type ProviderRow } from './queries'

function pct(value?: number | null) {
  return value == null ? '—' : `${(Number(value) * 100).toFixed(1)}%`
}

function resetTime(value?: string | null) {
  if (!value) return '—'
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return value
  const remaining = Math.max(0, time - Date.now())
  if (remaining < 60_000) return '即将恢复'
  const hours = Math.floor(remaining / 3_600_000)
  const days = Math.floor(hours / 24)
  return days > 0 ? `${days}天${hours % 24}小时后` : `${hours}小时后`
}

function statusLabel(row: ProviderRow) {
  if (row.status === 'provisioning') return '预配中'
  if (row.status === 'paused') return '已暂停'
  if (row.status === 'archived') return '已归档'
  if (row.schedule_disabled_reason) return '已暂停调度'
  if (!row.has_token) return '等待授权'
  return '已启用'
}

export function ProvidersPage() {
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
    <PageHeader
      title='服务提供商'
      description='查看上游账号、授权状态、额度窗口、用量与调度配置。'
    >
      <div className='grid gap-4 sm:grid-cols-3'>
        <Card>
          <CardContent className='p-4'>
            <div className='text-sm text-muted-foreground'>活跃 / 总数</div>
            <div className='mt-1 text-2xl font-semibold'>
              {active} / {rows.length}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className='p-4'>
            <div className='text-sm text-muted-foreground'>接近 7D 限额</div>
            <div className='mt-1 text-2xl font-semibold'>{limited}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className='p-4'>
            <div className='text-sm text-muted-foreground'>累计消耗</div>
            <div className='mt-1 text-2xl font-semibold'>
              ${totalCost.toFixed(2)}
            </div>
          </CardContent>
        </Card>
      </div>
      <div className='mt-6 space-y-4'>
        <Input
          className='max-w-sm'
          placeholder='搜索账号、供应商或服务类型'
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
                  '服务提供商',
                  '供应商',
                  '状态 / 调度',
                  '5H',
                  '7D',
                  '累计消耗',
                  'Token',
                  '操作',
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
                      {row.email || row.vm_id || '未绑定 VM'}
                    </div>
                  </td>
                  <td className='p-3'>{row.vendor_name || '平台资源'}</td>
                  <td className='p-3'>
                    <div>{statusLabel(row)}</div>
                    <div className='text-xs text-muted-foreground'>
                      {row.max_concurrency ? `并发 ${row.max_concurrency}` : ''}
                      {row.max_rpm ? ` · RPM ${row.max_rpm}` : ''}
                    </div>
                  </td>
                  <td className='p-3'>
                    <div>{pct(row.utilization_5h)}</div>
                    <div className='text-xs text-muted-foreground'>
                      {resetTime(row.reset_5h)}
                    </div>
                  </td>
                  <td className='p-3'>
                    <div>{pct(row.utilization_7d)}</div>
                    <div className='text-xs text-muted-foreground'>
                      {resetTime(row.reset_7d)}
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
                        查看 VM
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
            <p className='p-6 text-sm text-muted-foreground'>
              暂无服务提供商数据。
            </p>
          ) : null}
        </div>
      </div>
    </PageHeader>
  )
}
