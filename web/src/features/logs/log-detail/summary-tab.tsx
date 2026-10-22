import { useEffect } from 'react'
import { Link } from '@tanstack/react-router'
import type { UsageLogRow } from '@/types/panel-usage-logs'
import {
  AlertCircle,
  ArrowRight,
  CheckCircle,
  Clock,
  DatabaseZap,
  DollarSign,
  Globe,
  InfoIcon,
  Monitor,
  Settings2,
  Zap,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  calculateOutputRate,
  formatCurrency,
  formatTokenAmount,
  shouldHideOutputRate,
} from '@/lib/usage-format'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { formatDuration } from '@/features/logs/display-time'
import { ThinkingEffortBadge } from '../log-cells'
import {
  actualCacheRate,
  cacheCostSplit,
  cacheWriteSplit,
  effectiveMultiplier,
  hasFastMode,
  isSuccessStatus,
  resolveModelAuditDisplay,
  terminalStateLabel,
  errorOwnerLabel,
} from '../log-display'

function SectionTitle({
  icon: Icon,
  color,
  children,
}: {
  icon: typeof Zap
  color: string
  children: React.ReactNode
}) {
  useTranslation('logs')

  return (
    <h4 className='flex items-center gap-2 text-sm font-semibold'>
      <Icon className={cn('h-4 w-4', color)} />
      {children}
    </h4>
  )
}

function MetricCard({
  icon: Icon,
  iconClass,
  bgClass,
  label,
  value,
}: {
  icon: typeof Zap
  iconClass: string
  bgClass: string
  label: string
  value: string
}) {
  useTranslation('logs')

  return (
    <div className='flex items-center gap-3 rounded-lg border bg-card p-3'>
      <div
        className={cn(
          'flex h-9 w-9 items-center justify-center rounded-lg',
          bgClass
        )}
      >
        <Icon className={cn('h-4 w-4', iconClass)} />
      </div>
      <div>
        <div className='text-xs text-muted-foreground'>{label}</div>
        <div className='font-mono text-sm font-semibold'>{value}</div>
      </div>
    </div>
  )
}

function BillingRow({
  label,
  children,
  className,
}: {
  label: string
  children: React.ReactNode
  className?: string
}) {
  useTranslation('logs')

  return (
    <div className={cn('flex justify-between gap-3', className)}>
      <span className='text-muted-foreground'>{label}:</span>
      <span className='text-right font-mono'>{children}</span>
    </div>
  )
}

function Cost({ value }: { value: number | null | undefined }) {
  useTranslation('logs')

  if (value == null || value <= 0) return null
  return (
    <span className='ml-3 text-muted-foreground'>
      {formatCurrency(value, 6)}
    </span>
  )
}

/** 「概览」：hub SummaryTab 的各区块，按 tapmodels 实有字段取舍。 */
export function SummaryTab({
  row,
  scrollToRedirect,
}: {
  row: UsageLogRow
  scrollToRedirect: boolean
}) {
  const { t: translate } = useTranslation('logs')

  const audit = resolveModelAuditDisplay(row)
  const success = isSuccessStatus(row.statusCode)
  const rate = calculateOutputRate(row.outputTokens, row.durationMs, row.ttftMs)
  const showRate =
    rate != null && !shouldHideOutputRate(rate, row.durationMs, row.ttftMs)
  const totalTokens = row.inputTokens + row.outputTokens
  const breakdown = row.costBreakdown
  const tokenSplit = cacheWriteSplit({
    total: row.cacheCreationInputTokens,
    fiveM: row.cacheCreation5mInputTokens,
    oneH: row.cacheCreation1hInputTokens,
    ttl: row.cacheTtlApplied,
  })
  const costSplit = cacheCostSplit(
    breakdown?.cacheCreation ?? null,
    tokenSplit,
    row.cacheTtlApplied
  )
  const multiplier = effectiveMultiplier(
    breakdown?.groupMultiplier ?? row.groupCostMultiplier
  )
  const cacheRate = actualCacheRate(row)
  const totalCost = row.actualCostUsd ?? row.costUsd

  useEffect(() => {
    if (!scrollToRedirect) return
    const id = setTimeout(() => {
      document
        .getElementById('model-redirect-section')
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 100)
    return () => clearTimeout(id)
  }, [scrollToRedirect])

  return (
    <div className='space-y-6'>
      <div
        className={cn(
          'flex items-center gap-4 rounded-lg border p-4',
          success
            ? 'border-emerald-200 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/20'
            : 'border-rose-200 bg-rose-50 dark:border-rose-800 dark:bg-rose-950/20'
        )}
      >
        <div
          className={cn(
            'flex h-12 w-12 items-center justify-center rounded-full',
            success
              ? 'bg-emerald-100 dark:bg-emerald-900/30'
              : 'bg-rose-100 dark:bg-rose-900/30'
          )}
        >
          {success ? (
            <CheckCircle className='h-6 w-6 text-emerald-600' />
          ) : (
            <AlertCircle className='h-6 w-6 text-rose-600' />
          )}
        </div>
        <div>
          <div className='flex items-center gap-2'>
            <span className='text-lg font-semibold'>
              {row.statusCode ?? translate('logs:unknown')}
            </span>
            {row.statusCode != null ? (
              <Badge
                variant={success ? 'default' : 'destructive'}
                className='text-xs'
              >
                {success ? 'OK' : translate('common:error')}
              </Badge>
            ) : null}
            {row.errorLabel ? (
              <Badge variant='outline' className='text-xs'>
                {row.errorLabel}
              </Badge>
            ) : null}
          </div>
          <p className='text-sm text-muted-foreground'>
            {success
              ? translate('logs:requestCompleted')
              : translate('logs:requestFailedDetails')}
          </p>
        </div>
      </div>

      {row.costUsd != null || totalTokens > 0 || row.durationMs != null ? (
        <div className='space-y-2'>
          <h4 className='text-sm font-semibold text-muted-foreground'>
            {translate('logs:keyMetrics')}
          </h4>
          <div className='grid grid-cols-2 gap-3'>
            {totalCost != null ? (
              <MetricCard
                icon={DollarSign}
                iconClass='text-emerald-600'
                bgClass='bg-emerald-100 dark:bg-emerald-900/30'
                label={translate('logs:totalCost')}
                value={formatCurrency(totalCost, 6)}
              />
            ) : null}
            {totalTokens > 0 ? (
              <MetricCard
                icon={Zap}
                iconClass='text-blue-600'
                bgClass='bg-blue-100 dark:bg-blue-900/30'
                label={translate('logs:totalTokensLong')}
                value={formatTokenAmount(totalTokens)}
              />
            ) : null}
            {row.durationMs != null ? (
              <MetricCard
                icon={Clock}
                iconClass='text-purple-600'
                bgClass='bg-purple-100 dark:bg-purple-900/30'
                label={translate('logs:duration')}
                value={formatDuration(row.durationMs)}
              />
            ) : null}
            {showRate ? (
              <MetricCard
                icon={Zap}
                iconClass='text-amber-600'
                bgClass='bg-amber-100 dark:bg-amber-900/30'
                label={translate('logs:outputRate')}
                value={`${rate.toFixed(1)} tok/s`}
              />
            ) : null}
          </div>
        </div>
      ) : null}

      {cacheRate != null &&
      row.cacheReadInputTokens + row.cacheCreationInputTokens > 0 ? (
        <div className='space-y-2'>
          <SectionTitle icon={DatabaseZap} color='text-cyan-600'>
            {translate('logs:cachePerformance')}
          </SectionTitle>
          <div className='grid grid-cols-1 gap-3 sm:grid-cols-3'>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className='cursor-help rounded-lg border bg-card p-3'>
                  <div className='text-xs text-muted-foreground'>
                    {translate('logs:actualCacheRate')}
                  </div>
                  <div className='font-mono text-sm font-semibold'>
                    {(cacheRate * 100).toFixed(1)}%
                  </div>
                </div>
              </TooltipTrigger>
              <TooltipContent>{translate('logs:cacheRateHint')}</TooltipContent>
            </Tooltip>
            <div className='rounded-lg border bg-card p-3'>
              <div className='text-xs text-muted-foreground'>
                {translate('logs:cacheRead')}
              </div>
              <div className='font-mono text-sm font-semibold'>
                {formatTokenAmount(row.cacheReadInputTokens)}
              </div>
            </div>
            <div className='rounded-lg border bg-card p-3'>
              <div className='text-xs text-muted-foreground'>
                {translate('logs:cacheWrite')}
              </div>
              <div className='font-mono text-sm font-semibold'>
                {formatTokenAmount(row.cacheCreationInputTokens)}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {row.sessionId ||
      row.clientSessionId ||
      row.inboundDeviceId ||
      row.reasoningEffort ||
      row.requestId ? (
        <div className='space-y-2'>
          <h4 className='text-sm font-semibold'>
            {translate('logs:sessionInformation')}
          </h4>
          <div className='divide-y rounded-lg border bg-card'>
            {row.sessionId ? (
              <div className='flex items-center gap-2 p-4'>
                <span className='shrink-0 text-xs text-muted-foreground'>
                  {translate('logs:outboundSession')}
                </span>
                <Link
                  to='/logs'
                  search={{ sessionId: row.sessionId }}
                  className='min-w-0 truncate font-mono text-xs underline-offset-2 hover:underline'
                >
                  {row.sessionId}
                </Link>
              </div>
            ) : null}
            {row.clientSessionId && row.clientSessionId !== row.sessionId ? (
              <div className='flex items-center gap-2 p-4'>
                <span className='shrink-0 text-xs text-muted-foreground'>
                  {translate('logs:clientSession')}
                </span>
                <Link
                  to='/logs'
                  search={{ sessionId: row.clientSessionId }}
                  className='min-w-0 truncate font-mono text-xs text-muted-foreground underline-offset-2 hover:underline'
                >
                  {row.clientSessionId}
                </Link>
              </div>
            ) : null}
            {row.inboundDeviceId ? (
              <div className='flex items-center gap-2 p-4'>
                <span className='shrink-0 text-xs text-muted-foreground'>
                  {translate('logs:deviceId')}
                </span>
                <span className='min-w-0 truncate font-mono text-xs'>
                  {row.inboundDeviceId}
                </span>
              </div>
            ) : null}
            {row.requestId ? (
              <div className='flex items-center gap-2 p-4'>
                <span className='shrink-0 text-xs text-muted-foreground'>
                  {translate('logs:requestId')}
                </span>
                <span className='min-w-0 truncate font-mono text-xs'>
                  {row.requestId}
                </span>
              </div>
            ) : null}
            {row.reasoningEffort ? (
              <div className='flex items-center gap-2 p-4'>
                <span className='shrink-0 text-xs text-muted-foreground'>
                  {translate('logs:reasoningEffort')}
                </span>
                <ThinkingEffortBadge effort={row.reasoningEffort} />
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {row.userAgent || row.endpoint || row.clientIp ? (
        <div className='space-y-2'>
          <SectionTitle icon={Monitor} color='text-blue-600'>
            {translate('logs:clientInformation')}
          </SectionTitle>
          <div className='divide-y rounded-lg border bg-card'>
            {row.clientIp ? (
              <div className='flex items-center justify-between gap-3 p-3'>
                <span className='text-xs text-muted-foreground'>
                  {translate('logs:ip')}
                </span>
                <code className='font-mono text-xs'>{row.clientIp}</code>
              </div>
            ) : null}
            {row.userAgent ? (
              <div className='space-y-1 p-3'>
                <span className='text-xs text-muted-foreground'>
                  {translate('logs:userAgent')}
                </span>
                <code className='block font-mono text-xs break-all'>
                  {row.userAgent}
                </code>
              </div>
            ) : null}
            {row.endpoint ? (
              <div className='flex items-center justify-between gap-3 p-3'>
                <span className='flex items-center gap-1 text-xs text-muted-foreground'>
                  <Globe className='h-3 w-3' />
                  {translate('logs:endpointEnglish')}
                </span>
                <code className='font-mono text-xs'>
                  {row.method ? `${row.method} ` : ''}
                  {row.endpoint}
                </code>
              </div>
            ) : null}
            {row.protocol ? (
              <div className='flex items-center justify-between gap-3 p-3'>
                <span className='text-xs text-muted-foreground'>
                  {translate('logs:protocol')}
                </span>
                <code className='font-mono text-xs'>{row.protocol}</code>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {row.costUsd != null ? (
        <div className='space-y-2'>
          <SectionTitle icon={DollarSign} color='text-emerald-600'>
            {translate('logs:billingInformation')}
          </SectionTitle>
          <div className='space-y-3 rounded-lg border bg-card p-4'>
            <div className='space-y-2 text-sm'>
              <BillingRow label={translate('logs:input')}>
                {translate('logs:tokenAmount', {
                  amount: formatTokenAmount(row.inputTokens),
                })}
                <Cost value={breakdown?.input} />
              </BillingRow>
              <BillingRow label={translate('logs:output')}>
                {translate('logs:tokenAmount', {
                  amount: formatTokenAmount(row.outputTokens),
                })}
                <Cost value={breakdown?.output} />
              </BillingRow>
              {tokenSplit.fiveM > 0 ? (
                <BillingRow label={translate('logs:cacheWriteFiveMinutes')}>
                  {translate('logs:tokenAmount', {
                    amount: formatTokenAmount(tokenSplit.fiveM),
                  })}{' '}
                  <span className='text-orange-600'>
                    {translate('logs:shortCacheMultiplier')}
                  </span>
                  <Cost value={costSplit.fiveM} />
                </BillingRow>
              ) : null}
              {tokenSplit.oneH > 0 ? (
                <BillingRow label={translate('logs:cacheWriteOneHour')}>
                  {translate('logs:tokenAmount', {
                    amount: formatTokenAmount(tokenSplit.oneH),
                  })}{' '}
                  <span className='text-orange-600'>
                    {translate('logs:longCacheMultiplier')}
                  </span>
                  <Cost value={costSplit.oneH} />
                </BillingRow>
              ) : null}
              {row.cacheReadInputTokens > 0 ? (
                <BillingRow label={translate('logs:cacheRead')}>
                  {translate('logs:tokenAmount', {
                    amount: formatTokenAmount(row.cacheReadInputTokens),
                  })}{' '}
                  <span className='text-emerald-600'>
                    {translate('logs:cacheReadMultiplier')}
                  </span>
                  <Cost value={breakdown?.cacheRead} />
                </BillingRow>
              ) : null}
              {row.cacheTtlApplied ? (
                <BillingRow label={translate('logs:cacheTtl')}>
                  <Badge variant='outline' className='text-xs'>
                    {row.cacheTtlApplied}
                  </Badge>
                </BillingRow>
              ) : null}
              {row.context1mApplied ? (
                <BillingRow label={translate('logs:oneMillionContext')}>
                  <Badge
                    variant='outline'
                    className='border-purple-200 bg-purple-50 text-xs text-purple-700 dark:border-purple-800 dark:bg-purple-950/30 dark:text-purple-300'
                  >
                    {translate('logs:contextMillion')}
                  </Badge>{' '}
                  <span className='text-xs text-muted-foreground'>
                    {translate('logs:contextMillionEnabled')}
                  </span>
                </BillingRow>
              ) : null}
              {hasFastMode(row) ? (
                <BillingRow label={translate('logs:fast')}>
                  <Badge
                    variant='outline'
                    className='border-orange-200 bg-orange-50 text-xs text-orange-700 dark:border-orange-800 dark:bg-orange-950/30 dark:text-orange-300'
                  >
                    {translate('logs:priorityService')}
                  </Badge>
                </BillingRow>
              ) : null}
              {breakdown?.pricingModel ? (
                <BillingRow label={translate('logs:pricingModel')}>
                  {breakdown.pricingModel === 'unpriced'
                    ? translate('logs:noPriceTable')
                    : breakdown.pricingModel}
                </BillingRow>
              ) : null}
              {breakdown?.baseTotal != null ? (
                <BillingRow
                  label={translate('logs:baseTotal')}
                  className='border-t pt-2'
                >
                  <span className='font-medium'>
                    {formatCurrency(breakdown.baseTotal, 6)}
                  </span>
                </BillingRow>
              ) : null}
              {multiplier != null ? (
                <BillingRow label={translate('logs:groupMultiplier')}>
                  {multiplier.toFixed(2)}
                  {translate('logs:multiplierSymbol')}
                </BillingRow>
              ) : null}
            </div>
            <div className='flex items-center justify-between border-t pt-3'>
              <span className='font-medium'>{translate('logs:totalCost')}</span>
              <span className='font-mono text-lg font-semibold text-emerald-600'>
                {formatCurrency(totalCost, 6)}
              </span>
            </div>
          </div>
        </div>
      ) : null}

      {row.specialSettings?.length ? (
        <div className='space-y-2'>
          <SectionTitle icon={Settings2} color='text-purple-600'>
            {translate('logs:specialSettings')}
          </SectionTitle>
          <div className='flex flex-wrap gap-2 rounded-lg border bg-card p-4'>
            {row.specialSettings.map((setting) => (
              <Badge
                key={setting.key}
                variant='outline'
                className='text-xs'
                title={setting.value ?? undefined}
              >
                {setting.label}
                {setting.value && setting.key !== 'mismatch'
                  ? `: ${setting.value}`
                  : ''}
              </Badge>
            ))}
          </div>
        </div>
      ) : null}

      <div className='space-y-2'>
        <h4 className='flex items-center gap-2 text-sm font-semibold'>
          <Settings2 className='h-4 w-4 text-slate-600' />
          {translate('logs:model')}
          {audit.hasActualMismatch ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <InfoIcon className='h-3.5 w-3.5 text-muted-foreground' />
              </TooltipTrigger>
              <TooltipContent className='max-w-xs'>
                {translate('logs:modelMismatchHint')}
              </TooltipContent>
            </Tooltip>
          ) : null}
        </h4>
        <div className='space-y-2 rounded-lg border bg-card p-3'>
          {audit.hasActualMismatch ? (
            <>
              <div className='flex items-center gap-2'>
                <span className='min-w-[6rem] text-xs text-muted-foreground'>
                  {translate('logs:requestedModel')}
                </span>
                <code className='rounded bg-slate-100 px-1.5 py-0.5 text-xs dark:bg-slate-800'>
                  {audit.effectiveRequestModel}
                </code>
              </div>
              <div className='flex items-center gap-2'>
                <span className='min-w-[6rem] text-xs text-muted-foreground'>
                  {translate('logs:actualModel')}
                </span>
                <code className='rounded bg-slate-100 px-1.5 py-0.5 text-xs dark:bg-slate-800'>
                  {audit.secondaryActualModel}
                </code>
              </div>
            </>
          ) : (
            <code className='rounded bg-slate-100 px-1.5 py-0.5 text-xs dark:bg-slate-800'>
              {audit.effectiveRequestModel ?? '-'}
            </code>
          )}
        </div>
      </div>

      {audit.hasRedirect ? (
        <div id='model-redirect-section' className='space-y-2'>
          <SectionTitle icon={ArrowRight} color='text-blue-600'>
            {translate('logs:modelRedirect')}
          </SectionTitle>
          <div className='rounded-lg border bg-blue-50 p-3 dark:bg-blue-950/20'>
            <div className='flex flex-wrap items-center gap-2'>
              <code className='rounded bg-blue-100 px-1.5 py-0.5 text-xs text-blue-800 dark:bg-blue-900/50 dark:text-blue-200'>
                {row.originalModel}
              </code>
              <ArrowRight className='h-3.5 w-3.5 text-blue-500' />
              <code className='rounded bg-emerald-100 px-1.5 py-0.5 text-xs text-emerald-800 ring-1 ring-emerald-300 dark:bg-emerald-900/50 dark:text-emerald-200 dark:ring-emerald-700'>
                {row.model}
              </code>
            </div>
            <p className='mt-2 text-xs text-muted-foreground'>
              {translate('logs:billingActual')}
            </p>
          </div>
        </div>
      ) : null}

      {row.errorMessage || row.errorCode ? (
        <div className='space-y-2'>
          <SectionTitle icon={AlertCircle} color='text-rose-600'>
            {translate('logs:errorInformation')}
          </SectionTitle>
          <div className='space-y-1 rounded-lg border bg-rose-50 p-3 dark:bg-rose-950/20'>
            {row.errorCode || row.errorOwner ? (
              <div className='flex flex-wrap gap-1'>
                {row.errorCode ? (
                  <Badge variant='outline' className='font-mono text-[10px]'>
                    {row.errorCode}
                  </Badge>
                ) : null}
                {row.errorOwner ? (
                  <Badge variant='outline' className='text-[10px]'>
                    {translate('logs:errorAttribution', {
                      owner: errorOwnerLabel(row.errorOwner),
                    })}
                  </Badge>
                ) : null}
              </div>
            ) : null}
            {row.errorMessage ? (
              <p className='font-mono text-xs break-words whitespace-pre-wrap text-rose-800 dark:text-rose-200'>
                {row.errorMessage}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      {row.stopReason || row.via || row.finalState ? (
        <div className='space-y-2'>
          <h4 className='text-sm font-semibold'>
            {translate('logs:executionInformation')}
          </h4>
          <div className='space-y-2 rounded-lg border bg-card p-4 text-sm'>
            {row.stopReason ? (
              <BillingRow label={translate('logs:finishReason')}>
                {row.stopReason}
              </BillingRow>
            ) : null}
            {row.finalState ? (
              <BillingRow label={translate('logs:terminalState')}>
                <span title={row.finalState}>
                  {terminalStateLabel(row.finalState)}
                </span>
              </BillingRow>
            ) : null}
            {row.via ? (
              <BillingRow label={translate('logs:actualChain')}>
                {row.via}
              </BillingRow>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
