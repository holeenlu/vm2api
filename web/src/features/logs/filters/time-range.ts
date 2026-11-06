import {
  systemDate,
  systemDateTime,
  systemDateTimeToIso,
} from '@/lib/system-time'

// Report filters use UTC+8; the API end bound remains exclusive.
export type QuickPeriod =
  'today' | 'yesterday' | 'last7days' | 'last30days' | 'thisMonth' | 'lastMonth'
export type DateRangeStrings = { startDate?: string; endDate?: string }

export const QUICK_PERIODS: QuickPeriod[] = [
  'today',
  'yesterday',
  'last7days',
  'last30days',
  'thisMonth',
  'lastMonth',
]

export function formatDate(date: Date): string {
  return systemDate(date)
}

/** `yyyy-MM-dd` → UTC+8 零点；拒绝 02-30 这类越界日期。 */
export function parseDate(value: string): Date {
  try {
    return new Date(systemDateTimeToIso(value))
  } catch {
    return new Date(NaN)
  }
}

export function inclusiveEndFromExclusive(endTime: number): number {
  return Math.max(0, endTime - 1000)
}

export function formatClock(timestamp: number): string {
  return systemDateTime(timestamp).slice(11)
}

/** `yyyy-MM-dd` + `HH:mm[:ss]` → UTC+8 毫秒戳；非法返回 undefined。 */
export function dateWithClockToTimestamp(
  date: string,
  clock: string
): number | undefined {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !/^\d{2}:\d{2}(?::\d{2})?$/.test(clock)
  )
    return undefined
  const [h, m, sec = 0] = clock.split(':').map(Number)
  if (h > 23 || m > 59 || sec > 59) return undefined
  try {
    const ms = Date.parse(systemDateTimeToIso(date + 'T' + clock))
    return systemDate(ms) === date ? ms : undefined
  } catch {
    return undefined
  }
}

/** 按区间天数整体平移（上一周期 / 下一周期）。 */
export function shiftDateRange(
  range: Required<DateRangeStrings>,
  direction: 'prev' | 'next'
): Required<DateRangeStrings> {
  const start = parseDate(range.startDate)
  const end = parseDate(range.endDate)
  const span = Math.round((end.getTime() - start.getTime()) / 86400000) + 1
  const delta = direction === 'prev' ? -span : span
  return {
    startDate: systemDate(start.getTime() + delta * 86400000),
    endDate: systemDate(end.getTime() + delta * 86400000),
  }
}
