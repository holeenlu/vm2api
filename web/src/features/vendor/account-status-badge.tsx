import type { ReactNode } from 'react'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { accountStatusView, type Resource } from './portal-model'

export function AccountStatusBadge({
  resource,
  children,
}: {
  resource: Pick<Resource, 'status' | 'telemetry'>
  children?: ReactNode
}) {
  const status = accountStatusView(resource)
  const badge = (
    <span
      className={
        'rounded-full px-2 py-0.5 text-[11px] ' +
        (status.restricted
          ? 'bg-[var(--status-caution-bg)] text-[var(--status-caution)]'
          : status.schedulable
            ? 'bg-[var(--status-ok-bg)] text-[var(--status-ok)]'
            : status.unavailable
              ? 'bg-destructive/10 text-destructive'
              : 'bg-muted text-muted-foreground')
      }
      title={status.title || undefined}
    >
      {status.primary}
    </span>
  )
  return (
    <>
      <div className='flex items-center gap-2'>
        {children}
        {status.title ? (
          <Tooltip>
            <TooltipTrigger asChild>{badge}</TooltipTrigger>
            <TooltipContent className='max-w-sm whitespace-normal'>
              {status.title}
            </TooltipContent>
          </Tooltip>
        ) : (
          badge
        )}
      </div>
      {status.credential && !status.title && (
        <span className='mt-1 inline-flex rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] text-destructive'>
          {status.credential}
        </span>
      )}
    </>
  )
}
