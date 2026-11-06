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
          cooldown: '',
          target: '',
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

  it('maps the 403 group move, its target and the 429 cooldown', () => {
    expect(
      bpsBulkPatch(
        {
          ...emptyBpsBulk,
          flags: { auto_move_on_403: 'on' },
          target: '0',
          cooldown: '30',
        },
        error
      )
    ).toEqual({
      auto_move_on_403: true,
      target_group_id: 0,
      rate_limit_cooldown_seconds: 30,
    })
    expect(
      bpsBulkPatch(
        { ...emptyBpsBulk, flags: { auto_move_on_403: 'off' } },
        error
      )
    ).toEqual({ auto_move_on_403: false })
    expect(() =>
      bpsBulkPatch(
        { ...emptyBpsBulk, flags: { auto_move_on_403: 'on' } },
        error
      )
    ).toThrow('codexBpsBulkTargetRequired')
    expect(() =>
      bpsBulkPatch({ ...emptyBpsBulk, cooldown: '601' }, error)
    ).toThrow('codexBpsRateLimitCooldown')
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
