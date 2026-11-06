import { i18n } from '@/i18n'
import type { Vm } from '@/types/panel-vm'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { subscriptionListLabel } from './subscription-expiry'

const now = Date.UTC(2026, 9, 30)
const vm = (fields: Record<string, unknown>) =>
  ({ platform: 'openai', ...fields }) as Vm
beforeEach(() => i18n.changeLanguage('zh-CN'))
afterEach(() => i18n.changeLanguage('zh-CN'))

it('does not infer a subscription from token expiry or quota resets', () => {
  const result = subscriptionListLabel(
    vm({ expires_at: now + 86400000, reset_5h: now + 3600000 }),
    now
  )
  expect(result.tone).toBe('muted')
  expect(result.text).toBe('订阅 未知')
  expect(
    subscriptionListLabel(
      vm({
        platform: 'anthropic',
        chatgpt_subscription_active_until: now + 86400000,
      }),
      now
    ).text
  ).toBe('订阅 未知')
})

it('uses credential seconds, milliseconds or ISO dates with the same warning boundary', () => {
  const end = now + 7 * 86400000
  for (const raw of [end, end / 1000, new Date(end).toISOString()]) {
    const result = subscriptionListLabel(
      vm({ chatgpt_subscription_active_until: raw }),
      now
    )
    expect(result.tone).toBe('warn')
    expect(result.text).toContain('7d')
  }
  expect(
    subscriptionListLabel(
      vm({ chatgpt_subscription_active_until: end + 86400000 }),
      now
    ).tone
  ).toBe('muted')
  expect(
    subscriptionListLabel(vm({ chatgpt_subscription_active_until: now }), now)
      .tone
  ).toBe('bad')
  expect(
    subscriptionListLabel(
      vm({ chatgpt_subscription_active_until: 'invalid' }),
      now
    ).text
  ).toBe('订阅 未知')
})

it('resolves subscription copy in the current console language', async () => {
  await i18n.changeLanguage('en-US')
  expect(subscriptionListLabel(vm({}), now).text).toBe('Subscription unknown')
  await i18n.changeLanguage('ja-JP')
  expect(
    subscriptionListLabel(
      vm({ chatgpt_subscription_active_until: now - 1000 }),
      now
    ).text
  ).toContain('期限切れ')
})
