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
