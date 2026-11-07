import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { billingChannelLabel, maxMultiplierLabel } from '@/lib/account-identity'
import { copyText } from '@/lib/clipboard'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { time, type Resource } from './portal-model'

function accountPlan(resource: Resource) {
  const t = resource.telemetry
  if (resource.config.platform === 'anthropic') {
    const multiplier = maxMultiplierLabel(t?.rate_limit_tier)
    if (multiplier) return multiplier
  }
  return t?.plan_type || null
}

export function AccountIdentityDetails({
  resource: r,
}: {
  resource: Resource
}) {
  const { t } = useTranslation('vendor')
  const meta = r.telemetry
  const plan = accountPlan(r)
  const method = ['oauth', 'setup-token', 'apikey'].includes(
    String(r.config.auth_method)
  )
    ? t('wb.method.' + r.config.auth_method)
    : null
  const fields = [
    [t('accountName'), r.name],
    [t('accountId'), r.id],
    [t('identity.email'), meta?.email],
    [t('identity.plan'), plan],
    [t('identity.channel'), billingChannelLabel(meta?.billing_type)],
    [t('authMethod'), method],
    [
      t('identity.expiresAt'),
      meta?.subscription_expires_at
        ? `${time(meta.subscription_expires_at)}${
            meta.subscription_will_renew === true
              ? ` · ${t('identity.autoRenew')}`
              : meta.subscription_will_renew === false
                ? ` · ${t('identity.noRenew')}`
                : ''
          }`
        : null,
    ],
    [
      t('identity.updatedAt'),
      meta?.subscription_updated_at ? time(meta.subscription_updated_at) : null,
    ],
    [t('proxy'), r.proxy?.endpoint || r.proxy?.name],
  ]
  return (
    <>
      {fields
        .filter(([, value]) => value)
        .map(([label, value]) => (
          <p key={label}>
            <span className='opacity-70'>{label}：</span>
            {value}
          </p>
        ))}
    </>
  )
}

export function AccountIdentity({ resource: r }: { resource: Resource }) {
  const { t } = useTranslation('vendor')
  const meta = r.telemetry
  const name = meta?.email || r.name
  const plan = accountPlan(r)
  const method = ['oauth', 'setup-token', 'apikey'].includes(
    String(r.config.auth_method)
  )
    ? t('wb.method.' + r.config.auth_method)
    : null
  const channel = billingChannelLabel(meta?.billing_type)
  const copyName = async () => {
    if (await copyText(name)) toast.success(t('common:copied'))
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className='block w-64 max-w-full text-start'>
          <span className='flex items-baseline gap-1.5'>
            <button
              type='button'
              onClick={() => void copyName()}
              className='min-w-0 truncate text-start text-sm font-semibold hover:underline'
              aria-label={t('identity.copyName', { name })}
            >
              {name}
            </button>
            <span className='shrink-0 font-mono text-xs text-muted-foreground'>
              #{r.id.slice(-6)}
            </span>
          </span>
          <span className='mt-0.5 flex gap-1 overflow-hidden text-xs text-muted-foreground'>
            {[plan, channel, method].filter(Boolean).map((label, i) => (
              <span
                key={i}
                className='max-w-28 truncate rounded-sm bg-muted px-1 py-0.5'
              >
                {label}
              </span>
            ))}
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent className='max-w-sm space-y-1 break-words whitespace-normal'>
        <AccountIdentityDetails resource={r} />
      </TooltipContent>
    </Tooltip>
  )
}
