import { t } from '@/i18n'
import type { Vm } from '@/types/panel-vm'
import { credTypeLabel, credTypeOf } from '@/lib/cred-type'
import { fmtExpiresAt } from '@/lib/format'
import { isCodexVm } from '@/lib/vm-kind'

/** 官方资料 `organization.rate_limit_tier`（default_claude_max_20x 等）里的 Max 倍数。 */
export function maxMultiplierLabel(rateLimitTier?: string | null) {
  const raw = String(rateLimitTier || '')
  if (/max[_ -]?20x/i.test(raw)) return 'Max 20x'
  if (/max[_ -]?5x/i.test(raw)) return 'Max 5x'
  return null
}

/** 订阅渠道（官方资料 billing_type / ChatGPT 购买平台归一后的值）。 */
export function billingChannelLabel(billingType?: string | null) {
  const raw = String(billingType || '').trim()
  if (!raw) return null
  if (raw === 'apple_subscription') return t('vendor:identity.channelApple')
  if (raw === 'google_subscription') return t('vendor:identity.channelGoogle')
  if (raw === 'stripe_subscription') return t('vendor:identity.channelStripe')
  return raw
}

/** 账号身份明细（列表悬浮卡与详情卡共用）；没有取到的字段不显示。 */
export function accountIdentityFields(
  vm: Vm,
  plan: string | null
): Array<[string, string]> {
  const renew = vm.subscription_will_renew
  const rateTier = isCodexVm(vm) ? '' : String(vm.rate_limit_tier || '')
  const credType = credTypeOf(vm)
  const until = isCodexVm(vm) ? vm.chatgpt_subscription_active_until : null
  const rows: Array<[string, string | null | undefined]> = [
    [t('vendor:identity.email'), vm.email ? String(vm.email) : null],
    [
      t('vendor:identity.plan'),
      plan && rateTier ? `${plan} · ${rateTier}` : plan || rateTier,
    ],
    [t('vendor:identity.channel'), billingChannelLabel(vm.billing_type)],
    [
      t('vendor:authMethod'),
      credType === 'none' ? null : credTypeLabel(credType),
    ],
    [
      t('vendor:identity.expiresAt'),
      until
        ? `${fmtExpiresAt(until)}${
            renew === true
              ? ` · ${t('vendor:identity.autoRenew')}`
              : renew === false
                ? ` · ${t('vendor:identity.noRenew')}`
                : ''
          }`
        : null,
    ],
    [
      t('vendor:identity.updatedAt'),
      vm.subscription_updated_at
        ? fmtExpiresAt(vm.subscription_updated_at)
        : null,
    ],
  ]
  return rows.filter((row): row is [string, string] => Boolean(row[1]))
}
