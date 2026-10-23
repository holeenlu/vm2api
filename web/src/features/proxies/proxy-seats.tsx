import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

/**
 * 席位格：一条代理的每个绑定位画成一格，已绑的按代理健康着色。
 *
 * 数字「3/5」回答多少，格子回答满不满 —— 运维扫一眼列表就能看出哪条还能塞槽位，
 * 不用在脑子里做减法。格子铺满容器宽度：上限 ≤10 一行，≤20 两行，再多格子会
 * 细到分不清，改成连续填充的量条。
 */
export function SeatCells({
  used,
  limit,
  color,
  className,
}: {
  used: number
  limit: number
  /** 已绑格的填充色（CSS color）。 */
  color: string
  className?: string
}) {
  useTranslation('proxies')

  const fill = Math.min(used, limit)
  if (limit > 20) {
    return (
      <span
        aria-hidden='true'
        className={cn(
          'relative block h-2 overflow-hidden rounded-[3px] track-recessed',
          className
        )}
      >
        <span
          className='absolute inset-y-0 left-0 rounded-[3px] motion-safe:transition-[width] motion-safe:duration-500'
          style={{
            width: `${(fill / limit) * 100}%`,
            backgroundColor: color,
          }}
        />
      </span>
    )
  }
  const rows = limit > 10 ? 2 : 1
  const cols = Math.ceil(limit / rows)
  return (
    <span
      aria-hidden='true'
      className={cn('grid gap-[2px]', className)}
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
    >
      {Array.from({ length: limit }).map((_, i) => (
        <span
          key={i}
          className={cn(
            'rounded-[2px] motion-safe:transition-colors motion-safe:duration-300',
            rows === 2 ? 'h-[7px]' : 'h-4',
            i < fill ? null : 'track-recessed'
          )}
          style={i < fill ? { backgroundColor: color } : undefined}
        />
      ))}
    </span>
  )
}

/**
 * 大号计数：已绑数突出，上限退后。已绑超过上限（调低上限后网关不踢已绑槽位）
 * 走警告色，不截断。
 */
export function SeatCount({
  used,
  limit,
  className,
}: {
  used: number
  limit: number
  className?: string
}) {
  const { t: translate } = useTranslation('proxies')

  const over = used > limit
  const full = used >= limit
  return (
    <span
      className={cn(
        'inline-flex items-baseline gap-px leading-none tabular-nums',
        className
      )}
    >
      <span
        className={cn(
          'text-xl font-[620] tracking-[-0.03em]',
          over
            ? 'text-[color:var(--status-warn)]'
            : used === 0 && 'text-muted-foreground'
        )}
      >
        {used}
      </span>
      <span className='text-xs text-muted-foreground'>/{limit}</span>
      {full ? (
        <span className='ms-1 text-[10px] font-medium text-muted-foreground'>
          {over
            ? translate('proxies:overflow')
            : translate('proxies:fullShort')}
        </span>
      ) : null}
    </span>
  )
}
