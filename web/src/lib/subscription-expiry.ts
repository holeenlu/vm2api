import { t } from '@/i18n'
import type { Vm } from '@/types/panel-vm'
import { expiresAtToMs } from '@/lib/fable-status'
import { systemDate } from '@/lib/system-time'
import { isCodexVm } from '@/lib/vm-kind'

export type SubscriptionTone = 'muted' | 'warn' | 'bad'

const NEAR_DAYS = 7

/** List/rack label. GPT uses the account check renewal/end date, else the id_token claim. Claude has no upstream field. */
export function subscriptionListLabel(
  vm: Vm,
  now: number
): { text: string; title: string; tone: SubscriptionTone } {
  const unknown = {
    text: t('vm:subscriptionList.unknown'),
    title: isCodexVm(vm)
      ? t('vm:subscriptionList.missingCredential')
      : t('vm:subscriptionList.claudeUnknown'),
    tone: 'muted' as const,
  }
  if (!isCodexVm(vm)) return unknown
  const raw = vm.chatgpt_subscription_active_until
  const ms = expiresAtToMs(raw)
  if (!raw || !ms) return unknown
  const stamp = systemDate(ms)
  if (ms <= now) {
    return {
      text: t('vm:subscriptionList.expired', { date: stamp }),
      title: t('vm:subscriptionList.credentialOnly'),
      tone: 'bad',
    }
  }
  const days = Math.ceil((ms - now) / 86_400_000)
  // 续订状态直接标在到期日后：不续订的账号到期后就不能用了。
  const renew =
    vm.subscription_will_renew === true
      ? t('vm:subscriptionList.renew')
      : vm.subscription_will_renew === false
        ? t('vm:subscriptionList.noRenew')
        : ''
  return {
    text: [t('vm:subscriptionList.remaining', { date: stamp, days }), renew]
      .filter(Boolean)
      .join(' · '),
    title: t('vm:subscriptionList.credentialOnly'),
    tone:
      days <= NEAR_DAYS || vm.subscription_will_renew === false
        ? 'warn'
        : 'muted',
  }
}
