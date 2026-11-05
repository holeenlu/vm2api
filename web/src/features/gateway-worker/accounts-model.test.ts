import { i18n } from '@/i18n'
import { beforeEach, describe, expect, it } from 'vitest'
import { credEndpointOf } from '@/lib/cred-type'
import { accountStatus, claudeTier } from '@/lib/vm-status'
import { vmSlotId } from '@/features/vm/model'
import {
  autoSelectBpsModels,
  offersBpsStep,
  bpsStatusOf,
  gatewayAccountAsVm,
  gatewayAccountBilling,
  gatewayAccountProxy,
  gatewayExitProbePath,
  missingAllowlistModels,
  removeAllowlistModels,
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

  it('derives the BPS channel status of the account and marks the plan label', () => {
    const settings = {
      enabled: true,
      models: ['gpt-5.5'],
      omit_unsupported_tools: false,
      ignore_encrypted_content: false,
      auto_disable_on_403: true,
      auto_recover_on_403: false,
      recovery_interval_minutes: 60,
      auto_move_on_403: false,
      target_group_id: null,
      cache_creation_as_input: true,
    }
    const grant = { revision: 1, authorized_at: '2026-11-04T00:00:00Z' }
    const withBps = (patch: Partial<GatewayAccount>) =>
      ({
        ...account,
        ...patch,
        config: {
          ...account.config,
          plan: 'pro',
          bps: settings,
          bps_grant: grant,
        },
      }) as GatewayAccount
    expect(bpsStatusOf(account)).toBe('none')
    expect(bpsStatusOf(withBps({}))).toBe('active')
    expect(bpsStatusOf(withBps({ bps_state: 'blocked' }))).toBe('blocked')
    expect(
      bpsStatusOf({
        ...withBps({}),
        config: { ...withBps({}).config, bps: { ...settings, models: [] } },
      })
    ).toBe('off')
    const active = gatewayAccountAsVm(withBps({}), new Map())
    const blocked = gatewayAccountAsVm(
      withBps({ bps_state: 'expired' }),
      new Map()
    )
    const native = gatewayAccountAsVm(account, new Map())
    expect(credEndpointOf({ ...active, has_token: true })).toBe('oauth')
    expect(claudeTier({ ...active, has_token: true }).label).toMatch(/ \+BPS$/)
    expect(claudeTier({ ...blocked, has_token: true }).label).toMatch(
      / \+BPS!$/
    )
    expect(claudeTier({ ...native, has_token: true }).label).not.toMatch(/BPS/)
  })

  it('shows the stored subscription expiry on the list and card', () => {
    const vm = gatewayAccountAsVm(
      {
        ...account,
        config: {
          ...account.config,
          subscription: { expires_at: '2026-12-01T00:00:00.000Z' },
        },
      },
      new Map()
    )
    expect(vm.chatgpt_subscription_active_until).toBe(
      '2026-12-01T00:00:00.000Z'
    )
    expect(
      gatewayAccountAsVm(account, new Map()).chatgpt_subscription_active_until
    ).toBeNull()
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
      withProxy({ proxy_endpoint: 'socks5://72.245.129.139:7740' }),
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
    expect(vmSlotId({ id: 'gw-07', runtime_type: 'gateway' })).toBe('gw-07')
    expect(vmSlotId({ id: 'vm-25' })).toBe('vm-25')
  })
})

describe('allowlist cleanup', () => {
  const access = {
    mode: 'allowlist' as const,
    models: ['gpt-a', 'gone-1', 'gone-2'],
  }

  it('lists selected ids the loaded catalog no longer returns', () => {
    expect(missingAllowlistModels(access, ['gpt-a', 'gpt-b'])).toEqual([
      'gone-1',
      'gone-2',
    ])
  })

  it('offers nothing when the catalog is missing, empty or the mode is not allowlist', () => {
    expect(missingAllowlistModels(access, undefined)).toEqual([])
    expect(missingAllowlistModels(access, [])).toEqual([])
    expect(
      missingAllowlistModels({ ...access, mode: 'denylist' }, ['gpt-a'])
    ).toEqual([])
  })

  it('removes only chosen missing ids and never empties the allowlist', () => {
    const missing = ['gone-1', 'gone-2']
    expect(
      removeAllowlistModels(access, ['gone-1', 'gpt-a'], missing).models
    ).toEqual(['gpt-a', 'gone-2'])
    const onlyMissing = { mode: 'allowlist' as const, models: missing }
    expect(removeAllowlistModels(onlyMissing, missing, missing)).toBe(
      onlyMissing
    )
    expect(removeAllowlistModels(access, [], missing)).toBe(access)
  })
})

describe('account wizard follows the Worker capability description (P6.3)', () => {
  it('offers the BPS step only when a Worker reports a BPS authorization', () => {
    expect(offersBpsStep({ authorizations: ['import', 'oauth'] })).toBe(false)
    expect(offersBpsStep({ authorizations: ['bps_oauth', 'oauth'] })).toBe(true)
    expect(offersBpsStep({})).toBe(true)
  })
})

describe('auto-select after fetching the BPS catalog', () => {
  const catalog = {
    allowed: true,
    models: [
      { id: 'gpt-6-astra', reasoning_efforts: [] },
      { id: 'gpt-6.1-sol', reasoning_efforts: [] },
      { id: 'gpt-6-luna', reasoning_efforts: [], cooling_down: true },
      { id: 'gpt-5.6-terra', reasoning_efforts: [] },
    ],
    restricted_models: ['gpt-secret'],
    fetched_at: '2026-11-05T00:00:00Z',
  }

  it('adds available catalog models inside the allowlist and keeps prior picks', () => {
    expect(
      autoSelectBpsModels(['gpt-x'], catalog, {
        mode: 'allowlist',
        models: ['gpt-6.1-sol', 'gpt-6-luna', 'gpt-5.6-terra', 'gpt-secret'],
      })
    ).toEqual(['gpt-x', 'gpt-6.1-sol', 'gpt-5.6-terra'])
  })

  it('takes every available model for all-models scope and drops denylisted ones', () => {
    expect(
      autoSelectBpsModels([], catalog, { mode: 'all', models: [] })
    ).toEqual(['gpt-6-astra', 'gpt-6.1-sol', 'gpt-5.6-terra'])
    expect(
      autoSelectBpsModels(['gpt-6-astra'], catalog, {
        mode: 'denylist',
        models: ['gpt-6.1-sol'],
      })
    ).toEqual(['gpt-6-astra', 'gpt-5.6-terra'])
  })

  it('selects nothing when BPS denies the account and caps the list at 100', () => {
    expect(
      autoSelectBpsModels(['a'], { ...catalog, allowed: false }, null)
    ).toEqual(['a'])
    const full = Array.from({ length: 99 }, (_, i) => `m${i}`)
    expect(autoSelectBpsModels(full, catalog, null)).toEqual([
      ...full,
      'gpt-6-astra',
    ])
  })
})
