import { t, i18n } from '@/i18n'
import type { StatsRange, StatsResolution } from '@/types/panel-statistics'

/** 与 hub bento 图表同一套 10 色，序号 = 序列在 `series` 中的位置（与筛选无关，颜色稳定）。 */
export const SERIES_PALETTE = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
  'hsl(15, 85%, 60%)',
  'hsl(195, 85%, 60%)',
  'hsl(285, 85%, 60%)',
  'hsl(135, 85%, 50%)',
  'hsl(45, 85%, 55%)',
] as const

export function seriesColor(index: number): string {
  const size = SERIES_PALETTE.length
  return SERIES_PALETTE[((index % size) + size) % size]
}

export const STATS_RANGES: { id: StatsRange; label: string }[] = [
  {
    id: 'today',
    get label() {
      return t('statistics:rangeToday')
    },
  },
  {
    id: '7days',
    get label() {
      return t('statistics:rangeWeek')
    },
  },
  {
    id: '30days',
    get label() {
      return t('statistics:rangeMonth')
    },
  },
  {
    id: 'thisMonth',
    get label() {
      return t('statistics:thisMonth')
    },
  },
]

/** 浏览器 IANA 时区；取不到时退回 UTC，与后端默认一致。 */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function zonedParts(iso: string, timeZone: string) {
  let fmt = formatters.get(timeZone)
  if (!fmt) {
    // h23：部分引擎在 hour12:false 下把午夜输出成 24。
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
    formatters.set(timeZone, fmt)
  }
  const parts: Record<string, string> = {}
  for (const part of fmt.formatToParts(new Date(iso))) {
    parts[part.type] = part.value
  }
  return {
    year: parts.year,
    month: Number(parts.month),
    day: Number(parts.day),
    time: `${parts.hour}:${parts.minute}`,
  }
}

/** 横轴刻度：小时桶 `HH:mm`，天桶 `M/d`，均按 `timeZone` 解释桶起点。 */
export function formatBucketTick(
  iso: string,
  resolution: StatsResolution,
  timeZone: string
): string {
  if (!iso || Number.isNaN(Date.parse(iso))) return ''
  const p = zonedParts(iso, timeZone)
  return resolution === 'hour' ? p.time : `${p.month}/${p.day}`
}

/** Tooltip 表头：小时桶 `MMMM d HH:mm`，天桶 `yyyy MMMM d`（当前界面语言）。 */
export function formatBucketTitle(
  iso: string,
  resolution: StatsResolution,
  timeZone: string
): string {
  if (!iso || Number.isNaN(Date.parse(iso))) return ''
  return new Intl.DateTimeFormat(
    i18n.resolvedLanguage || i18n.language || 'zh-CN',
    {
      timeZone,
      ...(resolution === 'day' ? { year: 'numeric' as const } : {}),
      month: 'long',
      day: 'numeric',
      ...(resolution === 'hour'
        ? {
            hour: '2-digit' as const,
            minute: '2-digit' as const,
            hourCycle: 'h23' as const,
          }
        : {}),
    }
  ).format(new Date(iso))
}

/**
 * hub `calcPercentageChange`：较昨日同期的整数百分比。
 * 昨日为 0 时没有基数，今日有量记 +100，否则 0；任一侧缺失返回 null（不显示徽标）。
 */
export function percentChange(
  current: number | null | undefined,
  previous: number | null | undefined
): number | null {
  if (current == null || previous == null) return null
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null
  if (previous === 0) return current > 0 ? 100 : 0
  return Math.round(((current - previous) / previous) * 100)
}

export type SessionDisplay = {
  label: 'FAIL' | 'LIVE' | 'IDLE'
  text: string
  tooltip: string
  color: string
  pulse: boolean
}

const LIVE_WINDOW_MS = 60_000

/**
 * hub `getSessionDisplayStatus` 的 tapmodels 版。tapmodels 只在请求完成时落库，没有「进行中 / 初始化」，
 * 所以按最后一次请求区分：失败 → FAIL；1 分钟内刚完成 → LIVE；其余 IDLE。
 */
export function sessionDisplay(
  session: { lastStatus: number | null; lastAt: string },
  now: number = Date.now()
): SessionDisplay {
  if (session.lastStatus != null && session.lastStatus >= 400) {
    return {
      label: 'FAIL',
      text: t('statistics:sessionFailLabel'),
      tooltip: t('statistics:sessionFailed', { status: session.lastStatus }),
      color: 'text-rose-500 dark:text-rose-400',
      pulse: true,
    }
  }
  const last = Date.parse(session.lastAt)
  if (Number.isFinite(last) && now - last <= LIVE_WINDOW_MS) {
    return {
      label: 'LIVE',
      text: t('statistics:sessionLiveLabel'),
      tooltip: t('statistics:sessionRecent'),
      color: 'text-emerald-500 dark:text-emerald-400',
      pulse: true,
    }
  }
  return {
    label: 'IDLE',
    text: t('statistics:sessionIdleLabel'),
    tooltip: t('statistics:sessionIdle'),
    color: 'text-muted-foreground/50',
    pulse: false,
  }
}
