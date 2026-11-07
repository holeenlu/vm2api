import { describe, expect, it } from 'vitest'
import {
  CODEX_WEIGHT_DEFAULT,
  CODEX_WEIGHT_STEPS,
  codexWeightOf,
  codexWeightPatch,
  withCurrent,
} from './scheduling-steps'

describe('Codex selection weight (#772)', () => {
  it('reads the slot weight, falling back to the default 1', () => {
    expect(codexWeightOf({})).toBe(CODEX_WEIGHT_DEFAULT)
    expect(codexWeightOf({ weight: null })).toBe(1)
    expect(codexWeightOf({ weight: 5 })).toBe(5)
    // Out of the backend range or not an integer: shown as the default.
    expect(codexWeightOf({ weight: 0 })).toBe(1)
    expect(codexWeightOf({ weight: 101 })).toBe(1)
    expect(codexWeightOf({ weight: 2.5 })).toBe(1)
  })

  it('patches only a change; back to default sends null', () => {
    expect(codexWeightPatch(1, { own: true, value: 5 })).toBe(5)
    expect(codexWeightPatch(5, { own: true, value: 5 })).toBeUndefined()
    expect(codexWeightPatch(5, { own: false, value: 5 })).toBeNull()
    expect(codexWeightPatch(5, { own: true, value: 1 })).toBeNull()
    expect(codexWeightPatch(1, { own: false, value: 7 })).toBeUndefined()
  })

  it('offers steps inside the backend 1–100 range and keeps an off-step value', () => {
    for (const [value] of CODEX_WEIGHT_STEPS) {
      expect(value).toBeGreaterThanOrEqual(1)
      expect(value).toBeLessThanOrEqual(100)
    }
    expect(withCurrent(CODEX_WEIGHT_STEPS, 7).map(([v]) => v)).toContain(7)
  })
})
