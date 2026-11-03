import { describe, expect, it } from 'vitest'
import { logCostKnown, logStatusKind } from './model'

describe('logs feature model', () => {
  it('keeps status and unknown cost semantics explicit', () => {
    expect(logStatusKind({ statusCode: 204 })).toBe('success')
    expect(logStatusKind({ statusCode: 429 })).toBe('client_error')
    expect(logStatusKind({ statusCode: null })).toBe('unknown')
    expect(logCostKnown({ costUsd: null })).toBe(false)
    expect(logCostKnown({ costUsd: 0 })).toBe(true)
  })
})
