import type { Vm } from '@/types/panel-vm'
import { describe, expect, it } from 'vitest'
import {
  faultDistribution,
  faultKindOf,
  matchesAccountFilters,
  quotaHighLoad,
  summarizeLive,
  windowDistribution,
  type LiveBucket,
} from './account-overview-model'

const vm = (over: Partial<Vm> = {}): Vm =>
  ({ id: 'vm-1', has_token: true, ...over }) as Vm

const bucket = (over: Partial<LiveBucket> = {}): LiveBucket => ({
  requests_1m: 0,
  tokens_1m: 0,
  io_tokens_1m: 0,
  requests: 0,
  success: 0,
  prompt_tokens: 0,
  cache_read_tokens: 0,
  ttft_sum: 0,
  ttft_n: 0,
  latency_sum: 0,
  latency_n: 0,
  ...over,
})

describe('fault classification', () => {
  it('maps backend reason codes, ignores self-healing quota limits', () => {
    expect(
      faultKindOf(
        vm({
          schedule_state: 'unschedulable',
          unschedulable_reason: 'oauth_revoked',
        })
      )
    ).toBe('auth')
    expect(
      faultKindOf(
        vm({
          availability: {
            key: 'bad',
            usable: false,
            reason: 'credential_banned',
          },
        })
      )
    ).toBe('forbidden')
    expect(
      faultKindOf(
        vm({
          schedule_state: 'restricted',
          restriction_reason: 'proxy_cooldown',
        })
      )
    ).toBe('proxy')
    expect(
      faultKindOf(
        vm({
          schedule_state: 'unschedulable',
          unschedulable_reason: 'terms_not_accepted',
        })
      )
    ).toBe('terms')
    expect(
      faultKindOf(
        vm({
          schedule_state: 'unschedulable',
          unschedulable_reason: 'runtime_start_failed',
        })
      )
    ).toBe('other')
    expect(
      faultKindOf(
        vm({ schedule_state: 'restricted', restriction_reason: 'quota_5h' })
      )
    ).toBeNull()
    const dist = faultDistribution([
      vm({
        schedule_state: 'unschedulable',
        unschedulable_reason: 'oauth_expired',
      }),
      vm({ schedule_state: 'on' }),
    ])
    expect(dist.auth).toBe(1)
    expect(dist.other).toBe(0)
  })
})

describe('quota windows', () => {
  it('buckets accounts by used percent and skips missing windows', () => {
    const rows = [
      vm({ utilization_5h: 0.2, utilization_7d: 0.9 }),
      vm({ utilization_5h: 1, utilization_7d: 0.1 }),
      vm({ has_token: false, utilization_5h: 1 }),
      vm({
        platform: 'openai',
        family: 'codex',
        codex_usage: { windows: [{ id: '5h', used_percent: 50 }] },
      }),
    ]
    expect(windowDistribution(rows, '5h')).toEqual({
      accounts: 3,
      normal: 2,
      near: 0,
      reached: 1,
    })
    expect(windowDistribution(rows, '7d')).toEqual({
      accounts: 2,
      normal: 1,
      near: 1,
      reached: 0,
    })
    expect(windowDistribution(rows, 'fable').accounts).toBe(0)
    expect(quotaHighLoad(rows)).toBe(2)
  })
})

describe('account filters', () => {
  it('filters by auth method, schedule state and created date', () => {
    const row = vm({
      credential_mode: 'setup-token',
      schedule_state: 'on',
      created_at: '2026-11-05T10:00:00',
    })
    expect(matchesAccountFilters(row, { auth: 'setup-token' })).toBe(true)
    expect(matchesAccountFilters(row, { auth: 'oauth' })).toBe(false)
    expect(matchesAccountFilters(row, { schedule: 'restricted' })).toBe(false)
    expect(
      matchesAccountFilters(row, {
        createdFrom: '2026-11-05',
        createdTo: '2026-11-05',
      })
    ).toBe(true)
    expect(matchesAccountFilters(row, { createdFrom: '2026-11-06' })).toBe(
      false
    )
    expect(matchesAccountFilters(vm(), { createdTo: '2026-11-05' })).toBe(false)
  })
})

describe('live summary', () => {
  it('sums only the accounts in scope before taking ratios', () => {
    const live = {
      generated_at: '',
      window_ms: 300000,
      rpm_window_ms: 60000,
      total: bucket(),
      accounts: {
        'vm-1': bucket({
          requests_1m: 2,
          tokens_1m: 100,
          requests: 4,
          success: 3,
          prompt_tokens: 100,
          cache_read_tokens: 80,
          ttft_sum: 3000,
          ttft_n: 2,
        }),
        'acc-9': bucket({ requests_1m: 50, requests: 50, success: 0 }),
      },
    }
    const s = summarizeLive([vm(), vm({ id: 'vm-2' })], live)
    expect(s.rpm).toBe(2)
    expect(s.successPct).toBe(75)
    expect(s.hitPct).toBe(80)
    expect(s.ttftMs).toBe(1500)
    expect(s.latencyMs).toBeNull()
  })
})
