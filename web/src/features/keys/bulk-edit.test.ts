import { describe, expect, it } from 'vitest'
import { bulkKeyPatch, KEY_NUMERIC_FIELDS } from './bulk-edit'

describe('bulk API key patch', () => {
  it('sends only selected fields and preserves explicit unlimited values', () => {
    expect(bulkKeyPatch({ quota_usd: '0', rpm: '25' })).toEqual({
      quota_usd: 0,
      rpm: 25,
    })
    expect(Object.keys(KEY_NUMERIC_FIELDS)).toHaveLength(7)
    expect(() => bulkKeyPatch({ quota_requests: '' })).toThrow()
    expect(() => bulkKeyPatch({ rate_limit_5h: '-1' })).toThrow()
  })
  it('clears only explicitly selected expiry/IP fields and uses UTC+8', () => {
    expect(
      bulkKeyPatch({
        expires_at: '',
        ip_whitelist: '',
        ip_blacklist: '10.0.0.1,\n::1',
      })
    ).toEqual({
      expires_at: null,
      ip_whitelist: [],
      ip_blacklist: ['10.0.0.1', '::1'],
    })
    expect(bulkKeyPatch({ expires_at: '2027-01-02T12:30' })).toEqual({
      expires_at: '2027-01-02T04:30:00.000Z',
    })
    expect(bulkKeyPatch({ group_id: '__platform__' })).toEqual({
      group_id: null,
    })
    expect(() => bulkKeyPatch({ group_id: '' })).toThrow()
  })
})
