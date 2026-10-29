import { i18n } from '@/i18n'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  TIMEZONE_SOURCE_LABELS,
  validTimezone,
  zoneNowLabel,
} from '@/lib/timezone'

// Keep the existing Chinese UI assertions independent of the host locale.
beforeEach(async () => {
  await i18n.changeLanguage('zh-CN')
})

describe('validTimezone', () => {
  it('keeps named IANA zones and drops offsets', () => {
    expect(validTimezone(' asia/tokyo ')).toBe('Asia/Tokyo')
    expect(validTimezone('UTC')).toBe('UTC')
    expect(validTimezone('+09:00')).toBe('')
    expect(validTimezone('Nope/Zone')).toBe('')
  })

  it('renders a local clock for a valid zone', () => {
    expect(zoneNowLabel('UTC', Date.parse('2026-01-15T12:00:00Z'))).toMatch(
      /15/
    )
    expect(zoneNowLabel('Nope/Zone')).toBe('')
  })
})

describe('timezone presets', () => {
  it('labels the three timezone sources', () => {
    expect(TIMEZONE_SOURCE_LABELS.manual).toBe('手动')
    expect(TIMEZONE_SOURCE_LABELS.proxy_geo).toBe('跟随代理')
    expect(TIMEZONE_SOURCE_LABELS.auto).toBe('自动')
  })
})
