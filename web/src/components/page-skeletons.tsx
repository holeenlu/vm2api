import { t } from '@/i18n'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/skeleton'

/**
 * 骨架屏原语。移植自 claude-code-hub `components/loading/page-skeletons.tsx`
 * （零 Next/i18n 依赖，只用 Skeleton + cn）。
 *
 * 用途：`QueryGate` 的 `skeleton` 参数。默认那两块灰条（h-24 + h-64）与
 * 任何真实页面结构都不匹配，会造成「白屏 → 灰条 → 内容」三段跳；
 * 各页应传入与自身结构近似的骨架。
 */

export function LoadingState({
  label = t('common:loading'),
  className,
}: {
  label?: string
  className?: string
}) {
  useTranslation('common')
  return (
    <div
      role='status'
      aria-live='polite'
      aria-busy='true'
      className={cn('text-xs text-muted-foreground', className)}
    >
      {label}
    </div>
  )
}

export function PageHeaderSkeleton({
  titleWidth = 'w-48',
  descriptionWidth = 'w-72',
  showDescription = true,
  className,
}: {
  titleWidth?: string
  descriptionWidth?: string
  showDescription?: boolean
  className?: string
}) {
  return (
    <div className={cn('space-y-2', className)}>
      <Skeleton className={cn('h-7', titleWidth)} />
      {showDescription ? (
        <Skeleton className={cn('h-4', descriptionWidth)} />
      ) : null}
    </div>
  )
}

export function SectionSkeleton({
  titleWidth = 'w-32',
  descriptionWidth = 'w-56',
  showDescription = true,
  showActions = false,
  rows = 3,
  className,
  body,
}: {
  titleWidth?: string
  descriptionWidth?: string
  showDescription?: boolean
  showActions?: boolean
  rows?: number
  className?: string
  body?: React.ReactNode
}) {
  return (
    <section
      className={cn(
        'space-y-4 rounded-xl border border-border bg-card p-5 text-card-foreground shadow-sm',
        className
      )}
    >
      <div className='flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between'>
        <div className='space-y-2'>
          <Skeleton className={cn('h-5', titleWidth)} />
          {showDescription ? (
            <Skeleton className={cn('h-4', descriptionWidth)} />
          ) : null}
        </div>
        {showActions ? (
          <div className='flex flex-wrap gap-2'>
            <Skeleton className='h-9 w-28' />
            <Skeleton className='h-9 w-24' />
          </div>
        ) : null}
      </div>
      {body ?? (
        <div className='space-y-3'>
          {Array.from({ length: rows }).map((_, index) => (
            <Skeleton key={`section-row-${index}`} className='h-5 w-full' />
          ))}
        </div>
      )}
    </section>
  )
}

/** 表格骨架。kin 的数据密集表格是 flex 行，这里用 grid 近似列宽即可。 */
export function TableSkeleton({
  rows = 6,
  columns = 4,
  rowHeightClassName = 'h-5',
}: {
  rows?: number
  columns?: number
  rowHeightClassName?: string
}) {
  const columnTemplate = {
    gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
  }
  return (
    <div className='space-y-3'>
      <div className='grid gap-4' style={columnTemplate}>
        {Array.from({ length: columns }).map((_, index) => (
          <Skeleton key={`table-head-${index}`} className='h-4 w-full' />
        ))}
      </div>
      <div className='space-y-2'>
        {Array.from({ length: rows }).map((_, rowIndex) => (
          <div
            key={`table-row-${rowIndex}`}
            className='grid gap-4'
            style={columnTemplate}
          >
            {Array.from({ length: columns }).map((_, colIndex) => (
              <Skeleton
                key={`table-cell-${rowIndex}-${colIndex}`}
                className={cn(rowHeightClassName, 'w-full')}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

export function CardGridSkeleton({
  cards = 4,
  className,
}: {
  cards?: number
  className?: string
}) {
  return (
    <div className={cn('grid gap-3 sm:grid-cols-2 xl:grid-cols-4', className)}>
      {Array.from({ length: cards }).map((_, index) => (
        <div
          key={`card-skeleton-${index}`}
          className='space-y-3 rounded-lg border bg-card p-4'
        >
          <Skeleton className='h-4 w-24' />
          <Skeleton className='h-8 w-20' />
          <Skeleton className='h-3 w-16' />
        </div>
      ))}
    </div>
  )
}

export function ListSkeleton({
  rows = 5,
  className,
}: {
  rows?: number
  className?: string
}) {
  return (
    <div className={cn('space-y-2', className)}>
      {Array.from({ length: rows }).map((_, index) => (
        <Skeleton key={`list-row-${index}`} className='h-5 w-full' />
      ))}
    </div>
  )
}
