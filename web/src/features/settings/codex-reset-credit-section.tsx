import { useState } from 'react'
import { TicketCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PaneSection } from './scheduler-controls'

type ResetCredit = {
  lead_minutes?: number
  max_weekly_remaining_percent?: number | null
}

// Gateway Worker 自动使用重置卡的全局参数；是否开启按账号在 Codex 账号编辑中设置。
export function CodexResetCreditSection({
  value,
  onChange,
  disabled,
}: {
  value: ResetCredit
  onChange: (next: ResetCredit) => void
  disabled: boolean
}) {
  const { t } = useTranslation('settings')
  const [lead, setLead] = useState(String(value.lead_minutes ?? 10))
  const [cap, setCap] = useState(
    value.max_weekly_remaining_percent == null
      ? ''
      : String(value.max_weekly_remaining_percent)
  )
  const leadValue = Number(lead)
  const leadInvalid =
    !Number.isInteger(leadValue) || leadValue < 1 || leadValue > 1440
  const capValue = Number(cap)
  const capInvalid =
    cap.trim() !== '' &&
    (!Number.isInteger(capValue) || capValue < 0 || capValue > 100)
  return (
    <PaneSection
      icon={TicketCheck}
      title={t('codexResetCredit.title')}
      desc={t('codexResetCredit.help')}
    >
      <div className='grid gap-3 sm:grid-cols-2'>
        <div className='space-y-2'>
          <Label htmlFor='codex-reset-credit-lead'>
            {t('codexResetCredit.lead')}
          </Label>
          <Input
            id='codex-reset-credit-lead'
            inputMode='numeric'
            value={lead}
            disabled={disabled}
            aria-invalid={leadInvalid}
            onChange={(event) => {
              setLead(event.target.value)
              const next = Number(event.target.value)
              if (Number.isInteger(next) && next >= 1 && next <= 1440)
                onChange({ ...value, lead_minutes: next })
            }}
          />
          <p className='text-xs text-muted-foreground'>
            {t('codexResetCredit.leadHelp')}
          </p>
        </div>
        <div className='space-y-2'>
          <Label htmlFor='codex-reset-credit-cap'>
            {t('codexResetCredit.weeklyCap')}
          </Label>
          <Input
            id='codex-reset-credit-cap'
            inputMode='numeric'
            value={cap}
            disabled={disabled}
            placeholder={t('codexResetCredit.weeklyCapNone')}
            aria-invalid={capInvalid}
            onChange={(event) => {
              setCap(event.target.value)
              const raw = event.target.value.trim()
              if (raw === '')
                onChange({ ...value, max_weekly_remaining_percent: null })
              else {
                const next = Number(raw)
                if (Number.isInteger(next) && next >= 0 && next <= 100)
                  onChange({ ...value, max_weekly_remaining_percent: next })
              }
            }}
          />
          <p className='text-xs text-muted-foreground'>
            {t('codexResetCredit.weeklyCapHelp')}
          </p>
        </div>
      </div>
    </PaneSection>
  )
}
