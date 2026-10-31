import { expect, test, vi } from 'vitest'
import { idempotencyKey } from './idempotency-key'

test('HTTP contexts without randomUUID still produce distinct retry identifiers', () => {
  const getRandomValues = crypto.getRandomValues.bind(crypto)
  vi.stubGlobal('crypto', { getRandomValues })
  try {
    const first = idempotencyKey()
    expect(first).toMatch(/^[a-f0-9]{32}$/)
    expect(idempotencyKey()).not.toBe(first)
  } finally {
    vi.unstubAllGlobals()
  }
})
