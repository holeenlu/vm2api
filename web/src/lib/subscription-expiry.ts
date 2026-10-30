import { t } from '@/i18n'
import type { Vm } from '@/types/panel-vm'
import { expiresAtToMs } from '@/lib/fable-status'
import { isCodexVm } from '@/lib/vm-kind'

export type SubscriptionTone = 'muted' | 'warn' | 'bad'

const NEAR_DAYS = 7

/** List/rack label. GPT uses the credential end date only. Claude has no upstream field. */
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
  const date = new Date(ms)
  const stamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  if (ms <= now) {
    return {
      text: t('vm:subscriptionList.expired', { date: stamp }),
      title: t('vm:subscriptionList.credentialOnly'),
      tone: 'bad',
    }
  }
  const days = Math.ceil((ms - now) / 86_400_000)
  return {
    text: t('vm:subscriptionList.remaining', { date: stamp, days }),
    title: t('vm:subscriptionList.credentialOnly'),
    tone: days <= NEAR_DAYS ? 'warn' : 'muted',
  }
}
