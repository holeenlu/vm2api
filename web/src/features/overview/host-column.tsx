import { i18n } from '@/i18n'
import type { HostStats } from '@/types/panel-overview'
import { useTranslation } from 'react-i18next'
import { fmtBytes } from '@/lib/format'

function barColor(p: number): string {
  if (p >= 100) return 'var(--status-bad)'
  if (p >= 95) return 'var(--status-warn)'
  if (p >= 85) return 'var(--status-caution)'
  return 'var(--status-ok)'
}

function HostRow({
  label,
  value,
  valueText,
}: {
  label: string
  value: number
  valueText: string
}) {
  useTranslation('overview')

  return (
    <div className='flex items-center gap-2.5 text-[11.5px] text-muted-foreground'>
      <span className='w-7 shrink-0'>{label}</span>
      <div className='h-1.5 flex-1 overflow-hidden rounded-full bg-muted'>
        <div
          className='h-full rounded-full transition-[width] duration-200'
          style={{
            width: `${Math.min(100, value)}%`,
            background: barColor(value),
          }}
        />
      </div>
      <b className='w-9 shrink-0 text-right font-medium text-foreground tabular-nums'>
        {valueText}
      </b>
    </div>
  )
}

function relMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const unit = (value: number, name: string) =>
    new Intl.NumberFormat(i18n.language, {
      style: 'unit',
      unit: name,
      unitDisplay: 'short',
      maximumFractionDigits: 0,
    }).format(value)
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return unit(sec, 'second')
  const min = Math.floor(sec / 60)
  if (min < 60) return unit(min, 'minute')
  const hr = Math.floor(min / 60)
  if (hr < 24) return unit(hr, 'hour')
  return unit(Math.floor(hr / 24), 'day')
}

/** 宿主资源列。对齐 index.html 的 `hostCol(host)`。 */
export function HostColumn({ host }: { host: HostStats | undefined }) {
  const { t: translate } = useTranslation('overview')

  const h = host || {}
  const cpu = Number(h.cpu_pct || 0)
  const mem = Number(h.mem_pct || 0)
  const heap = h.heap_total ? ((h.heap_used || 0) / h.heap_total) * 100 : 0
  const title = translate('overview:hostSummary', {
    p0: h.cpu_count || 0,
    p1: h.load1 != null ? Number(h.load1).toFixed(2) : '—',
    p2: fmtBytes(h.mem_used),
    p3: fmtBytes(h.mem_total),
    p4: relMs((h.proc_uptime || 0) * 1000),
  })
  return (
    <div
      className='flex w-full shrink-0 flex-col gap-2 border-t pt-3 sm:w-[220px] sm:border-t-0 sm:border-l sm:pt-0 sm:pl-5'
      title={title}
    >
      <HostRow
        label={translate('overview:cpu')}
        value={cpu}
        valueText={`${cpu.toFixed(0)}%`}
      />
      <HostRow
        label={translate('overview:memory')}
        value={mem}
        valueText={`${mem.toFixed(0)}%`}
      />
      <HostRow
        label={translate('overview:process')}
        value={heap}
        valueText={fmtBytes(h.rss)}
      />
    </div>
  )
}
