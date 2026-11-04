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
