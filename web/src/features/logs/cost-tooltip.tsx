import type { ReactNode } from 'react'
import type { UsageLogRow } from '@/types/panel-usage-logs'
import { useTranslation } from 'react-i18next'
import { formatCurrency } from '@/lib/usage-format'
import { Badge } from '@/components/ui/badge'
import {
  cacheCostSplit,
  cacheWriteSplit,
  effectiveMultiplier,
  unitPricePerMillion,
} from './log-display'

const LABEL = 'text-[11px] text-primary-foreground/70'
const PURPLE =
  'bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/30 dark:text-purple-300 dark:border-purple-800'

function CostRow({
  label,
  amount,
  tokens,
}: {
  label: ReactNode
  amount: number
  tokens: number
}) {
  const { t: translate } = useTranslation('logs')

  const unit = unitPricePerMillion(amount, tokens)
  return (
    <div className='flex items-start justify-between gap-3'>
      <span className={LABEL}>{label}</span>
      <div className='text-right font-mono tabular-nums'>
        <div>{formatCurrency(amount, 6)}</div>
        {unit ? (
          <div className={LABEL}>
            @ ${unit}
            {translate('logs:perMillion')}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function TtlChip({ ttl }: { ttl: '5m' | '1h' }) {
  useTranslation('logs')

  return (
    <Badge
      variant='outline'
      className='ml-1 border-primary-foreground/30 px-1 text-[10px] leading-tight text-primary-foreground/80'
    >
      {ttl}
    </Badge>
  )
}

/**
 * 成本列 tooltip（hub `renderCostTooltip`）。明细金额是官方标准价，
 * 分组倍率生效时总费用 = 实收，基础合计划线展示。
 */
export function CostTooltipContent({ row }: { row: UsageLogRow }) {
  const { t: translate } = useTranslation('logs')

  const breakdown = row.costBreakdown
  const multiplier = effectiveMultiplier(
    breakdown?.groupMultiplier ?? row.groupCostMultiplier
  )
  const total = row.actualCostUsd ?? row.costUsd
  const baseTotal = breakdown?.baseTotal ?? row.costUsd

  const tokenSplit = cacheWriteSplit({
    total: row.cacheCreationInputTokens ?? null,
    fiveM: row.cacheCreation5mInputTokens,
    oneH: row.cacheCreation1hInputTokens,
    ttl: row.cacheTtlApplied,
  })
  const costSplit = cacheCostSplit(
    breakdown?.cacheCreation ?? null,
    tokenSplit,
    row.cacheTtlApplied
  )

  return (
    <div className='space-y-3'>
      <div className='flex items-center justify-between gap-2'>
        <span className='text-xs font-semibold'>
          {translate('logs:billingDetails')}
        </span>
        {row.context1mApplied ? (
          <Badge
            variant='outline'
            className={`shrink-0 px-1 text-[10px] leading-tight ${PURPLE}`}
          >
            {translate('logs:oneMillionContext')}
          </Badge>
        ) : null}
      </div>
      {breakdown ? (
        <div className='space-y-2'>
          {(breakdown.input ?? 0) > 0 ? (
            <CostRow
              label={translate('logs:input')}
              amount={breakdown.input ?? 0}
              tokens={row.inputTokens}
            />
          ) : null}
          {(breakdown.output ?? 0) > 0 ? (
            <CostRow
              label={translate('logs:output')}
              amount={breakdown.output ?? 0}
              tokens={row.outputTokens}
            />
          ) : null}
          {costSplit.fiveM > 0 ? (
            <CostRow
              label={
                <>
                  {translate('logs:cacheWrite')}
                  <TtlChip ttl='5m' />
                </>
              }
              amount={costSplit.fiveM}
              tokens={tokenSplit.fiveM}
            />
          ) : null}
          {costSplit.oneH > 0 ? (
            <CostRow
              label={
                <>
                  {translate('logs:cacheWrite')}
                  <TtlChip ttl='1h' />
                </>
              }
              amount={costSplit.oneH}
              tokens={tokenSplit.oneH}
            />
          ) : null}
          {(breakdown.cacheRead ?? 0) > 0 ? (
            <CostRow
              label={translate('logs:cacheRead')}
              amount={breakdown.cacheRead ?? 0}
              tokens={row.cacheReadInputTokens}
            />
          ) : null}
          {multiplier != null && baseTotal != null ? (
            <div className='flex items-center justify-between gap-3 border-t border-primary-foreground/20 pt-2'>
              <span className={LABEL}>{translate('logs:baseTotal')}</span>
              <span className='font-mono tabular-nums'>
                {formatCurrency(baseTotal, 6)}
              </span>
            </div>
          ) : null}
          {multiplier != null ? (
            <div className='space-y-2 rounded-md border border-primary-foreground/20 bg-primary-foreground/10 p-2'>
              <div className='flex items-center justify-between text-[11px]'>
                <span className='text-primary-foreground/70'>
                  {translate('logs:groupMultiplier')}
                </span>
                <span className='font-mono'>
                  {translate('logs:multiplierSymbol')}
                  {multiplier.toFixed(2)}
                </span>
              </div>
            </div>
          ) : null}
          {breakdown.pricingModel ? (
            <div className='flex items-center justify-between gap-3'>
              <span className={LABEL}>{translate('logs:pricingModel')}</span>
              <span className='truncate font-mono text-[11px]'>
                {breakdown.pricingModel === 'unpriced'
                  ? translate('logs:noPriceTable')
                  : breakdown.pricingModel}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}
      <div className='flex items-end justify-between gap-3 border-t border-primary-foreground/20 pt-2'>
        <span className={LABEL}>{translate('logs:totalCost')}</span>
        <div className='text-right font-mono tabular-nums'>
          {multiplier != null && baseTotal != null ? (
            <div className='text-[11px] text-primary-foreground/60 line-through'>
              {formatCurrency(baseTotal, 6)}
            </div>
          ) : null}
          <div className='text-sm font-semibold text-emerald-300 dark:text-emerald-700'>
            {formatCurrency(total, 6)}
          </div>
        </div>
      </div>
    </div>
  )
}
