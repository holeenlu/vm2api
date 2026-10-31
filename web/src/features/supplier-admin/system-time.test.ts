import { i18n } from '@/i18n'
import { describe, expect, it } from 'vitest'
import { fmtExpiresAt } from '@/lib/format'
import {
  systemDate,
  systemDateTime,
  systemDateTimeToIso,
} from '@/lib/system-time'
import { dateRangeValueForPreset } from '@/components/date-range-picker'
import {
  dateWithClockToTimestamp,
  formatClock,
  formatDate,
  shiftDateRange,
} from '@/features/logs/filters/time-range'
import { expiryDate, expiryISO } from '@/features/proxies/proxy-lifetime'
import {
  usageQueryString,
  usageRangeForPreset,
} from '@/features/vendor/account-usage-dialog'

describe('UTC+8 business time independent of browser timezone', () => {
  const now = new Date('2026-10-31T16:30:00Z')
  it('aligns displayed timestamps, calendar presets and log filter instants', () => {
    expect(systemDate(now)).toBe('2026-11-01')
    expect(systemDateTime(now)).toBe('2026-11-01T00:30:00')
    expect(dateRangeValueForPreset('today', now).startDate).toBe('2026-11-01')
    expect(dateRangeValueForPreset('yesterday', now).startDate).toBe(
      '2026-10-31'
    )
    expect(dateWithClockToTimestamp('2026-11-01', '00:00:00')).toBe(
      Date.parse('2026-10-31T16:00:00Z')
    )
    expect(formatDate(now)).toBe('2026-11-01')
    expect(formatClock(now.getTime())).toBe('00:30:00')
    expect(fmtExpiresAt(now.getTime())).toBe(
      now.toLocaleString(i18n.resolvedLanguage, { timeZone: 'Asia/Shanghai' })
    )
    expect(
      shiftDateRange({ startDate: '2026-11-01', endDate: '2026-11-01' }, 'prev')
    ).toEqual({ startDate: '2026-10-31', endDate: '2026-10-31' })
  })
  it('round-trips editable expiry values without shifting the stored instant', () => {
    expect(systemDateTimeToIso(systemDateTime(now))).toBe(now.toISOString())
    expect(expiryDate(now.toISOString())).toBe('2026-11-01')
    expect(expiryISO('2026-11-01')).toBe('2026-11-01T15:59:59.000Z')
  })
  it('sends the fixed zone and inclusive dates for supplier quick ranges', () => {
    for (const preset of ['yesterday', 'thisMonth', 'lastMonth'] as const) {
      const selected = usageRangeForPreset(preset, now)
      const query = new URLSearchParams(usageQueryString(selected))
      expect(query.get('range')).toBe('custom')
      expect(query.get('timezone')).toBe('Asia/Shanghai')
      expect(query.get('start_date')).toBe(selected.start_date)
      expect(query.get('end_date')).toBe(selected.end_date)
    }
  })
})
