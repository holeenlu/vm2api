import { describe, expect, it } from 'vitest'
import {
  gatewayAccountAsVm,
  usageModelRows,
  type GatewayAccount,
} from './accounts-model'

const account: GatewayAccount = {
  id: 'acc-1',
  name: 'Team A',
  vendor_id: null,
  status: 'active',
  config: { email: 'a@example.test', group_ids: [3], weight: 40 },
  runtime_account_id: 'runtime-internal-1',
  credential_revision: 2,
  projection_status: 'synced',
}

describe('gatewayAccountAsVm', () => {
  it('marks the row as a Gateway runtime and maps weight to the priority level', () => {
    const vm = gatewayAccountAsVm(account, new Map([[3, 'Codex']]))
    expect(vm.runtime_type).toBe('gateway')
    expect(vm.schedule_level).toBe(40)
    expect(vm.schedule_level_mode).toBe('manual')
    expect(vm.groups).toEqual([{ id: 3, name: 'Codex', status: 'active' }])
  })

  it('falls back to the Worker default weight of 1', () => {
    const vm = gatewayAccountAsVm(
      { ...account, config: { group_ids: [] } },
      new Map()
    )
    expect(vm.schedule_level).toBe(1)
  })
})

describe('usageModelRows', () => {
  it('maps the usage report models to cost-by-model rows', () => {
    const base = {
      requests: 4,
      success: 4,
      errors: 0,
      success_rate: 1,
      input_tokens: 100,
      output_tokens: 20,
      tokens: 120,
      total_tokens: 120,
      cache_read_tokens: 50,
      cache_creation_tokens: 0,
      cache_hit_rate: 0.5,
      unpriced_requests: 1,
      fable_cost_usd: 0,
      opus_cost_usd: 0,
      avg_duration_ms: null,
      avg_ttft_ms: null,
    }
    expect(
      usageModelRows({
        models: [
          { ...base, model: 'gpt-5-codex', cost_usd: 0.25 },
          { ...base, model: 'gpt-5', cost_usd: null },
        ],
      })
    ).toEqual([
      {
        model: 'gpt-5-codex',
        requests: 4,
        unpriced_requests: 1,
        input_tokens: 100,
        output_tokens: 20,
        cache_read_tokens: 50,
        cache_creation_tokens: 0,
        total_cost: 0.25,
      },
      expect.objectContaining({ model: 'gpt-5', total_cost: 0 }),
    ])
    expect(usageModelRows(undefined)).toBeUndefined()
  })
})
