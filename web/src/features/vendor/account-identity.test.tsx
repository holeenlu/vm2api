import { i18n } from '@/i18n'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { AccountIdentityDetails } from './account-identity'
import type { Resource } from './portal-model'

const resource = (metadata: Record<string, unknown> = {}): Resource => ({
  id: 'account-example',
  vendor_id: 'vendor-example',
  name: 'Example',
  resource_type: 'account',
  status: 'active',
  created_at: '2026-10-31T00:00:00Z',
  config: { platform: 'anthropic', auth_method: 'setup-token' },
  telemetry: {
    vm_id: 'vm-01',
    email: 'hidden@privaterelay.appleid.com',
    ...metadata,
  } as Resource['telemetry'],
})
afterEach(() => i18n.changeLanguage('zh-CN'))
describe('subscription identity details', () => {
  it('omits unavailable fields without guessing from an Apple relay email', async () => {
    await i18n.changeLanguage('zh-CN')
    const html = renderToStaticMarkup(
      <AccountIdentityDetails resource={resource()} />
    )
    expect(html).not.toContain('套餐：')
    expect(html).not.toContain('订阅渠道：')
    expect(html).not.toContain('订阅周期')
    expect(html).not.toContain('未获取')
    expect(html).not.toContain('银行卡')
    expect(html).toContain('授权方式：</span>Setup Token')
    expect(html).not.toContain('Apple 内购')
    expect(html).not.toContain('支付方式：')
  })
  it('shows the observed Max level and channel with an independent timestamp', async () => {
    await i18n.changeLanguage('en-US')
    const html = renderToStaticMarkup(
      <AccountIdentityDetails
        resource={resource({
          plan_type: 'max',
          rate_limit_tier: 'default_claude_max_20x',
          billing_type: 'apple_subscription',
          subscription_updated_at: '2026-10-31T00:00:00Z',
        })}
      />
    )
    expect(html).toContain('Max 20x')
    expect(html).toContain('Apple in-app purchase')
    expect(html).not.toContain('Billing cycle')
    expect(html).not.toContain('Not retrieved')
    expect(html).toContain('Details updated')
    expect(html).not.toContain('default_claude_max_20x')
  })
})
