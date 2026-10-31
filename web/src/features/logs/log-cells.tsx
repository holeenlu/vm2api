import type { PanelRole } from '@/types/panel-auth'
import type { UsageLogRow } from '@/types/panel-usage-logs'
import { ArrowRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { ModelVendorIcon } from '@/components/model-vendor-icon'
import {
  copyText,
  resolveModelAuditDisplay,
  statusBadgeClass,
  statusBadgeTooltip,
  thinkingEffortBadgeClass,
} from './log-display'

export function StatusBadge({
  statusCode,
  finalState = null,
  errorCode = null,
  className,
}: {
  statusCode: number | null
  finalState?: string | null
  errorCode?: string | null
  className?: string
}) {
  const { t: translate } = useTranslation('logs')

  const badge = (
    <Badge
      variant='outline'
      className={cn(statusBadgeClass(statusCode, finalState), className)}
    >
      {statusCode ?? translate('logs:unknown')}
    </Badge>
  )
  const title = statusBadgeTooltip(statusCode, finalState, errorCode)
  if (!title) return badge
  return (
    <Tooltip delayDuration={250}>
      <TooltipTrigger asChild>
        <span className='inline-flex'>{badge}</span>
      </TooltipTrigger>
      <TooltipContent className='max-w-xs text-xs'>{title}</TooltipContent>
    </Tooltip>
  )
}

export function ThinkingEffortBadge({ effort }: { effort: string }) {
  useTranslation('logs')

  return (
    <Badge
      variant='outline'
      className={cn(
        'w-fit px-1 text-[10px] leading-tight whitespace-nowrap',
        thinkingEffortBadgeClass(effort)
      )}
    >
      {effort}
    </Badge>
  )
}

/**
 * 思考强度。出站 envelope 上的等级：调用方写了就用调用方的，
 * 否则是模型缺省（面板 default_effort，没有则目录缺省）。off 不显示。
 */
export function ThinkingEffortDisplay({ effort }: { effort: string | null }) {
  const { t: translate } = useTranslation('logs')

  if (!effort) return <span className='text-muted-foreground'>-</span>
  return (
    <Tooltip delayDuration={250}>
      <TooltipTrigger asChild>
        <span
          className='relative z-20 inline-flex items-center gap-1 whitespace-nowrap'
          data-slot='thinking-effort'
        >
          <ThinkingEffortBadge effort={effort} />
        </span>
      </TooltipTrigger>
      <TooltipContent className='max-w-xs space-y-1'>
        <p className='text-xs'>{translate('logs:reasoningEffortHint')}</p>
      </TooltipContent>
    </Tooltip>
  )
}

export function ModelDisplayWithRedirect({
  row,
  role,
  onRedirectClick,
}: {
  row: UsageLogRow
  role: PanelRole | undefined
  onRedirectClick: () => void
}) {
  const { t: translate } = useTranslation('logs')

  const audit = resolveModelAuditDisplay(row)
  const showResponse = role === 'super_admin'
  const model = showResponse
    ? row.originalModel || row.model
    : audit.primaryBillingModel
  const responseModel = row.actualResponseModel?.trim() || null
  const mismatch = Boolean(model && responseModel && model !== responseModel)
  return (
    <div className='flex min-w-0 flex-col'>
      <div className='flex min-w-0 items-center gap-1.5'>
        {model ? <ModelVendorIcon modelId={model} /> : null}
        <span
          className='cursor-pointer truncate hover:underline'
          onClick={(event) => {
            event.stopPropagation()
            if (model) void copyText(model)
          }}
        >
          {model || '-'}
        </span>
        {audit.hasRedirect ? (
          <Badge
            variant='outline'
            className='shrink-0 cursor-pointer border-blue-300 px-1 text-xs text-blue-700 dark:border-blue-700 dark:text-blue-300'
            onClick={(event) => {
              event.stopPropagation()
              onRedirectClick()
            }}
          >
            <ArrowRight className='h-3 w-3' />
          </Badge>
        ) : null}
      </div>
      {showResponse && mismatch ? (
        <div
          className='flex min-w-0 items-center gap-1 pl-3 text-[10px] leading-4 text-orange-600 dark:text-orange-400'
          title={translate('logs:upstreamResponseModel', {
            model: responseModel,
          })}
        >
          <span className='min-w-0 truncate'>
            ↳{' '}
            {translate('logs:upstreamResponseModel', {
              model: responseModel,
            })}
          </span>
          <Badge
            variant='outline'
            className='shrink-0 border-orange-500/40 px-1 py-0 text-[9px] leading-3 text-inherit'
          >
            {translate('logs:responseModelMismatch')}
          </Badge>
        </div>
      ) : null}
    </div>
  )
}
