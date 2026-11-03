import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'

export function ProxyEditorFields({
  editing,
  name,
  endpoint,
  onNameChange,
  onEndpointChange,
}: {
  editing: boolean
  name: string
  endpoint: string
  onNameChange: (value: string) => void
  onEndpointChange: (value: string) => void
}) {
  const { t } = useTranslation('supplierAdmin')
  return (
    <>
      <label className='grid gap-2 text-sm'>
        {t('name')}
        <Input
          required
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
        />
      </label>
      <label className='grid gap-2 text-sm'>
        {t('endpoint')}
        <Input
          required={!editing}
          maxLength={2000}
          autoComplete='off'
          spellCheck={false}
          placeholder='socks5://user:password@host:1080'
          value={endpoint}
          onChange={(e) => onEndpointChange(e.target.value)}
        />
        <span className='text-xs text-muted-foreground'>
          {t(editing ? 'proxyEditEndpointHint' : 'proxyCredentialHint')}
        </span>
      </label>
    </>
  )
}
