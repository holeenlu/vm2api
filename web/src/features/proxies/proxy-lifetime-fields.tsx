import type { VmProxySnap } from '@/types/panel-vm'
import { useTranslation } from 'react-i18next'
import { systemDate } from '@/lib/system-time'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SingleDatePicker } from '@/components/date-range-picker'
import { FormField } from '@/components/form-field'
import { SearchSelect } from '@/components/search-select'
import { type ProxyLifetime } from './proxy-lifetime'

export function ProxyLifetimeFields({
  value,
  onChange,
  proxies,
  currentId,
}: {
  value: ProxyLifetime
  onChange: (v: ProxyLifetime) => void
  proxies: VmProxySnap[]
  currentId?: string
}) {
  const { t: translate } = useTranslation('proxies')

  const remainingDays = value.expires_at
    ? Math.round(
        (Date.parse(value.expires_at + 'T00:00:00Z') -
          Date.parse(systemDate() + 'T00:00:00Z')) /
          86400000
      )
    : ''
  const setDays = (days: number) => {
    if (!Number.isInteger(days) || days < 0 || days > 36500) return
    onChange({
      ...value,
      expires_at: days > 0 ? systemDate(Date.now() + days * 86400000) : '',
    })
  }
  return (
    <section className='space-y-5 border-t pt-5'>
      <div className='space-y-3'>
        <span className='text-sm font-medium'>
          {translate('proxies:lifetime')}
        </span>
        <div className='flex flex-wrap gap-2'>
          {[7, 30, 90, 180].map((d) => (
            <Button
              type='button'
              key={d}
              size='sm'
              variant='outline'
              onClick={() => setDays(d)}
            >
              {translate('proxies:validityDays', { count: d })}
            </Button>
          ))}
          <Button
            type='button'
            size='sm'
            variant='ghost'
            onClick={() => setDays(0)}
          >
            {translate('proxies:neverExpires')}
          </Button>
        </div>
        <Input
          aria-label={translate('proxies:customValidityDays')}
          type='number'
          min={1}
          max={36500}
          value={remainingDays}
          placeholder={translate('proxies:validityPlaceholder')}
          onChange={(e) => setDays(Number(e.target.value))}
        />
        <FormField>
          {translate('proxies:expiryDate')}
          <SingleDatePicker
            value={value.expires_at}
            labels={{
              empty: translate('proxies:neverExpires'),
              clear: translate('common:reset'),
              cancel: translate('proxies:cancel'),
              confirm: translate('common:confirm'),
              selectRange: translate('proxies:expiryDate'),
            }}
            onChange={(expires_at) => onChange({ ...value, expires_at })}
          />
        </FormField>
        <p className='text-xs text-muted-foreground'>
          {translate('proxies:expiryHint')}
        </p>
      </div>
      <FormField>
        {translate('proxies:expiryFallback')}
        <select
          className='h-10 w-full rounded-md border bg-background px-3'
          value={value.fallback_mode}
          onChange={(e) =>
            onChange({
              ...value,
              fallback_mode: e.target.value as ProxyLifetime['fallback_mode'],
              backup_proxy_id: '',
            })
          }
        >
          <option value='none'>{translate('proxies:noFallback')}</option>
          <option value='proxy'>
            {translate('proxies:switchBackupProxy')}
          </option>
          <option value='direct'>
            {translate('proxies:switchLocalDirect')}
          </option>
        </select>
      </FormField>
      {value.fallback_mode === 'proxy' && (
        <FormField>
          {translate('proxies:backupProxy')}
          <SearchSelect
            label={translate('proxies:backupProxy')}
            value={value.backup_proxy_id}
            options={proxies
              .filter((p) => p.id !== currentId && p.kind !== 'local')
              .map((p) => ({
                id: p.id || '',
                name: `${p.label || p.host} · ${(p.scheme || 'socks5').toUpperCase()} · ${p.enabled === false || p.blocked_reason ? translate('proxies:unavailable') : translate('proxies:available')}`,
              }))}
            searchPlaceholder={translate('proxies:searchBackup')}
            onChange={(id) => onChange({ ...value, backup_proxy_id: id || '' })}
          />
        </FormField>
      )}
      {value.fallback_mode !== 'none' && (
        <p className='text-xs leading-5 text-muted-foreground'>
          {translate('proxies:fallbackHint')}
        </p>
      )}
    </section>
  )
}
