import { describe, expect, it } from 'vitest'
import { supplierUsagePreset, supplierUsageQueryString } from './usage-range'

describe('supplier operations usage calendar ranges', () => {
  const now = new Date('2026-10-31T12:34:56.000Z')
  const query = (start: string, end: string, at = now) =>
    new URLSearchParams(
      supplierUsageQueryString(
        new URLSearchParams({
          vendor_id: 'all',
          start_date: start,
          end_date: end,
        }).toString(),
        at
      )
    )

  it('lets the server resolve the cutoff for today and ranges ending today', () => {
    for (const preset of ['today', '7days', '30days', 'thisMonth'] as const) {
      const dates = supplierUsagePreset(preset, now)
      const params = query(dates.startDate, dates.endDate)
      expect(params.get('vendor_id')).toBe('all')
      expect(params.get('start_date')).toBe(
        new Date(dates.startDate + 'T00:00:00+08:00').toISOString()
      )
      expect(params.has('end_date')).toBe(false)
    }
  })

  it('includes the final day of yesterday, last month and custom selections', () => {
    expect(query('2026-10-30', '2026-10-30').get('end_date')).toBe(
      '2026-10-30T16:00:00.000Z'
    )
    expect(query('2026-09-01', '2026-09-30').get('end_date')).toBe(
      '2026-09-30T16:00:00.000Z'
    )
    expect(query('2026-02-01', '2026-02-28').get('end_date')).toBe(
      '2026-02-28T16:00:00.000Z'
    )
    expect(query('2024-02-29', '2024-02-29').get('end_date')).toBe(
      '2024-02-29T16:00:00.000Z'
    )
    expect(query('2025-12-31', '2025-12-31').get('end_date')).toBe(
      '2025-12-31T16:00:00.000Z'
    )
  })

  it('uses UTC+8 dates even while UTC is still on the previous day', () => {
    const at = new Date('2026-11-01T00:30:00+08:00')
    expect(supplierUsagePreset('today', at)).toEqual({
      startDate: '2026-11-01',
      endDate: '2026-11-01',
    })
    expect(supplierUsagePreset('7days', at)).toEqual({
      startDate: '2026-10-26',
      endDate: '2026-11-01',
    })
  })

  it('recomputes a fixed selected day after midnight instead of including the following day', () => {
    expect(query('2026-10-31', '2026-10-31').has('end_date')).toBe(false)
    expect(
      query('2026-10-31', '2026-10-31', new Date('2026-11-01T00:01:00Z')).get(
        'end_date'
      )
    ).toBe('2026-10-31T16:00:00.000Z')
  })
})
