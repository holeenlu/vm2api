import { describe, expect, it } from 'vitest'
import { dateWithClockToTimestamp, shiftDateRange } from './time-range'

describe('time range helpers', () => {
  it('shifts date ranges by span', () => {
    expect(
      shiftDateRange({ startDate: '2026-01-08', endDate: '2026-01-14' }, 'prev')
    ).toEqual({ startDate: '2026-01-01', endDate: '2026-01-07' })
  })

  it('rejects impossible calendar dates', () => {
    expect(dateWithClockToTimestamp('2026-02-30', '00:00:00')).toBeUndefined()
  })
})
