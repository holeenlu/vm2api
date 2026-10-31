import { describe, expect, it } from 'vitest'
import { usageQueryString, usageRangeForPreset } from './account-usage-dialog'

describe('vendor usage date ranges', () => {
  const now = new Date(2026, 9, 31, 12, 0, 0)

  it('uses local calendar days for the quick ranges', () => {
    expect(usageRangeForPreset('today', now)).toEqual({
      range: 'today',
      start_date: '2026-10-31',
      end_date: '2026-10-31',
    })
    expect(usageRangeForPreset('yesterday', now)).toEqual({
      range: 'yesterday',
      start_date: '2026-10-30',
      end_date: '2026-10-30',
    })
    expect(usageRangeForPreset('7days', now)).toEqual({
      range: '7days',
      start_date: '2026-10-25',
      end_date: '2026-10-31',
    })
  })

  it('uses full calendar boundaries for this and last month', () => {
    expect(usageRangeForPreset('thisMonth', now)).toMatchObject({
      start_date: '2026-10-01',
      end_date: '2026-10-31',
    })
    expect(usageRangeForPreset('lastMonth', now)).toMatchObject({
      start_date: '2026-09-01',
      end_date: '2026-09-30',
    })
  })

  it('keeps custom ranges and the browser timezone in the API query', () => {
    const query = new URLSearchParams(
      usageQueryString({
        range: 'custom',
        start_date: '2026-10-13',
        end_date: '2026-10-31',
      })
    )
    expect(query.get('range')).toBe('custom')
    expect(query.get('start_date')).toBe('2026-10-13')
    expect(query.get('end_date')).toBe('2026-10-31')
    expect(query.get('timezone')).toBeTruthy()
  })
})
