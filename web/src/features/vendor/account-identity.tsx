import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
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
    if (/max[_ -]?20x/i.test(t?.rate_limit_tier || '')) return 'Max 20x'
    if (/max[_ -]?5x/i.test(t?.rate_limit_tier || '')) return 'Max 5x'
  }
  return t?.plan_type || null
}
function channelKey(billingType?: string | null) {
  if (billingType === 'apple_subscription') return 'identity.channelApple'
  if (billingType === 'google_subscription') return 'identity.channelGoogle'
  if (billingType === 'stripe_subscription') return 'identity.channelStripe'
  return null
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
    [
      t('identity.channel'),
      channelKey(meta?.billing_type)
        ? t(channelKey(meta?.billing_type)!)
        : meta?.billing_type,
    ],
    [t('authMethod'), method],
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
  const channel = channelKey(meta?.billing_type)
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
            {[plan, channel ? t(channel) : meta?.billing_type, method]
              .filter(Boolean)
              .map((label, i) => (
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
