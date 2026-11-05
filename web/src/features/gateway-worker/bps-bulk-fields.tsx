import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { BPS_BULK_FLAGS, type BpsBulkValue } from './bps-bulk'

const selectClass =
  'h-9 w-full min-w-0 rounded-md border bg-background px-3 text-sm'

export function BpsBulkFields({
  value,
  onChange,
}: {
  value: BpsBulkValue
  onChange: (next: BpsBulkValue) => void
}) {
  const { t } = useTranslation(['common', 'vm'])
  return (
    <div className='space-y-3'>
      <div className='grid gap-2 sm:grid-cols-2'>
        {BPS_BULK_FLAGS.map(([key, label]) => (
          <label key={key} className='grid gap-1 text-xs'>
            <span className='font-medium'>{t(label)}</span>
            <select
              className={selectClass}
              aria-label={t(label)}
              value={value.flags[key] || ''}
              onChange={(event) =>
                onChange({
                  ...value,
                  flags: {
                    ...value.flags,
                    [key]: event.target.value as '' | 'on' | 'off',
                  },
                })
              }
            >
              <option value=''>{t('codexBpsBulkKeep')}</option>
              <option value='on'>{t('vm:vmBulk.enable')}</option>
              <option value='off'>{t('vm:vmBulk.disable')}</option>
            </select>
          </label>
        ))}
        <label className='grid gap-1 text-xs'>
          <span className='font-medium'>{t('codexBpsRecoveryInterval')}</span>
          <Input
            inputMode='numeric'
            placeholder={t('codexBpsBulkKeep')}
            value={value.interval}
            onChange={(event) =>
              onChange({ ...value, interval: event.target.value })
            }
          />
        </label>
      </div>
      <div className='grid gap-2 sm:grid-cols-[10rem_1fr]'>
        <select
          className={selectClass}
          aria-label={t('codexBpsModels')}
          value={value.modelMode}
          onChange={(event) =>
            onChange({
              ...value,
              modelMode: event.target.value as BpsBulkValue['modelMode'],
            })
          }
        >
          <option value=''>{t('codexBpsBulkModelsKeep')}</option>
          {(['add', 'remove', 'replace'] as const).map((mode) => (
            <option key={mode} value={mode}>
              {t(`vm:vmBulk.${mode}`)}
            </option>
          ))}
        </select>
        <Input
          disabled={!value.modelMode}
          aria-label={t('codexBpsModels')}
          placeholder={t('codexBpsBulkModelsPlaceholder')}
          value={value.models}
          onChange={(event) =>
            onChange({ ...value, models: event.target.value })
          }
        />
      </div>
      <p className='text-xs text-muted-foreground'>{t('codexBpsBulkHelp')}</p>
    </div>
  )
}
