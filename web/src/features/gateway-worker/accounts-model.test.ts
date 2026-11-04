import { i18n } from '@/i18n'
import { beforeEach, describe, expect, it } from 'vitest'
import { accountStatus } from '@/lib/vm-status'
import { vmSlotId } from '@/features/vm/model'
import {
  gatewayAccountAsVm,
  gatewayAccountBilling,
  gatewayAccountProxy,
  gatewayExitProbePath,
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

  describe('Worker credential state', () => {
    beforeEach(async () => {
      await i18n.changeLanguage('zh-CN')
    })

    it('shows an idle account whose refresh failed as unavailable instead of 可用', () => {
      const vm = gatewayAccountAsVm(
        {
          ...account,
          credential_state: 'expired',
          credential_error: 'credential_refresh_failed',
        },
        new Map()
      )
      expect(vm.availability).toMatchObject({ key: 'bad', usable: true })
      expect(accountStatus(vm)).toMatchObject({ cls: 'bad', text: '刷新失败' })
    })

    it('maps terminal states to the VM credential labels and blocks scheduling', () => {
      const vm = gatewayAccountAsVm(
        { ...account, credential_state: 'banned', status: 'paused' },
        new Map()
      )
      expect(vm.availability).toMatchObject({ key: 'bad', usable: false })
      expect(accountStatus(vm)).toMatchObject({ cls: 'bad', text: '凭证吊销' })
      expect(accountStatus(gatewayAccountAsVm(account, new Map())).cls).toBe(
        'ok'
      )
    })
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

describe('gatewayAccountProxy', () => {
  const pool = [
    { id: 'px-1', host: '10.0.0.1', port: 1080 },
    { id: 'px-2', vendor_resource_id: 'vres-9', host: '10.0.0.2', port: 1080 },
    { id: 'px-3', host: '10.0.0.3', port: 7740 },
  ]
  const withProxy = (config: Partial<GatewayAccount['config']>) => ({
    ...account,
    config: { group_ids: [], ...config },
  })

  it('resolves the pool record by id, supplier resource id or host and port', () => {
    expect(gatewayAccountProxy(withProxy({ proxy_id: 'px-1' }), pool)?.id).toBe(
      'px-1'
    )
    expect(
      gatewayAccountProxy(withProxy({ proxy_id: 'vres-9' }), pool)?.id
    ).toBe('px-2')
    expect(
      gatewayAccountProxy(
        withProxy({ proxy_endpoint: 'socks5://10.0.0.3:7740' }),
        pool
      )?.id
    ).toBe('px-3')
  })

  it('keeps only host and port for inline proxies outside the pool', () => {
    const proxy = gatewayAccountProxy(
      withProxy({ proxy_endpoint: 'http://72.245.129.139:7740' }),
      pool
    )
    expect(proxy).toEqual({ host: '72.245.129.139', port: '7740' })
    expect(gatewayExitProbePath({ proxy: proxy ?? undefined })).toBeNull()
    expect(gatewayExitProbePath({ proxy: pool[0] })).toBe(
      '/api/panel/proxies/px-1/geo'
    )
    expect(gatewayAccountProxy(withProxy({}), pool)).toBeNull()
  })
})

describe('gatewayAccountBilling', () => {
  it('maps today and the 5H / 7D usage to billing windows', () => {
    const billing = gatewayAccountBilling({
      ...account,
      usage: {
        today_requests: 2,
        today_cost: 0.5,
        today_input_tokens: 10,
        today_output_tokens: 4,
        window_5h_requests: 3,
        window_5h_cost: 1,
        window_5h_input_tokens: 20,
        window_5h_cache_read_tokens: 7,
      } as GatewayAccount['usage'],
    })
    expect(billing.today).toMatchObject({ requests: 2, input_tokens: 10 })
    expect(billing.window_5h).toEqual({
      requests: 3,
      input_tokens: 20,
      output_tokens: 0,
      cache_read_tokens: 7,
      cache_creation_tokens: 0,
      total_cost: 1,
    })
    expect(gatewayAccountBilling(account).window_7d).toBeNull()
  })
})

describe('vmSlotId', () => {
  it('shortens Gateway account ids and keeps VM slot ids', () => {
    expect(
      vmSlotId({
        id: 'account_06a6f35e-7ebc-4d1a-9f00-000000000000',
        runtime_type: 'gateway',
      })
    ).toBe('06a6f35e')
    expect(vmSlotId({ id: 'vm-25' })).toBe('vm-25')
  })
})
