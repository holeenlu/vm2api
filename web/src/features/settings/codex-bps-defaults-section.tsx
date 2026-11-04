import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'

export type BpsDefaults = {
  enabled?: boolean
  models?: string[]
  omit_unsupported_tools?: boolean
  ignore_encrypted_content?: boolean
  auto_disable_on_403?: boolean
  auto_recover_on_403?: boolean
  recovery_interval_minutes?: number
  cache_creation_as_input?: boolean
}

const FLAGS = [
  ['enabled', true],
  ['omit_unsupported_tools', false],
  ['ignore_encrypted_content', false],
  ['auto_disable_on_403', true],
  ['auto_recover_on_403', false],
  ['cache_creation_as_input', true],
] as const

// BPS 默认设置模板（routing.codex.bps_defaults）：账号首次添加 BPS 授权时套用，之后在账号里单独修改。
export function CodexBpsDefaultsSettings({
  value,
  onChange,
  disabled,
}: {
  value: BpsDefaults
  onChange: (next: BpsDefaults) => void
  disabled: boolean
}) {
  const { t } = useTranslation('settings')
  const [models, setModels] = useState((value.models || []).join(', '))
  const [interval, setInterval] = useState(
    String(value.recovery_interval_minutes ?? 60)
  )
  const intervalValue = Number(interval)
  const intervalInvalid =
    !Number.isInteger(intervalValue) ||
    intervalValue < 1 ||
    intervalValue > 10080
  return (
    <details className='space-y-3 rounded-md bg-muted/30 p-3'>
      <summary className='cursor-pointer text-sm font-medium'>
        {t('codexBps.defaults.title')}
      </summary>
      <p className='pt-2 text-xs text-muted-foreground'>
        {t('codexBps.defaults.help')}
      </p>
      <div className='grid gap-2 sm:grid-cols-2'>
        {FLAGS.map(([key, fallback]) => (
          <label
            key={key}
            className='flex items-center justify-between gap-2 text-sm'
          >
            {t(`codexBps.defaults.${key}`)}
            <Switch
              checked={value[key] ?? fallback}
              disabled={
                disabled ||
                (key === 'auto_recover_on_403' &&
                  value.auto_disable_on_403 === false)
              }
              onCheckedChange={(checked) =>
                onChange({
                  ...value,
                  [key]: checked,
                  ...(key === 'auto_disable_on_403' && !checked
                    ? { auto_recover_on_403: false }
                    : {}),
                })
              }
              aria-label={t(`codexBps.defaults.${key}`)}
            />
          </label>
        ))}
      </div>
      <div className='grid gap-3 sm:grid-cols-2'>
        <label className='grid gap-1 text-sm'>
          {t('codexBps.defaults.models')}
          <Input
            value={models}
            disabled={disabled}
            placeholder={t('codexBps.defaults.modelsPlaceholder')}
            onChange={(event) => {
              setModels(event.target.value)
              const list = [
                ...new Set(
                  event.target.value
                    .split(/[\s,]+/)
                    .map((model) => model.trim())
                    .filter((model) => model && !model.includes('*'))
                ),
              ].slice(0, 100)
              onChange({ ...value, models: list })
            }}
          />
        </label>
        <label className='grid gap-1 text-sm'>
          {t('codexBps.defaults.recovery_interval_minutes')}
          <Input
            inputMode='numeric'
            value={interval}
            disabled={disabled}
            aria-invalid={intervalInvalid}
            onChange={(event) => {
              setInterval(event.target.value)
              const next = Number(event.target.value)
              if (Number.isInteger(next) && next >= 1 && next <= 10080)
                onChange({ ...value, recovery_interval_minutes: next })
            }}
          />
        </label>
      </div>
    </details>
  )
}
