import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { PageHeader } from '@/components/page-header'
import { StatCard } from '@/components/stat-card'

type Snapshot = {
  uptime: number
  traffic: {
    sla: number | null
    client_rejections: number
    rpm: number
    requests: number
    server_errors: number
    ttft_ms: number | null
    duration_ms: number | null
  }
  queues: { waiting: number }
  tasks: { scheduled: number; running: string[] }
  alerts: { code: string; message: string; to: string }[]
  concurrency: { users: Record<string, number>; keys: Record<string, number> }
  memory: { rss: number }
  resources: { total: number; running: number; schedulable: number }
  billing_pending: number
  errors: {
    request_id: string
    created_at: string
    status: number
    error_code: string
    error_message: string
    vm_id: string
    model: string
  }[]
}
export function OpsPage() {
  const q = useQuery({
    queryKey: ['panel', 'ops'],
    queryFn: () => api<Snapshot>('/api/panel/ops'),
    refetchInterval: 10000,
  })
  const d = q.data
  return (
    <PageHeader
      title='运维监控'
      description='近一小时请求与资源运行状态。用户消费和资金变化请到使用记录、账务查看。'
    >
      {q.error ? (
        <p role='alert' className='text-destructive'>
          {q.error.message}
        </p>
      ) : null}
      {d?.alerts.length ? (
        <div className='mb-4 space-y-2 rounded border border-amber-500/30 p-3'>
          {d.alerts.map((a) => (
            <p key={a.code} className='text-sm'>
              <a href={'#' + a.to} className='underline'>
                {a.message}
              </a>
            </p>
          ))}
        </div>
      ) : null}
      <div className='mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4'>
        <StatCard
          label='近 1h 请求'
          value={String(d?.traffic.requests ?? '—')}
        />
        <StatCard
          label='服务错误'
          value={String(d?.traffic.server_errors ?? '—')}
        />
        <StatCard
          label='TTFT ms'
          value={String(
            d?.traffic.ttft_ms == null
              ? '无样本'
              : Math.round(d.traffic.ttft_ms)
          )}
        />
        <StatCard
          label='站点 SLA'
          value={
            d?.traffic.sla == null
              ? '无样本'
              : (d.traffic.sla * 100).toFixed(2) + '%'
          }
        />
        <StatCard
          label='用户拒绝 / 取消'
          value={String(d?.traffic.client_rejections ?? '—')}
        />
        <StatCard label='等待请求' value={String(d?.queues.waiting ?? '—')} />
        <StatCard
          label='定时任务 / 运行中'
          value={d ? d.tasks.scheduled + ' / ' + d.tasks.running.length : '—'}
        />
        <StatCard
          label='用户在途请求'
          value={
            d
              ? String(
                  Object.values(d.concurrency.users).reduce((a, b) => a + b, 0)
                )
              : '—'
          }
        />
        <StatCard label='待对账' value={String(d?.billing_pending ?? '—')} />
        <StatCard
          label='运行 VM / 总数'
          value={String(
            d ? d.resources.running + ' / ' + d.resources.total : '—'
          )}
        />
        <StatCard
          label='已开启调度'
          value={String(d?.resources.schedulable ?? '—')}
        />
        <StatCard
          label='控制面 RSS MB'
          value={String(d ? Math.round(d.memory.rss / 1048576) : '—')}
        />
        <StatCard
          label='运行时间（分钟）'
          value={String(d ? Math.round(d.uptime / 60) : '—')}
        />
      </div>
      <div className='overflow-auto rounded border'>
        <table className='w-full text-sm'>
          <thead>
            <tr className='border-b bg-muted/40'>
              {['时间', '请求', 'VM', '模型', '状态', '错误'].map((v) => (
                <th key={v} className='p-3 text-left'>
                  {v}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {d?.errors.map((e) => (
              <tr key={e.request_id} className='border-b'>
                <td className='p-3'>
                  {new Date(e.created_at).toLocaleTimeString()}
                </td>
                <td className='p-3 font-mono text-xs'>{e.request_id}</td>
                <td className='p-3'>{e.vm_id || '—'}</td>
                <td className='p-3'>{e.model}</td>
                <td className='p-3'>{e.status}</td>
                <td className='max-w-sm p-3'>
                  {e.error_code}
                  <p className='text-xs text-muted-foreground'>
                    {e.error_message}
                  </p>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </PageHeader>
  )
}
