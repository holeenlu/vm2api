import { describe, expect, it } from 'vitest'
import { checkIsActive } from './nav-group'

describe('sidebar active scope', () => {
  const operations = { title: 'Usage', url: '/logs' }
  const personal = { title: 'Usage', url: '/logs?scope=mine' }
  it('selects only the operations link with ordinary filters', () => {
    expect(checkIsActive('/logs?model=test', operations)).toBe(true)
    expect(checkIsActive('/logs?model=test', personal)).toBe(false)
  })
  it('selects only the personal link regardless of query ordering and filters', () => {
    expect(checkIsActive('/logs?model=test&scope=mine', personal)).toBe(true)
    expect(checkIsActive('/logs?scope=mine&model=test', operations)).toBe(false)
    expect(checkIsActive('/billing', personal)).toBe(false)
  })
})
