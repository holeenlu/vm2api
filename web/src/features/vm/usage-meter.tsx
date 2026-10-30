import { t } from '@/i18n'
import type { Vm } from '@/types/panel-vm'
import { fableState, weeklySplitInfo } from '@/lib/fable-status'
import { cn } from '@/lib/utils'
import { claudeTier } from '@/lib/vm-status'

/** 用量条统一朝一个方向：值越高越危险。四档对应状态轴。 */
export type RiskLevel = 'ok' | 'caution' | 'warn' | 'bad'

export function riskLevel(value: number): RiskLevel {
  if (value >= 100) return 'bad'
  if (value >= 85) return 'warn'
  if (value >= 70) return 'caution'
  return 'ok'
}

/** 非文本图形用 solid 变体（3:1 即可），比文字版更亮更艳。 */
export const RISK_SOLID: Record<RiskLevel, string> = {
  ok: 'var(--status-ok-solid)',
  caution: 'var(--status-caution-solid)',
  warn: 'var(--status-warn-solid)',
  bad: 'var(--status-bad-solid)',
}

const RISK_TEXT: Record<RiskLevel, string> = {
  ok: 'text-[color:var(--status-ok)]',
  caution: 'text-[color:var(--status-caution)]',
  warn: 'text-[color:var(--status-warn)]',
  bad: 'text-[color:var(--status-bad)]',
}

export function riskFg(value: number): string {
  return RISK_TEXT[riskLevel(value)]
}

/**
 * 用量标尺。
 *
 * 填充走同色相的 42%→100% 渐变：尾端最亮，视线自然停在「烧到哪了」的刻度上，
 * 而不是在一条均匀色块的中间游移。
 *
 * `ticks` 在 70 / 85 两处画发丝刻线 —— 这两个数就是 caution / warn 的换档点。
 * 没有刻线时「73%」要靠记阈值才能判危，有刻线时越没越线一眼可见。
 *
 * 满档（≥100%）额外叠 45° 斜纹：封顶是状态而不是程度，单靠红色在灰度截图
 * 和色觉差异下会和 warn 混成一档，纹理让它独立成立。
 */
export function UsageMeter({
  value,
  size = 'md',
  ticks = size === 'md',
  className,
}: {
  /** 已用百分比（0–100，越高越危险）。 */
  value: number
  size?: 'sm' | 'md'
  ticks?: boolean
  className?: string
}) {
  const level = riskLevel(value)
  const solid = RISK_SOLID[level]
  // 非零但极小的值给 1.5% 底宽，否则 1% 的条渲染成看不见的一根线，
  // 和真正的 0% 无法区分。
  const width = value > 0 ? Math.min(100, Math.max(1.5, value)) : 0
  return (
    <div
      role='meter'
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value)}
      className={cn(
        'relative w-full overflow-hidden rounded-full track-recessed',
        size === 'sm' ? 'h-[5px]' : 'h-2',
        className
      )}
    >
      <div
        className='absolute inset-y-0 left-0 rounded-full motion-safe:transition-[width] motion-safe:duration-500 motion-safe:ease-[cubic-bezier(0.16,1,0.3,1)]'
        style={{
          width: `${width}%`,
          backgroundImage: `linear-gradient(90deg, color-mix(in oklch, ${solid} 42%, transparent), ${solid})`,
        }}
      >
        {level === 'bad' ? (
          <span className='absolute inset-0 meter-capped' aria-hidden='true' />
        ) : null}
      </div>
      {ticks ? (
        <>
          <span
            className='absolute inset-y-0 left-[70%] w-px bg-foreground/25'
            aria-hidden='true'
          />
          <span
            className='absolute inset-y-0 left-[85%] w-px bg-foreground/25'
            aria-hidden='true'
          />
        </>
      ) : null}
    </div>
  )
}

export type FableRow =
  { kind: 'bar'; pct: number } | { kind: 'note'; text: string }

/**
 * Max 账号的 Fable 额度。Pro 没有这个窗口，返回 null 时不占位。
 *
 * 「拒 / 满」这些态没有百分比，此时返回 `note` 走文案而不是画满格条——
 * 满格红条在一个 5h/7d 都是 0% 的号上会被误读成「烧满了」，
 * 而实际含义是「这个号根本用不了 Fable」。
 */
export function fableRow(vm: Vm): FableRow | null {
  const tier = claudeTier(vm)
  if (tier.key !== 'max') return null
  const limit = weeklySplitInfo(vm)
  if (limit?.blocked)
    return {
      kind: 'note',
      text: t('lib:fable.usageLimitReached', {
        limit: Math.round(limit.share * 1000) / 10,
      }),
    }
  const st = fableState(vm, tier.key)
  if (st.usedPct != null) return { kind: 'bar', pct: st.usedPct }
  if (st.tone.key === 'none') return null
  return { kind: 'note', text: st.tone.text }
}
