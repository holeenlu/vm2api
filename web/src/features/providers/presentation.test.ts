import type { TFunction } from 'i18next'
import { describe, expect, it, vi, afterEach } from 'vitest'
import { isActive, resetTime, statusLabel } from './presentation'
import type { ProviderRow } from './queries'

const t = ((key: string, values?: object) =>
  JSON.stringify([key, values])) as TFunction
const row: ProviderRow = {
  id: 'account',
  name: 'Account',
  provider_type: 'anthropic',
  status: 'active',
  has_token: true,
  schedulable: true,
}
afterEach(() => vi.useRealTimers())
describe('supplier account presentation', () => {
  it('formats epoch seconds, milliseconds and ISO consistently without leaking timestamps', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-29T00:00:00Z'))
    const time = Date.now() + 90 * 60_000
    const expected = JSON.stringify([
      'providers:hoursMinutesLater',
      { hours: 1, minutes: 30 },
    ])
    for (const value of [
      time / 1000,
      String(time / 1000),
      time,
      new Date(time).toISOString(),
    ]) {
      expect(resetTime(value, t)).toBe(expected)
    }
    expect(resetTime('invalid', t)).toBe('—')
    expect(resetTime(null, t)).toBe('—')
    expect(resetTime(0, t)).toBe('—')
    expect(resetTime(Date.now() - 1000, t)).toContain('recoveringSoon')
  })
  it('excludes paused scheduling from active count and labels authorization first', () => {
    expect(isActive(row)).toBe(true)
    for (const change of [
      { status: 'paused' },
      { has_token: false },
      { schedulable: false },
      { schedule_disabled_reason: 'manual' },
    ]) {
      expect(isActive({ ...row, ...change })).toBe(false)
    }
    expect(statusLabel({ ...row, schedulable: false }, t)).toContain(
      'schedulePaused'
    )
    expect(
      statusLabel({ ...row, has_token: false, schedulable: false }, t)
    ).toContain('waitingAuth')
  })
})
