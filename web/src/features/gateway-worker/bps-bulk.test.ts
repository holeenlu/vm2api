import { describe, expect, it } from 'vitest'
import { bpsBulkPatch, emptyBpsBulk } from './bps-bulk'

const error = (key: string) => new Error(key)

describe('bpsBulkPatch', () => {
  it('returns null when nothing changes', () => {
    expect(bpsBulkPatch(emptyBpsBulk, error)).toBeNull()
  })

  it('maps flags, model operation and interval', () => {
    expect(
      bpsBulkPatch(
        {
          flags: { enabled: 'on', ignore_encrypted_content: 'off' },
          modelMode: 'add',
          models: 'gpt-5.5, gpt-5.4 gpt-5.5',
          interval: '30',
        },
        error
      )
    ).toEqual({
      enabled: true,
      ignore_encrypted_content: false,
      models: { operation: 'add', ids: ['gpt-5.5', 'gpt-5.4'] },
      recovery_interval_minutes: 30,
    })
  })

  it('rejects wildcards, empty add lists and bad intervals', () => {
    expect(() =>
      bpsBulkPatch(
        { ...emptyBpsBulk, modelMode: 'add', models: 'gpt-*' },
        error
      )
    ).toThrow('codexBpsBulkModelsInvalid')
    expect(() =>
      bpsBulkPatch({ ...emptyBpsBulk, modelMode: 'remove' }, error)
    ).toThrow('codexBpsBulkModelsRequired')
    expect(() =>
      bpsBulkPatch({ ...emptyBpsBulk, interval: '0' }, error)
    ).toThrow('codexBpsRecoveryInterval')
    expect(
      bpsBulkPatch({ ...emptyBpsBulk, modelMode: 'replace' }, error)
    ).toEqual({ models: { operation: 'replace', ids: [] } })
  })
})
