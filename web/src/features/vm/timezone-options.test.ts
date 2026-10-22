import { describe, expect, it } from 'vitest'
import { VM_TIMEZONE_CUSTOM, isPresetTimezone } from './create-options'

describe('timezone presets', () => {
  it('treats custom as a sentinel, not a real zone', () => {
    expect(isPresetTimezone('Asia/Tokyo')).toBe(true)
    expect(isPresetTimezone('UTC')).toBe(true)
    expect(isPresetTimezone(VM_TIMEZONE_CUSTOM)).toBe(false)
    expect(isPresetTimezone('Pacific/Auckland')).toBe(false)
  })
})
