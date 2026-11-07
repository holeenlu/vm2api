import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { systemDateTime } from '@/lib/system-time'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { FormField } from '@/components/form-field'
import { KEY_NUMERIC_FIELDS } from './bulk-edit'

export type KeyLimitField =
  | keyof typeof KEY_NUMERIC_FIELDS
  | 'expires_at'
  | 'ip_whitelist'
  | 'ip_blacklist'
export type KeyLimitValues = Partial<Record<KeyLimitField, string | number>>

export function KeyEditField({
  label,
  selected,
  onToggle,
  children,
}: {
  label: string
  selected?: boolean
  onToggle?: (selected: boolean) => void
  children: ReactNode
}) {
  if (!onToggle)
    return (
      <FormField>
        {label}
        {children}
      </FormField>
    )
  return (
    <div className='grid min-w-0 gap-2 text-sm leading-5 font-medium'>
      <label className='flex items-center gap-2'>
        <Checkbox
          checked={selected}
          onCheckedChange={(checked) => onToggle(checked === true)}
        />
        {label}
      </label>
      <fieldset disabled={!selected} className='min-w-0'>
        {children}
      </fieldset>
    </div>
  )
}

/**
 * Shared by single-key and bulk editing so layout, copy and expiry actions agree.
 * `limitsLocked`: a user editing keys an administrator created for them may only
 * change the IP lists, so quotas, rate limits and expiry stay visible but disabled.
 */
export function KeyLimitFields({
  values,
  onChange,
  onToggle,
  limitsLocked = false,
}: {
  values: KeyLimitValues
  onChange: (field: KeyLimitField, value: string) => void
  onToggle?: (field: KeyLimitField, selected: boolean) => void
  limitsLocked?: boolean
}) {
  const { t } = useTranslation('keys')
  const fieldProps = (field: KeyLimitField, label: string) => ({
    label: t(label),
    selected: values[field] !== undefined,
    onToggle: onToggle
      ? (selected: boolean) => onToggle(field, selected)
      : undefined,
  })
  return (
    <>
      <fieldset disabled={limitsLocked} className='min-w-0 space-y-5'>
        <h3 className='border-t pt-4 text-sm font-semibold'>{t('limits')}</h3>
        <div className='grid gap-4 sm:grid-cols-2'>
          {Object.entries(KEY_NUMERIC_FIELDS).map(([name, label]) => {
            const field = name as keyof typeof KEY_NUMERIC_FIELDS
            return (
              <KeyEditField key={field} {...fieldProps(field, label)}>
                <Input
                  aria-label={t(label)}
                  type='number'
                  min='0'
                  step={
                    ['max_concurrency', 'rpm', 'quota_requests'].includes(field)
                      ? '1'
                      : '0.000001'
                  }
                  required={!!onToggle && values[field] !== undefined}
                  value={values[field] ?? ''}
                  onChange={(event) => onChange(field, event.target.value)}
                />
              </KeyEditField>
            )
          })}
        </div>
        <p className='text-xs text-muted-foreground'>{t('limitsHelp')}</p>
        <h3 className='border-t pt-4 text-sm font-semibold'>
          {t('accessLimits')}
        </h3>
        <div className='flex flex-wrap gap-2'>
          {[7, 30, 90, 180].map((days) => (
            <Button
              key={days}
              type='button'
              size='sm'
              variant='outline'
              onClick={() =>
                onChange(
                  'expires_at',
                  systemDateTime(Date.now() + days * 86400000).slice(0, 16)
                )
              }
            >
              {t('expiryDays', { count: days })}
            </Button>
          ))}
          <Button
            type='button'
            size='sm'
            variant='ghost'
            onClick={() => onChange('expires_at', '')}
          >
            {t('noExpiry')}
          </Button>
        </div>
        <KeyEditField {...fieldProps('expires_at', 'expiryTime')}>
          <Input
            aria-label={t('expiryTime')}
            type='datetime-local'
            value={values.expires_at ?? ''}
            onChange={(event) => onChange('expires_at', event.target.value)}
          />
        </KeyEditField>
      </fieldset>
      <KeyEditField {...fieldProps('ip_whitelist', 'ipAllowlist')}>
        <Input
          aria-label={t('ipAllowlist')}
          value={values.ip_whitelist ?? ''}
          onChange={(event) => onChange('ip_whitelist', event.target.value)}
        />
      </KeyEditField>
      <KeyEditField {...fieldProps('ip_blacklist', 'ipBlocklist')}>
        <Input
          aria-label={t('ipBlocklist')}
          value={values.ip_blacklist ?? ''}
          onChange={(event) => onChange('ip_blacklist', event.target.value)}
        />
      </KeyEditField>
    </>
  )
}
