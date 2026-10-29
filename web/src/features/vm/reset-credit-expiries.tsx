import { useTranslation } from 'react-i18next'
import { ResetAt } from './detail-section-primitives'

export function ResetCreditExpiries({
  credits,
  now,
}: {
  credits?: Array<{ expires_at?: string }>
  now: number
}) {
  const { t } = useTranslation('vm')
  return (
    <div className='grid min-w-0 gap-1 text-[11px] text-muted-foreground'>
      {(credits || []).map((credit, index) =>
        credit.expires_at ? (
          <div key={`${credit.expires_at}-${index}`}>
            {t('vm:openaiQuotaActions.creditExpiry', { value1: index + 1 })}{' '}
            <ResetAt value={credit.expires_at} now={now} />
          </div>
        ) : null
      )}
    </div>
  )
}
