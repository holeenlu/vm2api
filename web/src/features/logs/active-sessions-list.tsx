import { useQuery } from '@tanstack/react-query'
import { i18n } from '@/i18n'
import type { ActiveSession } from '@/types/panel-usage-logs'
import {
  Activity,
  CheckCircle,
  Clock,
  Cpu,
  Key,
  Loader2,
  User,
  XCircle,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatCurrency, formatTokenAmount } from '@/lib/usage-format'
import { cn } from '@/lib/utils'
import { activeSessionsQueryOptions } from './queries'

/** 会话时长：首末次请求完成的间隔（hub 的 `Xm Ys` 口径）。 */
function formatSpan(ms: number): string {
  if (!(ms > 0)) return '-'
  const unit = (value: number, name: string, digits = 0) =>
    new Intl.NumberFormat(i18n.language, {
      style: 'unit',
      unit: name,
      unitDisplay: 'narrow',
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value)
  if (ms < 1000) return unit(ms, 'millisecond')
  if (ms < 60_000) return unit(ms / 1000, 'second', 1)
  return [
    unit(Math.floor(ms / 60_000), 'minute'),
    unit(Math.floor((ms % 60_000) / 1000), 'second'),
  ].join(' ')
}

function SessionListItem({
  session,
  onSelect,
}: {
  session: ActiveSession
  onSelect: (sessionId: string) => void
}) {
  const { t: translate } = useTranslation('logs')

  const failed = session.lastStatus != null && session.lastStatus >= 400
  const StatusIcon = failed ? XCircle : CheckCircle
  const provider = session.vmName || session.providerName
  return (
    <button
      type='button'
      onClick={() => onSelect(session.sessionId)}
      title={
        session.clientSessionId && session.clientSessionId !== session.sessionId
          ? translate('logs:sessionFilterWithClient', {
              p0: session.sessionId,
              p1: session.clientSessionId,
            })
          : translate('logs:sessionFilter', { p0: session.sessionId })
      }
      className='group block w-full rounded-md px-3 py-2 text-left transition-colors hover:bg-muted/50'
    >
      <div className='flex items-center gap-2 text-sm'>
        <StatusIcon
          className={cn(
            'h-3.5 w-3.5 flex-shrink-0',
            failed ? 'text-red-500' : 'text-green-500'
          )}
        />
        <div className='flex min-w-0 items-center gap-1.5'>
          <User className='h-3 w-3 flex-shrink-0 text-muted-foreground' />
          <span
            className='max-w-[100px] truncate font-medium'
            title={session.userName ?? undefined}
          >
            {session.userName || translate('logs:unknown')}
          </span>
        </div>
        <div className='flex min-w-0 items-center gap-1'>
          <Key className='h-3 w-3 flex-shrink-0 text-muted-foreground' />
          <span
            className='max-w-[80px] truncate font-mono text-xs text-muted-foreground'
            title={session.keyName ?? undefined}
          >
            {session.keyName || '-'}
          </span>
        </div>
        <div className='flex min-w-0 items-center gap-1'>
          <Cpu className='h-3 w-3 flex-shrink-0 text-muted-foreground' />
          <span
            className='max-w-[120px] truncate font-mono text-xs'
            title={`${session.model ?? '-'} @ ${provider ?? '-'}`}
          >
            {session.model || '-'}
            {provider ? (
              <span className='text-muted-foreground'> @ {provider}</span>
            ) : null}
          </span>
        </div>
        <div className='ml-auto flex flex-shrink-0 items-center gap-1'>
          <Clock className='h-3 w-3 text-muted-foreground' />
          <span className='font-mono text-xs text-muted-foreground'>
            {formatSpan(
              Date.parse(session.lastAt) - Date.parse(session.firstAt)
            )}
          </span>
        </div>
        <div className='flex flex-shrink-0 items-center gap-2 font-mono text-xs'>
          <span className='text-muted-foreground'>
            {translate('logs:sessionRequests', {
              count: session.requests,
              tokens: formatTokenAmount(session.totalTokens),
            })}
          </span>
          {session.totalCost > 0 ? (
            <span className='font-medium'>
              {formatCurrency(session.totalCost, 4)}
            </span>
          ) : null}
        </div>
      </div>
    </button>
  )
}

/**
 * 近 5 分钟有请求的会话（hub `ActiveSessionsList`）。tapmodels 请求完成才落库，
 * 没有「进行中」态，所以状态图标只区分末次成功 / 失败；点击改为按会话筛选日志。
 */
export function ActiveSessionsList({
  maxHeight = '200px',
  onSelectSession,
}: {
  maxHeight?: string
  onSelectSession: (sessionId: string) => void
}) {
  const { t: translate } = useTranslation('logs')

  const { data, isLoading } = useQuery(activeSessionsQueryOptions())
  const sessions = data?.sessions ?? []
  return (
    <div className='rounded-lg border bg-card'>
      <div className='flex items-center justify-between border-b px-4 py-3'>
        <div className='flex items-center gap-2'>
          <Activity className='h-4 w-4 text-primary' />
          <h3 className='text-sm font-semibold'>
            {translate('logs:activeSessions')}
          </h3>
          <span className='text-xs text-muted-foreground'>
            {translate('logs:activeSessionWindow', {
              count: data?.total ?? 0,
              window: new Intl.NumberFormat(i18n.language, {
                style: 'unit',
                unit: 'minute',
                unitDisplay: 'long',
              }).format(data?.minutes ?? 5),
            })}
          </span>
        </div>
      </div>
      <div style={{ maxHeight }} className='overflow-y-auto'>
        {isLoading && !sessions.length ? (
          <div
            className='flex items-center justify-center text-sm text-muted-foreground'
            style={{ height: maxHeight }}
          >
            <Loader2 className='mr-2 h-4 w-4 animate-spin' />
            {translate('logs:loading')}
          </div>
        ) : !sessions.length ? (
          <div
            className='flex items-center justify-center text-sm text-muted-foreground'
            style={{ height: maxHeight }}
          >
            {translate('logs:noActiveSessions')}
          </div>
        ) : (
          <div className='divide-y'>
            {sessions.map((session) => (
              <SessionListItem
                key={session.sessionId}
                session={session}
                onSelect={onSelectSession}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
