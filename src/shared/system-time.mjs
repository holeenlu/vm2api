// Business dates and clocks use UTC+8, independent of the host or browser zone.
export const SYSTEM_TIMEZONE = 'Asia/Shanghai'
export const SYSTEM_TIMEZONE_LABEL = 'UTC+8'
const OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

export function systemDateTime(value = Date.now()) {
  const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value)
  return new Date(ms + OFFSET_MS).toISOString().slice(0, 19)
}

export function systemDate(value = Date.now()) {
  return systemDateTime(value).slice(0, 10)
}

export function systemDayStartMs(value = Date.now(), dayOffset = 0) {
  return Date.parse(systemDate(value) + 'T00:00:00Z') - OFFSET_MS + dayOffset * DAY_MS
}

// Offset-bearing wire timestamps remain absolute; offset-free form values use UTC+8.
export function systemDateTimeToIso(value) {
  const text = String(value)
  const date = text.slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) !== date)
    throw new RangeError('Invalid system date')
  const dateTime = /^\d{4}-\d{2}-\d{2}$/.test(text) ? text + 'T00:00:00' : text
  return new Date(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(dateTime) ? dateTime : dateTime + '+08:00').toISOString()
}

// kin.db stores every timestamp as fixed-offset UTC+8: `YYYY-MM-DDTHH:MM:SS.sss+08:00` (user decision 2026-11-07).
// The fraction keeps its digits (at least 3): with the `+` suffix, which sorts below `.` and digits, string order
// still equals time order across fraction widths (Go RFC3339Nano trims trailing zeros).
const DB_TIME_INPUT = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/
const DB_TIME_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/

/** Storage form of an instant: ms, Date, or an offset-bearing ISO string. */
export function dbTime(value = Date.now()) {
  if (typeof value === 'string') {
    // 用 match 而非 regex.exec：SQL 边界守卫按 `*db*.exec(` 取样，常量名含 DB 会被误计为 SQL 调用点
    const match = value.match(DB_TIME_INPUT)
    const seconds = match ? Date.parse(match[1] + match[3]) : Number.NaN
    if (!Number.isFinite(seconds)) throw new RangeError(`Invalid timestamp: ${value}`)
    return `${new Date(seconds + OFFSET_MS).toISOString().slice(0, 19)}.${(match[2] || '').padEnd(3, '0')}+08:00`
  }
  const ms = value instanceof Date ? value.getTime() : value
  if (!Number.isFinite(ms)) throw new RangeError(`Invalid timestamp: ${value}`)
  return new Date(ms + OFFSET_MS).toISOString().slice(0, 23) + '+08:00'
}

/** SQL parameter rewrite at the DB binding layer: whole-string ISO-Z timestamps become the storage form. */
export function dbTimeParam(value) {
  return typeof value === 'string' && value.charCodeAt(value.length - 1) === 90 && DB_TIME_Z.test(value)
    ? dbTime(value)
    : value
}
