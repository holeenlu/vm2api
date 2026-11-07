import type { RequestLocation } from '@/types/panel-vm'
import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

// 请求位置的四个字段（设置页全局位置与代理手动位置共用）。
export function RequestLocationFields({
  value,
  onChange,
  disabled,
  idPrefix,
}: {
  value: RequestLocation
  onChange: (next: RequestLocation) => void
  disabled?: boolean
  idPrefix: string
}) {
  const { t } = useTranslation('settings')
  const labels: Record<keyof RequestLocation, string> = {
    country: t('requestLocation.country'),
    region: t('requestLocation.region'),
    city: t('requestLocation.city'),
    timezone: t('requestLocation.timezone'),
  }
  const field = (key: keyof RequestLocation, placeholder: string) => (
    <Label
      htmlFor={`${idPrefix}-${key}`}
      className='flex flex-col items-start gap-2'
    >
      {labels[key]}
      <Input
        id={`${idPrefix}-${key}`}
        disabled={disabled}
        value={value[key]}
        placeholder={placeholder}
        onChange={(event) => onChange({ ...value, [key]: event.target.value })}
      />
    </Label>
  )
  return (
    <div className='grid gap-3 sm:grid-cols-2'>
      {field('country', 'US')}
      {field('region', 'Ohio')}
      {field('city', 'Piketon')}
      {field('timezone', 'America/New_York')}
    </div>
  )
}
