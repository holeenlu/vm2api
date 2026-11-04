import { useState } from 'react'
import { Sunrise } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { PaneSection } from './scheduler-controls'

type Warmup = { enabled?: boolean; times?: string[]; model?: string }

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

// Gateway Worker 账号预热：在 UTC+8 的指定时刻对 OAuth 账号发一个最小请求，提前激活 5h 额度窗口。
export function CodexWarmupSection({
  value,
  onChange,
  disabled,
}: {
  value: Warmup
  onChange: (next: Warmup) => void
  disabled: boolean
}) {
  const { t } = useTranslation('settings')
  const [times, setTimes] = useState((value.times || []).join(', '))
  const parsed = times
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
  const invalid = parsed.some((item) => !TIME.test(item))
  return (
    <PaneSection
      icon={Sunrise}
      title={t('codexWarmup.title')}
      desc={t('codexWarmup.help')}
    >
      <div className='flex items-center justify-between gap-3'>
        <Label htmlFor='codex-warmup-enabled'>{t('codexWarmup.enabled')}</Label>
        <Switch
          id='codex-warmup-enabled'
          checked={value.enabled === true}
          disabled={disabled}
          onCheckedChange={(enabled) => onChange({ ...value, enabled })}
        />
      </div>
      <div className='grid gap-3 sm:grid-cols-2'>
        <div className='space-y-2'>
          <Label htmlFor='codex-warmup-times'>{t('codexWarmup.times')}</Label>
          <Input
            id='codex-warmup-times'
            value={times}
            disabled={disabled}
            placeholder='08:00, 13:00'
            aria-invalid={invalid}
            onChange={(event) => {
              setTimes(event.target.value)
              const next = event.target.value
                .split(/[,\s]+/)
                .map((item) => item.trim())
                .filter(Boolean)
              if (next.every((item) => TIME.test(item)))
                onChange({ ...value, times: next })
            }}
          />
          <p className='text-xs text-muted-foreground'>
            {invalid
              ? t('codexWarmup.invalidTimes')
              : t('codexWarmup.timesHelp')}
          </p>
        </div>
        <div className='space-y-2'>
          <Label htmlFor='codex-warmup-model'>{t('codexWarmup.model')}</Label>
          <Input
            id='codex-warmup-model'
            value={value.model || ''}
            disabled={disabled}
            placeholder={
              /* i18n-exempt "gpt-5.5" -- Example model ID; must match the API identifier. */ 'gpt-5.5'
            }
            onChange={(event) =>
              onChange({ ...value, model: event.target.value })
            }
          />
        </div>
      </div>
    </PaneSection>
  )
}
