import { describe, expect, it } from 'vitest'
import { normalizeUsageLogsBatchResult } from './queries'

describe('usage log query response normalization', () => {
  it('accepts the current batch shape', () => {
    expect(
      normalizeUsageLogsBatchResult({
        logs: [{ id: 'log-1' }],
        hasMore: true,
        nextCursor: { createdAt: '2026-10-31T00:00:00.000Z', id: 'log-1' },
      })
    ).toEqual({
      logs: [{ id: 'log-1' }],
      hasMore: true,
      nextCursor: { createdAt: '2026-10-31T00:00:00.000Z', id: 'log-1' },
    })
  })

  it('turns legacy or incomplete responses into a safe empty page', () => {
    expect(
      normalizeUsageLogsBatchResult({
        data: { items: [{ id: 'legacy-1' }], has_more: false },
      })
    ).toEqual({ logs: [{ id: 'legacy-1' }], hasMore: false, nextCursor: null })
    expect(normalizeUsageLogsBatchResult(null)).toEqual({
      logs: [],
      hasMore: false,
      nextCursor: null,
    })
  })
})
