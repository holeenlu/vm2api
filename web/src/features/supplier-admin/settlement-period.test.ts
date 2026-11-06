import { describe, expect, it } from 'vitest'
import { addSystemDays, exclusiveEndDate } from '@/lib/system-time'
import { settlementEditorPresets } from './model'

describe('platform statement periods are inclusive Beijing dates', () => {
  it('shows the last covered day for the stored exclusive end instant', () => {
    // 2026-11-06 00:00 Beijing time ends a statement that covers 11-05.
    expect(exclusiveEndDate('2026-11-05T16:00:00.000Z')).toBe('2026-11-05')
    expect(addSystemDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addSystemDays('2026-03-01', -1)).toBe('2026-02-28')
  })
  it('offers only finished days and continues after the last statement', () => {
    expect(settlementEditorPresets('2026-11-06', '2026-11-02')).toEqual([
      ['sinceLast', '2026-11-03', '2026-11-05'],
      ['yesterday', '2026-11-05', '2026-11-05'],
      ['7days', '2026-10-30', '2026-11-05'],
      ['30days', '2026-10-07', '2026-11-05'],
      ['lastMonth', '2026-10-01', '2026-10-31'],
    ])
    expect(
      settlementEditorPresets('2026-01-01', '2025-12-31').map(([id]) => id)
    ).not.toContain('sinceLast')
    expect(settlementEditorPresets('2026-01-01', null)[3]).toEqual([
      'lastMonth',
      '2025-12-01',
      '2025-12-31',
    ])
  })
})
