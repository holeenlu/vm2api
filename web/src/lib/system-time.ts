import { systemDate } from '../../../src/shared/system-time.mjs'

export {
  SYSTEM_TIMEZONE,
  SYSTEM_TIMEZONE_LABEL,
  systemDate,
  systemDateTime,
  systemDateTimeToIso,
  systemDayStartMs,
} from '../../../src/shared/system-time.mjs'

// Calendar widgets use Date as a wall-date container, not as an instant.
export function systemCalendarDate(value: Date | number = Date.now()) {
  const [year, month, day] = systemDate(value).split('-').map(Number)
  return new Date(year, month - 1, day)
}

// Statement periods store an exclusive end instant (next day 00:00 system time);
// show the last covered calendar day instead.
export function exclusiveEndDate(value: string | number) {
  return systemDate(new Date(value).getTime() - 1)
}

export function addSystemDays(date: string, days: number) {
  const value = new Date(date + 'T00:00:00Z')
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}
