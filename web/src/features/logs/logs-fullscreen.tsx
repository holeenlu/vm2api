import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { i18n } from '@/i18n'
import type { PanelRole } from '@/types/panel-auth'
import type { UsageLogFilters } from '@/types/panel-usage-logs'
import { Minimize2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { SYSTEM_TIMEZONE } from '@/lib/system-time'
import { formatCurrency } from '@/lib/usage-format'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { canShowLogColumn } from './column-visibility'
import { usageLogsOverviewQueryOptions } from './queries'
import { VirtualizedLogsTable, type OpenDetail } from './virtualized-logs-table'

/** <1s 用毫秒，否则 1 位小数秒（hub `formatResponseTime`）。 */
function formatResponseTime(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return '-'
  if (ms < 1000)
    return new Intl.NumberFormat(i18n.language, {
      style: 'unit',
      unit: 'millisecond',
      unitDisplay: 'narrow',
      maximumFractionDigits: 0,
    }).format(ms)
  return new Intl.NumberFormat(i18n.language, {
    style: 'unit',
    unit: 'second',
    unitDisplay: 'narrow',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(ms / 1000)
}

function Metric({
  label,
  value,
  last,
}: {
  label: string
  value: string | number
  last?: boolean
}) {
  return (
    <div className={`flex flex-col justify-center ${last ? 'pl-5' : 'px-5'}`}>
      <div className='text-[10px] font-semibold tracking-wider text-muted-foreground uppercase'>
        {label}
      </div>
      <div className='font-mono text-xl leading-none font-bold tabular-nums'>
        {value}
      </div>
    </div>
  )
}

export function LogsFullscreen({
  role,
  title,
  filters,
  onOpenDetail,
  onExit,
}: {
  role: PanelRole | undefined
  title: string
  filters: UsageLogFilters
  onOpenDetail: OpenDetail
  onExit: () => void
}) {
  const { t: translate } = useTranslation('logs')
  const [hideProvider, setHideProvider] = useState(false)
  const tz = SYSTEM_TIMEZONE
  const { data } = useQuery(
    usageLogsOverviewQueryOptions(tz, 3000, filters.scope)
  )

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.defaultPrevented && event.key === 'Escape') onExit()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onExit])

  return (
    <div
      className='fixed inset-0 z-[70] flex flex-col bg-background'
      role='dialog'
      aria-modal='true'
    >
      <div className='flex h-14 items-center justify-between gap-4 border-b bg-background/95 px-6 backdrop-blur supports-[backdrop-filter]:bg-background/70'>
        <div className='min-w-0'>
          <div className='truncate text-base font-semibold tracking-tight'>
            {title}
          </div>
        </div>
        <div className='flex items-center gap-4'>
          <Button
            variant='outline'
            size='sm'
            onClick={onExit}
            className='gap-2'
          >
            <Minimize2 className='h-4 w-4' />
            {translate('logs:exitFullscreen')}
          </Button>
          <div className='hidden h-full items-stretch divide-x divide-border/50 md:flex'>
            <Metric
              label={translate('logs:todayRequests')}
              value={data?.todayRequests ?? 0}
            />
            <Metric
              label={translate('logs:todaySpending')}
              value={formatCurrency(data?.todayActualCost ?? 0, 2)}
            />
            <Metric
              label={translate('logs:averageResponseTime')}
              value={formatResponseTime(data?.todayAvgDurationMs ?? null)}
              last
            />
          </div>
        </div>
      </div>

      {canShowLogColumn('provider', role) && (
        <div className='group fixed top-20 right-0 z-[80] flex translate-x-[calc(100%-6px)] items-start transition-transform duration-300 focus-within:translate-x-0 hover:translate-x-0'>
          <div className='mt-4 h-16 w-1.5 rounded-l-sm bg-primary/20 group-hover:bg-primary/50' />
          <div className='flex w-72 flex-col gap-3 rounded-l-lg border border-r-0 bg-popover p-4 shadow-xl'>
            <div className='flex items-center justify-between gap-3'>
              <div className='text-sm font-medium'>
                {translate('logs:hideProviderColumn')}
              </div>
              <Switch
                checked={hideProvider}
                onCheckedChange={setHideProvider}
                aria-label={translate('logs:hideProviderColumn')}
              />
            </div>
          </div>
        </div>
      )}

      <div className='flex-1 p-4'>
        <VirtualizedLogsTable
          role={role}
          filters={filters}
          autoRefreshEnabled
          autoRefreshIntervalMs={3000}
          hideStatusBar
          hideScrollToTop
          hiddenColumns={hideProvider ? ['provider'] : undefined}
          bodyClassName='h-[calc(100dvh_-_56px_-_32px_-_40px)]'
          onOpenDetail={onOpenDetail}
        />
      </div>
    </div>
  )
}
