import { useTranslation } from 'react-i18next'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import type { Resource } from './portal-model'

export function accountPlan(resource: Resource) {
  const t = resource.telemetry
  if (resource.config.platform === 'anthropic') {
    if (/max[_ -]?20x/i.test(t?.rate_limit_tier || '')) return 'Max 20x'
    if (/max[_ -]?5x/i.test(t?.rate_limit_tier || '')) return 'Max 5x'
  }
  return t?.plan_type || null
}
export function AccountIdentity({
  resource: r,
  onDetail,
}: {
  resource: Resource
  onDetail: () => void
}) {
  const { t } = useTranslation('vendor')
  const meta = r.telemetry
  const name = meta?.email || r.name
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
    [
      t('identity.plan'),
      [plan, meta?.rate_limit_tier].filter(Boolean).join(' · '),
    ],
    [t('identity.billing'), meta?.billing_type],
    [t('authMethod'), method],
    [t('proxy'), r.proxy?.endpoint || r.proxy?.name],
  ]
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type='button'
          onClick={onDetail}
          className='block w-64 max-w-full text-start'
          aria-label={t('identity.details', { name })}
        >
          <span className='flex items-baseline gap-1.5'>
            <span className='min-w-0 truncate text-sm font-semibold hover:underline'>
              {name}
            </span>
            <span className='shrink-0 font-mono text-xs text-muted-foreground'>
              #{r.id.slice(-6)}
            </span>
          </span>
          <span className='mt-0.5 flex gap-1 overflow-hidden text-xs text-muted-foreground'>
            {[plan, meta?.billing_type, method]
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
        </button>
      </TooltipTrigger>
      <TooltipContent className='max-w-sm space-y-1 break-words whitespace-normal'>
        {fields
          .filter(([, value]) => value)
          .map(([label, value]) => (
            <p key={label}>
              <span className='opacity-70'>{label}：</span>
              {value}
            </p>
          ))}
      </TooltipContent>
    </Tooltip>
  )
}
