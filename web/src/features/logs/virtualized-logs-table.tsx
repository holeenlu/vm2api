import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import type { UsageLogFilters, UsageLogRow } from '@/types/panel-usage-logs'
import { ArrowUp, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  calculateOutputRate,
  formatCurrency,
  formatTokenAmount,
  isNonBillingEndpoint,
  shouldHideOutputRate,
} from '@/lib/usage-format'
import { cn } from '@/lib/utils'
import { useVirtualizedInfiniteList } from '@/hooks/use-virtualized-infinite-list'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { formatDuration } from '@/features/logs/display-time'
import type { LogsTableColumn } from './column-visibility'
import { CostTooltipContent } from './cost-tooltip'
import {
  ModelDisplayWithRedirect,
  StatusBadge,
  ThinkingEffortDisplay,
} from './log-cells'
import { cacheWriteSplit, copyText, hasFastMode } from './log-display'
import { ProviderCell } from './provider-chain-popover'
import { usageLogsBatchQueryOptions } from './queries'
import { RelativeTime } from './relative-time'

const ROW_HEIGHT = 52
const SCROLL_TOP_THRESHOLD = 500

export type DetailTab = 'summary' | 'logic-trace' | 'performance' | 'raw'

export type OpenDetail = (
  row: UsageLogRow,
  opts?: { tab?: DetailTab; chainIndex?: number; scrollToRedirect?: boolean }
) => void

const FAST_BADGE =
  'text-[10px] leading-tight px-1 bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/30 dark:text-orange-300 dark:border-orange-800'
const CONTEXT_1M_BADGE =
  'text-[10px] leading-tight px-1 bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/30 dark:text-purple-300 dark:border-purple-800'
const TTL_BADGE =
  'text-[10px] leading-tight px-1 bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/30 dark:text-blue-300 dark:border-blue-800'

function HeadCell({
  className,
  title,
  children,
}: {
  className: string
  title?: string
  children: string
}) {
  useTranslation('logs')

  return (
    <div className={cn('truncate px-1.5', className)} title={title ?? children}>
      {children}
    </div>
  )
}

function CostBadges({ row }: { row: UsageLogRow }) {
  const { t: translate } = useTranslation('logs')

  const fast = hasFastMode(row)
  const context1m = Boolean(row.context1mApplied)
  if (fast && context1m) {
    return (
      <Badge
        variant='outline'
        className='gap-0 px-0.5 text-[9px] leading-3'
        title={translate('logs:fastMillionContext')}
      >
        <span className='text-orange-700 dark:text-orange-300'>
          {translate('logs:fast')}
        </span>
        <span className='text-muted-foreground'>·</span>
        <span className='text-purple-700 dark:text-purple-300'>
          {translate('logs:million')}
        </span>
      </Badge>
    )
  }
  if (fast) {
    return (
      <Badge
        variant='outline'
        className={FAST_BADGE}
        title={translate('logs:priorityService')}
      >
        {translate('logs:fast')}
      </Badge>
    )
  }
  if (context1m) {
    return (
      <Badge variant='outline' className={CONTEXT_1M_BADGE}>
        {translate('logs:million')}
      </Badge>
    )
  }
  return null
}

function LogRow({
  row,
  hidden,
  onOpenDetail,
}: {
  row: UsageLogRow
  hidden: (column: LogsTableColumn) => boolean
  onOpenDetail: OpenDetail
}) {
  const { t: translate } = useTranslation('logs')

  const nonBilling = isNonBillingEndpoint(row.endpoint)
  const cache = cacheWriteSplit({
    total: row.cacheCreationInputTokens ?? null,
    fiveM: row.cacheCreation5mInputTokens,
    oneH: row.cacheCreation1hInputTokens,
    ttl: row.cacheTtlApplied,
  })
  const rate = calculateOutputRate(row.outputTokens, row.durationMs, row.ttftMs)
  const showRate =
    rate != null && !shouldHideOutputRate(rate, row.durationMs, row.ttftMs)

  return (
    <>
      <div className='min-w-[56px] flex-[0.6] truncate pr-1.5 pl-3 font-mono text-xs'>
        <RelativeTime date={row.createdAt} fallback='-' />
      </div>
      {hidden('user') ? null : (
        <div
          className='min-w-[50px] flex-[0.8] truncate px-1.5 text-sm'
          title={row.userName ?? undefined}
        >
          {row.userName || '-'}
        </div>
      )}
      {hidden('key') ? null : (
        <div
          className='min-w-[50px] flex-[0.6] truncate px-1.5 font-mono text-xs'
          title={row.keyName ?? undefined}
        >
          {row.keyName || '-'}
        </div>
      )}
      {hidden('sessionId') ? null : (
        <div className='min-w-[80px] flex-[0.8] px-1.5'>
          {row.sessionId ? (
            <Tooltip delayDuration={300}>
              <TooltipTrigger asChild>
                <button
                  type='button'
                  className='w-full cursor-pointer truncate text-left font-mono text-xs hover:underline'
                  onClick={() => row.sessionId && void copyText(row.sessionId)}
                >
                  {row.sessionId}
                </button>
              </TooltipTrigger>
              <TooltipContent side='bottom' className='max-w-[500px] space-y-1'>
                <span className='block font-mono text-xs break-all'>
                  {translate('logs:outboundSessionValue', {
                    session: row.sessionId,
                  })}
                </span>
                {row.clientSessionId &&
                row.clientSessionId !== row.sessionId ? (
                  <span className='block font-mono text-xs break-all opacity-70'>
                    {translate('logs:clientSessionValue', {
                      session: row.clientSessionId,
                    })}
                  </span>
                ) : null}
              </TooltipContent>
            </Tooltip>
          ) : (
            <span className='font-mono text-xs text-muted-foreground'>-</span>
          )}
        </div>
      )}
      {hidden('ip') ? null : (
        <div className='min-w-[90px] flex-[0.8] overflow-hidden px-1.5'>
          {row.clientIp ? (
            <button
              type='button'
              title={translate('logs:clickToCopy')}
              className='block w-full max-w-full min-w-0 cursor-pointer truncate text-left font-mono text-xs hover:underline'
              onClick={() => row.clientIp && void copyText(row.clientIp)}
            >
              {row.clientIp}
            </button>
          ) : (
            <span className='block font-mono text-xs text-muted-foreground'>
              —
            </span>
          )}
        </div>
      )}
      {hidden('provider') ? null : (
        <div className='min-w-[100px] flex-[1.5] px-1.5'>
          <ProviderCell
            row={row}
            onChainItemClick={(chainIndex) =>
              onOpenDetail(row, { tab: 'logic-trace', chainIndex })
            }
          />
        </div>
      )}
      <div className='min-w-[100px] flex-[1.3] px-1.5 font-mono text-xs'>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className='flex min-w-0 cursor-help items-center gap-1 truncate'>
              <ModelDisplayWithRedirect
                row={row}
                onRedirectClick={() =>
                  onOpenDetail(row, { scrollToRedirect: true })
                }
              />
            </div>
          </TooltipTrigger>
          <TooltipContent>
            <p className='text-xs'>{row.originalModel || row.model || '-'}</p>
          </TooltipContent>
        </Tooltip>
      </div>
      {hidden('reasoningEffort') ? null : (
        <div className='relative z-20 min-w-[64px] flex-[0.6] overflow-visible px-1.5 font-mono text-xs'>
          <ThinkingEffortDisplay effort={row.reasoningEffort} />
        </div>
      )}
      {hidden('tokens') ? null : (
        <div className='min-w-[70px] flex-[0.7] px-1.5 text-right font-mono text-xs'>
          <Tooltip delayDuration={250}>
            <TooltipTrigger asChild>
              <div className='flex cursor-help flex-col items-end leading-tight tabular-nums'>
                <span>{formatTokenAmount(row.inputTokens)}</span>
                <span className='text-muted-foreground'>
                  {formatTokenAmount(row.outputTokens)}
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent align='end' className='space-y-1 text-xs'>
              <div>
                {translate('logs:inputAmount', {
                  amount: formatTokenAmount(row.inputTokens),
                })}
              </div>
              <div>
                {translate('logs:outputAmount', {
                  amount: formatTokenAmount(row.outputTokens),
                })}
              </div>
            </TooltipContent>
          </Tooltip>
        </div>
      )}
      {hidden('cache') ? null : (
        <div className='min-w-[70px] flex-[0.8] px-1.5 text-right font-mono text-xs'>
          <Tooltip delayDuration={250}>
            <TooltipTrigger asChild>
              <div className='flex cursor-help flex-col items-end leading-tight tabular-nums'>
                <div className='flex w-full items-center gap-1'>
                  {row.cacheTtlApplied ? (
                    <Badge variant='outline' className={TTL_BADGE}>
                      {row.cacheTtlApplied}
                    </Badge>
                  ) : null}
                  <span className='ml-auto'>
                    {formatTokenAmount(row.cacheCreationInputTokens)}
                  </span>
                </div>
                <span className='text-muted-foreground'>
                  {formatTokenAmount(row.cacheReadInputTokens)}
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent align='end' className='space-y-1 text-xs'>
              <div className='font-medium'>{translate('logs:cacheWrite')}</div>
              <div className='pl-2'>
                {translate('logs:cacheFiveMinuteAmount', {
                  amount: formatTokenAmount(cache.fiveM),
                })}
              </div>
              <div className='pl-2'>
                {translate('logs:cacheHourAmount', {
                  amount: formatTokenAmount(cache.oneH),
                })}
              </div>
              <div className='mt-1 font-medium'>
                {translate('logs:cacheRead')}
              </div>
              <div className='pl-2'>
                {formatTokenAmount(row.cacheReadInputTokens)}
              </div>
            </TooltipContent>
          </Tooltip>
        </div>
      )}
      {hidden('cost') ? null : (
        <div className='min-w-[50px] flex-[0.6] px-1.5 text-right font-mono text-xs'>
          {row.billingStatus?.startsWith('pending') ? (
            <span className='text-amber-600'>
              {translate('logs:pendingReconciliation')}
            </span>
          ) : nonBilling || row.costUsd == null ? (
            '-'
          ) : (
            <Tooltip delayDuration={250}>
              <TooltipTrigger asChild>
                <span className='inline-flex cursor-help items-center gap-1'>
                  {formatCurrency(row.actualCostUsd ?? row.costUsd, 6)}
                  <CostBadges row={row} />
                </span>
              </TooltipTrigger>
              <TooltipContent align='end' className='max-w-[320px] p-3'>
                <CostTooltipContent row={row} />
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      )}
      {hidden('performance') ? null : (
        <div className='min-w-[80px] flex-[0.8] px-1.5 text-right font-mono text-xs'>
          <Tooltip delayDuration={250}>
            <TooltipTrigger asChild>
              <div className='flex cursor-help flex-col items-end'>
                <span>{formatDuration(row.durationMs)}</span>
                {row.ttftMs != null && row.ttftMs > 0 ? (
                  <span className='text-[10px] text-muted-foreground'>
                    {translate('logs:ttftValue', {
                      duration: formatDuration(row.ttftMs),
                    })}
                  </span>
                ) : null}
                {showRate ? (
                  <span className='text-[10px] text-muted-foreground'>
                    {translate('logs:rateValue', { rate: rate.toFixed(0) })}
                  </span>
                ) : null}
              </div>
            </TooltipTrigger>
            <TooltipContent align='end' className='space-y-1 text-xs'>
              <div>
                {translate('logs:totalDurationValue', {
                  duration: formatDuration(row.durationMs),
                })}
              </div>
              {row.ttftMs != null ? (
                <div>
                  {translate('logs:ttftDurationValue', {
                    duration: formatDuration(row.ttftMs),
                  })}
                </div>
              ) : null}
              {showRate ? (
                <div>
                  {translate('logs:outputRateValue', { rate: rate.toFixed(1) })}
                </div>
              ) : null}
            </TooltipContent>
          </Tooltip>
        </div>
      )}
      <div className='min-w-[70px] flex-[0.7] truncate pr-3 pl-1.5'>
        <Button
          type='button'
          variant='ghost'
          className='h-auto p-0 font-normal hover:bg-transparent'
          onClick={() => onOpenDetail(row)}
        >
          <StatusBadge
            statusCode={row.statusCode}
            finalState={row.finalState}
            errorCode={row.errorCode}
          />
        </Button>
      </div>
    </>
  )
}

/**
 * 键集游标的无限虚拟列表（hub `VirtualizedLogsTable`）。
 * 轮询只在列表停在顶部附近时进行：往下翻时重拉所有已加载页既慢又会打乱阅读。
 */
export function VirtualizedLogsTable({
  filters,
  autoRefreshEnabled,
  autoRefreshIntervalMs = 5000,
  hiddenColumns,
  hideStatusBar = false,
  hideScrollToTop = false,
  bodyClassName,
  onOpenDetail,
}: {
  filters: UsageLogFilters
  autoRefreshEnabled: boolean
  autoRefreshIntervalMs?: number
  hiddenColumns?: readonly LogsTableColumn[]
  hideStatusBar?: boolean
  hideScrollToTop?: boolean
  bodyClassName?: string
  onOpenDetail: OpenDetail
}) {
  const { t: translate } = useTranslation('logs')

  const scrolledDownRef = useRef(false)
  const query = useInfiniteQuery(
    usageLogsBatchQueryOptions({
      filters,
      pollMs: autoRefreshIntervalMs,
      shouldPoll: () => autoRefreshEnabled && !scrolledDownRef.current,
    })
  )
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } = query
  const allLogs = useMemo(
    () => data?.pages.flatMap((page) => page.logs) ?? [],
    [data]
  )
  const pages = data?.pages
  const lastPageEmpty =
    !!pages?.length && pages[pages.length - 1].logs.length === 0

  const {
    parentRef,
    rowVirtualizer,
    virtualItems,
    showScrollToTop,
    handleScroll,
    scrollToTop,
    resetScrollPosition,
  } = useVirtualizedInfiniteList({
    itemCount: allLogs.length,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
    loadMoreThreshold: 5,
    scrollTopThreshold: SCROLL_TOP_THRESHOLD,
    getItemKey: (index) => allLogs[index]?.id ?? `loader-${index}`,
  })
  scrolledDownRef.current = showScrollToTop

  // 后端在屏蔽类 / 错误类的 JS 后过滤扫到上限时会回一页空数据但 hasMore=true：
  // 这时虚拟列表里没有新行可触发「接近末尾」，需要主动接着拉。
  useEffect(() => {
    if (lastPageEmpty && hasNextPage && !isFetchingNextPage)
      void fetchNextPage()
  }, [lastPageEmpty, hasNextPage, isFetchingNextPage, fetchNextPage])

  const filtersKey = JSON.stringify(filters)
  const resetRef = useRef(resetScrollPosition)
  resetRef.current = resetScrollPosition
  useEffect(() => {
    resetRef.current()
  }, [filtersKey])

  const isHidden = useCallback(
    (column: LogsTableColumn) => hiddenColumns?.includes(column) ?? false,
    [hiddenColumns]
  )

  if (query.isLoading) {
    return (
      <div className='flex items-center justify-center py-12'>
        <Loader2 className='h-6 w-6 animate-spin text-muted-foreground' />
        <span className='ml-2 text-muted-foreground'>
          {translate('logs:loading')}
        </span>
      </div>
    )
  }
  if (query.error) {
    return (
      <div className='py-8 text-center text-destructive'>
        {query.error instanceof Error
          ? query.error.message
          : translate('logs:loadFailed')}
      </div>
    )
  }
  if (!allLogs.length && !hasNextPage) {
    return (
      <div className='py-8 text-center text-muted-foreground'>
        {translate('logs:noData')}
      </div>
    )
  }

  return (
    <div className='space-y-4'>
      {hideStatusBar ? null : (
        <div className='flex items-center justify-between px-3 pt-2 text-xs text-muted-foreground/70'>
          <span>
            {translate('logs:loadedRecords', { count: allLogs.length })}
          </span>
          {isFetchingNextPage ? (
            <span className='flex items-center gap-1.5'>
              <Loader2 className='h-3 w-3 animate-spin' />
              {translate('logs:loadingMore')}
            </span>
          ) : !hasNextPage && allLogs.length > 0 ? (
            <span>{translate('logs:allRecordsLoaded')}</span>
          ) : null}
        </div>
      )}
      <div className='overflow-x-auto'>
        <div className='min-w-[900px]'>
          {/* Same scrollbar gutter as the body below so flex columns resolve to the same widths. */}
          <div className='sticky top-0 z-10 [scrollbar-gutter:stable] overflow-y-hidden border-b bg-muted/30'>
            <div className='flex h-8 items-center text-[11px] font-medium tracking-wide text-muted-foreground/80'>
              <HeadCell className='min-w-[56px] flex-[0.6] pr-1.5 pl-3'>
                {translate('logs:time')}
              </HeadCell>
              {isHidden('user') ? null : (
                <HeadCell className='min-w-[50px] flex-[0.8]'>
                  {translate('logs:user')}
                </HeadCell>
              )}
              {isHidden('key') ? null : (
                <HeadCell className='min-w-[50px] flex-[0.6]'>
                  {translate('logs:key')}
                </HeadCell>
              )}
              {isHidden('sessionId') ? null : (
                <HeadCell
                  className='min-w-[80px] flex-[0.8]'
                  title={translate('logs:outboundSessionHint')}
                >
                  {translate('logs:outboundSession')}
                </HeadCell>
              )}
              {isHidden('ip') ? null : (
                <HeadCell className='min-w-[90px] flex-[0.8]'>
                  {translate('logs:ip')}
                </HeadCell>
              )}
              {isHidden('provider') ? null : (
                <HeadCell className='min-w-[100px] flex-[1.5]'>
                  {translate('logs:provider')}
                </HeadCell>
              )}
              <HeadCell className='min-w-[100px] flex-[1.3]'>
                {translate('logs:billingModel')}
              </HeadCell>
              {isHidden('reasoningEffort') ? null : (
                <HeadCell
                  className='min-w-[64px] flex-[0.6]'
                  title={translate('logs:modelReasoningHint')}
                >
                  {translate('logs:reasoningEffort')}
                </HeadCell>
              )}
              {isHidden('tokens') ? null : (
                <HeadCell className='min-w-[70px] flex-[0.7] text-right'>
                  {translate('logs:tokens')}
                </HeadCell>
              )}
              {isHidden('cache') ? null : (
                <HeadCell className='min-w-[70px] flex-[0.8] text-right'>
                  {translate('logs:cache')}
                </HeadCell>
              )}
              {isHidden('cost') ? null : (
                <HeadCell className='min-w-[50px] flex-[0.6] text-right'>
                  {translate('logs:cost')}
                </HeadCell>
              )}
              {isHidden('performance') ? null : (
                <HeadCell className='min-w-[80px] flex-[0.8] text-right'>
                  {translate('logs:performance')}
                </HeadCell>
              )}
              <HeadCell className='min-w-[70px] flex-[0.7] pr-3 pl-1.5'>
                {translate('logs:status')}
              </HeadCell>
            </div>
          </div>
          <div
            ref={parentRef}
            className={cn(
              'h-[600px] [scrollbar-gutter:stable] overflow-auto',
              bodyClassName
            )}
            onScroll={handleScroll}
          >
            <div
              style={{
                height: `${rowVirtualizer.getTotalSize()}px`,
                width: '100%',
                position: 'relative',
              }}
            >
              {virtualItems.map((virtualRow) => {
                const row = allLogs[virtualRow.index]
                const style = {
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: `${virtualRow.size}px`,
                  transform: `translateY(${virtualRow.start}px)`,
                } as const
                if (!row) {
                  return (
                    <div
                      key='loader'
                      style={style}
                      className='flex items-center justify-center'
                    >
                      <Loader2 className='h-4 w-4 animate-spin text-muted-foreground' />
                    </div>
                  )
                }
                return (
                  <div
                    key={row.id}
                    style={style}
                    role='button'
                    tabIndex={0}
                    className={cn(
                      'flex cursor-pointer items-center border-b border-border/40 text-sm transition-colors outline-none hover:bg-accent/50 focus-visible:bg-accent/50',
                      isNonBillingEndpoint(row.endpoint) &&
                        'bg-muted/30 text-muted-foreground dark:bg-muted/15'
                    )}
                    onClick={(event) => {
                      // Cells with their own action (copy, chain popover, redirect) keep it;
                      // clicks bubbling from portaled popovers are outside the row DOM.
                      const target = event.target as HTMLElement
                      if (!event.currentTarget.contains(target)) return
                      if (target.closest('button, a')) return
                      onOpenDetail(row)
                    }}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget) return
                      if (event.key !== 'Enter' && event.key !== ' ') return
                      event.preventDefault()
                      onOpenDetail(row)
                    }}
                  >
                    <LogRow
                      row={row}
                      hidden={isHidden}
                      onOpenDetail={onOpenDetail}
                    />
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </div>
      {!hideScrollToTop && showScrollToTop ? (
        <Button
          type='button'
          variant='outline'
          size='sm'
          className='fixed right-8 bottom-8 z-50 shadow-lg'
          onClick={scrollToTop}
        >
          <ArrowUp className='mr-1 h-4 w-4' />
          {translate('logs:backToTop')}
        </Button>
      ) : null}
    </div>
  )
}
