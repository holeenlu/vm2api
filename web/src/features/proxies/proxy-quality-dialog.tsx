import type { VmProxySnap } from '@/types/panel-vm'
import type { ProxyQualityReport } from '@/types/proxy-quality'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { proxyLabel } from './proxy-sort'

const TARGETS: Record<string, string> = {
  base_connectivity: '基础连通性',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
  grok: 'Grok',
}
const STATUS = { pass: '通过', warn: '告警', fail: '失败', challenge: '挑战' }
const STATUS_CLASS = {
  pass: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  warn: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  fail: 'bg-red-500/10 text-red-700 dark:text-red-400',
  challenge: 'bg-purple-500/10 text-purple-700 dark:text-purple-400',
}

export function ProxyQualityDialog({
  target,
  onClose,
}: {
  target: { proxy: VmProxySnap; report: ProxyQualityReport } | null
  onClose: () => void
}) {
  const report = target?.report
  return (
    <Dialog open={!!target} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className='max-h-[90svh] overflow-y-auto sm:max-w-3xl'>
        <DialogHeader>
          <DialogTitle>代理质量检测报告</DialogTitle>
          <DialogDescription>
            通过选定出口检测目标可达性。401/405
            等预期状态代表网络可达，不代表账号授权或模型可调用。
          </DialogDescription>
        </DialogHeader>
        {report && (
          <>
            <div className='flex items-start justify-between gap-4 rounded-lg border bg-muted/30 p-4'>
              <div className='space-y-2 text-sm'>
                <p className='font-medium'>
                  {target ? proxyLabel(target.proxy) : ''}
                </p>
                <p>
                  通过 {report.passed_count} 项，告警 {report.warn_count}{' '}
                  项，失败 {report.failed_count} 项，挑战{' '}
                  {report.challenge_count} 项
                </p>
                <p>
                  出口 IP：{report.exit_ip || '—'} ·{' '}
                  {report.country || '地区未知'}
                </p>
                <p>基础延迟：{report.base_latency_ms} ms</p>
                <p className='text-xs text-muted-foreground'>
                  检测时间：
                  {new Date(report.checked_at * 1000).toLocaleString()}
                </p>
              </div>
              <div className='text-right'>
                <p
                  className={`text-3xl font-semibold tabular-nums ${report.score >= 90 ? 'text-emerald-600 dark:text-emerald-400' : report.score >= 60 ? 'text-amber-600 dark:text-amber-400' : 'text-destructive'}`}
                >
                  {report.score}
                </p>
                <p className='text-sm text-muted-foreground'>
                  等级 {report.grade}
                </p>
              </div>
            </div>
            <div className='overflow-auto rounded-lg border'>
              <table className='w-full text-sm'>
                <thead>
                  <tr className='border-b bg-muted/40'>
                    {['检测项', '状态', 'HTTP', '延迟', '说明'].map((s) => (
                      <th key={s} className='p-3 text-left whitespace-nowrap'>
                        {s}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {report.items.map((item) => (
                    <tr key={item.target} className='border-b last:border-0'>
                      <td className='p-3'>
                        {TARGETS[item.target] || item.target}
                      </td>
                      <td className='p-3 whitespace-nowrap'>
                        <span
                          className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CLASS[item.status]}`}
                        >
                          {STATUS[item.status]}
                        </span>
                      </td>
                      <td className='p-3'>{item.http_status || '—'}</td>
                      <td className='p-3 whitespace-nowrap'>
                        {item.latency_ms} ms
                      </td>
                      <td className='p-3'>
                        {item.message}
                        {item.cf_ray && (
                          <p className='mt-1 font-mono text-xs'>
                            CF-Ray: {item.cf_ray}
                          </p>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {report.items.length < 5 && (
              <p className='text-xs text-muted-foreground'>
                基础连通性失败，未继续检测目标服务；评分记为 0。
              </p>
            )}
          </>
        )}
        <DialogFooter>
          <Button type='button' variant='outline' onClick={onClose}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
