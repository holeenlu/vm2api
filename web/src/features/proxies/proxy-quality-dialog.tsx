import { t as translate, i18n } from '@/i18n'
import type { VmProxySnap } from '@/types/panel-vm'
import type { ProxyQualityReport } from '@/types/proxy-quality'
import { useTranslation } from 'react-i18next'
import { SYSTEM_TIMEZONE } from '@/lib/system-time'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { proxyQualityMessage } from './proxy-quality-display'
import { regionLabel } from './proxy-region'
import { proxyLabel } from './proxy-sort'

const TARGETS: Record<string, string> = {
  get base_connectivity() {
    return translate('proxies:basicConnectivity')
  },
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
  grok: 'Grok',
}
const STATUS = {
  get pass() {
    return translate('proxies:pass')
  },
  get warn() {
    return translate('proxies:warning')
  },
  get fail() {
    return translate('proxies:failure')
  },
  get challenge() {
    return translate('proxies:challenge')
  },
}
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
  const { t: translate } = useTranslation('proxies')

  const report = target?.report
  const countryCode = (
    report as (ProxyQualityReport & { country_code?: string }) | undefined
  )?.country_code
  return (
    <Dialog open={!!target} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className='max-h-[90svh] overflow-y-auto sm:max-w-3xl'>
        <DialogHeader>
          <DialogTitle>{translate('proxies:qualityReport')}</DialogTitle>
          <DialogDescription>
            {translate('proxies:qualityReportHint')}
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
                  {translate('proxies:qualityCounts', {
                    passed: report.passed_count,
                    warnings: report.warn_count,
                    failed: report.failed_count,
                    challenges: report.challenge_count,
                  })}
                </p>
                <p>
                  {translate('proxies:exitIpAndRegion', {
                    ip: report.exit_ip || '—',
                    region: countryCode
                      ? regionLabel(countryCode)
                      : report.country || translate('proxies:unknownRegion'),
                  })}
                </p>
                <p>
                  {translate('proxies:baseLatencyValue', {
                    latency: report.base_latency_ms,
                  })}
                </p>
                <p className='text-xs text-muted-foreground'>
                  {translate('proxies:checkedAtValue', {
                    time: new Date(report.checked_at * 1000).toLocaleString(
                      i18n.language,
                      { timeZone: SYSTEM_TIMEZONE }
                    ),
                  })}
                </p>
              </div>
              <div className='text-right'>
                <p
                  className={`text-3xl font-semibold tabular-nums ${report.score >= 90 ? 'text-emerald-600 dark:text-emerald-400' : report.score >= 60 ? 'text-amber-600 dark:text-amber-400' : 'text-destructive'}`}
                >
                  {report.score}
                </p>
                <p className='text-sm text-muted-foreground'>
                  {translate('proxies:gradeValue', { grade: report.grade })}
                </p>
              </div>
            </div>
            <div className='overflow-auto rounded-lg border'>
              <table className='w-full text-sm'>
                <thead>
                  <tr className='border-b bg-muted/40'>
                    {[
                      translate('proxies:checkItem'),
                      translate('proxies:status'),
                      'HTTP',
                      translate('proxies:latency'),
                      translate('proxies:details'),
                    ].map((s) => (
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
                        {translate('proxies:latencyValue', {
                          milliseconds: item.latency_ms,
                        })}
                      </td>
                      <td className='p-3'>
                        {proxyQualityMessage(item)}
                        {item.message ? (
                          <details className='mt-1 text-xs text-muted-foreground'>
                            <summary className='cursor-pointer'>
                              {translate('proxies:rawDiagnostic')}
                            </summary>
                            <pre className='mt-1 break-words whitespace-pre-wrap'>
                              {item.message}
                            </pre>
                          </details>
                        ) : null}
                        {item.cf_ray && (
                          <p className='mt-1 font-mono text-xs'>
                            {translate('proxies:cfRay')}
                            {item.cf_ray}
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
                {translate('proxies:basicConnectivityFailed')}
              </p>
            )}
          </>
        )}
        <DialogFooter>
          <Button type='button' variant='outline' onClick={onClose}>
            {translate('proxies:close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
