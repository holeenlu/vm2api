import { useTranslation } from 'react-i18next'

export function RawConfigFields({
  value,
}: {
  value: Record<string, unknown> | undefined
}) {
  const { t } = useTranslation('settings')

  const entries = value ? Object.entries(value) : []
  if (!entries.length) {
    return <p className='text-sm text-muted-foreground'>{t('noConfig')}</p>
  }
  return (
    <div className='divide-y rounded-md border'>
      {entries.map(([key, val]) => (
        <div
          key={key}
          className='grid grid-cols-[10rem_1fr] items-start gap-x-3 px-3 py-2 text-sm'
        >
          <div className='font-mono text-xs text-muted-foreground'>{key}</div>
          <div className='min-w-0 font-mono text-xs break-all'>
            {val == null
              ? '—'
              : typeof val === 'object'
                ? JSON.stringify(val)
                : String(val)}
          </div>
        </div>
      ))}
    </div>
  )
}
