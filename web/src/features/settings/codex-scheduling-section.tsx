import { Gauge } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ChipGroup, PaneSection } from './scheduler-controls'

type Policy = {
  strategy?: string
  affinity?: string
  smart_weights?: Record<string, number>
}
const defaults = {
  load: 1,
  quota: 0.8,
  health: 1,
  latency: 0.5,
  reset: 0,
  queue: 0,
}

export function CodexSchedulingSection({
  value,
  onChange,
  disabled,
}: {
  value: Policy
  onChange: (next: Policy) => void
  disabled: boolean
}) {
  const { t } = useTranslation('settings')
  return (
    <PaneSection
      icon={Gauge}
      title={t('codexScheduling.title')}
      desc={t('codexScheduling.help')}
    >
      <div className='space-y-2'>
        <Label>{t('codexScheduling.strategy')}</Label>
        <ChipGroup
          label={t('codexScheduling.strategy')}
          value={value.strategy || 'smart'}
          options={[
            'smart',
            'quota_reset_priority',
            'round_robin',
            'sticky',
          ].map((key) => [key, t(`codexScheduling.${key}`)])}
          disabled={disabled}
          onChange={(strategy) => onChange({ ...value, strategy })}
        />
      </div>
      <div className='space-y-2'>
        <Label>{t('codexScheduling.affinity')}</Label>
        <ChipGroup
          label={t('codexScheduling.affinity')}
          value={value.affinity || 'preferred'}
          options={['strict', 'preferred', 'relaxed'].map((key) => [
            key,
            t(`codexScheduling.${key}`),
          ])}
          disabled={disabled}
          onChange={(affinity) => onChange({ ...value, affinity })}
        />
        <p className='text-xs text-muted-foreground'>
          {t('codexScheduling.affinityHelp')}
        </p>
      </div>
      {(value.strategy || 'smart') === 'smart' && (
        <div className='grid grid-cols-2 gap-3 sm:grid-cols-3'>
          {Object.entries(defaults).map(([key, fallback]) => (
            <div className='space-y-2' key={key}>
              <Label htmlFor={`codex-weight-${key}`}>
                {t(`codexScheduling.${key}`)}
              </Label>
              <Input
                id={`codex-weight-${key}`}
                type='number'
                min={0}
                max={10}
                step={0.1}
                disabled={disabled}
                value={value.smart_weights?.[key] ?? fallback}
                onChange={(event) => {
                  const weight = Number(event.target.value)
                  if (Number.isFinite(weight) && weight >= 0 && weight <= 10)
                    onChange({
                      ...value,
                      smart_weights: {
                        ...defaults,
                        ...value.smart_weights,
                        [key]: Math.round(weight * 10) / 10,
                      },
                    })
                }}
              />
            </div>
          ))}
        </div>
      )}
    </PaneSection>
  )
}
