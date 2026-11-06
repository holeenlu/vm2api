import { i18n } from '@/i18n'
import type { Vm } from '@/types/panel-vm'
import { beforeEach, describe, expect, it } from 'vitest'
import { accountIdentityFields, billingChannelLabel } from './account-identity'

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN')
})

describe('account identity fields', () => {
  it('lists what the profile returned and skips the rest', () => {
    const vm = {
      id: 'vm-1',
      has_token: true,
      credential_mode: 'oauth',
      email: 'a@privaterelay.appleid.com',
      rate_limit_tier: 'default_claude_max_20x',
      billing_type: 'apple_subscription',
    } as Vm
    expect(accountIdentityFields(vm, 'Max 20x')).toEqual([
      ['邮箱', 'a@privaterelay.appleid.com'],
      ['套餐', 'Max 20x · default_claude_max_20x'],
      ['订阅渠道', 'Apple 内购'],
      ['授权方式', 'OAuth'],
    ])
  })

  it('shows GPT subscription expiry with the renewal flag', () => {
    const vm = {
      id: 'gw-1',
      platform: 'openai',
      family: 'codex',
      has_token: true,
      credential_mode: 'oauth',
      chatgpt_subscription_active_until: '2026-11-27T09:25:20Z',
      subscription_will_renew: false,
    } as Vm
    const until = accountIdentityFields(vm, 'Pro').find(
      ([label]) => label === '订阅到期'
    )
    expect(until?.[1]).toMatch(/· 不续费$/)
  })

  it('keeps unknown billing types verbatim', () => {
    expect(billingChannelLabel('stripe_subscription')).toBe('Stripe 订阅')
    expect(billingChannelLabel('invoice')).toBe('invoice')
    expect(billingChannelLabel('')).toBeNull()
  })
})
