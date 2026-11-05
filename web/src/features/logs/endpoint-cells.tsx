import type { UsageLogRow } from '@/types/panel-usage-logs'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { requestTypeOf } from './log-display'

const TYPE_BADGE: Record<ReturnType<typeof requestTypeOf>, string> = {
  ws: 'bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/30 dark:text-purple-300 dark:border-purple-800',
  stream:
    'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/30 dark:text-blue-300 dark:border-blue-800',
  sync: 'text-muted-foreground',
}

/** 「端点」列：入站路径与实际上游路径；上游经 WebSocket 时补 WS 标记。 */
export function EndpointCell({ row }: { row: UsageLogRow }) {
  const { t: translate } = useTranslation('logs')
  const upstream = row.upstreamEndpoint
  return (
    <div className='flex min-w-0 flex-col gap-0.5 font-mono text-xs leading-tight'>
      <span className='truncate' title={row.endpoint ?? undefined}>
        <span className='text-muted-foreground'>
          {translate('logs:inboundEndpoint')}:{' '}
        </span>
        {row.endpoint || '-'}
      </span>
      <span className='flex min-w-0 items-center gap-1'>
        <span className='truncate' title={upstream ?? undefined}>
          <span className='text-muted-foreground'>
            {translate('logs:upstreamEndpoint')}:{' '}
          </span>
          {upstream || '-'}
        </span>
        {row.upstreamTransport === 'websocket' ? (
          <Badge
            variant='outline'
            className={cn('px-1 text-[10px] leading-tight', TYPE_BADGE.ws)}
            title={translate('logs:upstreamWebSocketHint')}
          >
            {translate('logs:requestTypeWs')}
          </Badge>
        ) : null}
      </span>
    </div>
  )
}

/** 「类型」列：WS / 流式 / 非流式。 */
export function RequestTypeCell({ row }: { row: UsageLogRow }) {
  const { t: translate } = useTranslation('logs')
  const type = requestTypeOf(row)
  const label =
    type === 'ws'
      ? translate('logs:requestTypeWs')
      : type === 'stream'
        ? translate('logs:requestTypeStream')
        : translate('logs:requestTypeSync')
  return (
    <Badge variant='outline' className={cn('text-xs', TYPE_BADGE[type])}>
      {label}
    </Badge>
  )
}
