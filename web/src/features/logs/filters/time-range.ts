/**
 * 日志页时间范围工具，移植自 hub `_utils/time-range.ts` 与日期范围选择器。
 * hub 按服务端时区换算；面板全站按浏览器本地时区展示，这里统一用本地时区。
 * 结束时间一律是「不含」的毫秒戳 = 界面上的结束秒 + 1000。
 */
import {
  addDays,
  differenceInCalendarDays,
  format,
  isValid,
  parse,
} from 'date-fns'

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

const DATE_FMT = 'yyyy-MM-dd'

export function formatDate(date: Date): string {
  return format(date, DATE_FMT)
}

/** `yyyy-MM-dd` → 本地零点；拒绝 02-30 这类越界日期。 */
export function parseDate(value: string): Date {
  return parse(value, DATE_FMT, new Date())
}

export function inclusiveEndFromExclusive(endTime: number): number {
  return Math.max(0, endTime - 1000)
}

export function formatClock(timestamp: number): string {
  return format(new Date(timestamp), 'HH:mm:ss')
}

/** `yyyy-MM-dd` + `HH:mm[:ss]` → 本地毫秒戳；非法返回 undefined。 */
export function dateWithClockToTimestamp(
  date: string,
  clock: string
): number | undefined {
  const [h = 0, m = 0, s = 0] = clock.split(':').map((part) => Number(part))
  const day = parseDate(date)
  if (!isValid(day) || formatDate(day) !== date) return undefined
  if (![h, m, s].every(Number.isFinite)) return undefined
  day.setHours(h, m, s, 0)
  return day.getTime()
}

/** 按区间天数整体平移（上一周期 / 下一周期）。 */
export function shiftDateRange(
  range: Required<DateRangeStrings>,
  direction: 'prev' | 'next'
): Required<DateRangeStrings> {
  const start = parseDate(range.startDate)
  const end = parseDate(range.endDate)
  const span = differenceInCalendarDays(end, start) + 1
  const delta = direction === 'prev' ? -span : span
  return {
    startDate: formatDate(addDays(start, delta)),
    endDate: formatDate(addDays(end, delta)),
  }
}
