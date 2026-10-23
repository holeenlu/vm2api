import { useId, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import {
  brandingQuery,
  DEFAULT_BRANDING,
  type Branding,
} from '@/context/branding-provider'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { FormField } from '@/components/form-field'

type BrandingImageKey = 'logo_url' | 'favicon_url'

function BrandingImageUpload({
  label,
  fileName,
  onSelect,
}: {
  label: string
  fileName?: string
  onSelect: (file: File | undefined) => void
}) {
  const { t } = useTranslation('settings')
  const id = useId()
  const input = useRef<HTMLInputElement>(null)
  const statusId = id + '-status'
  const name = t('branding.chooseImage', { label })
  return (
    <div className='flex flex-wrap items-center gap-2'>
      <label htmlFor={id} className='sr-only'>
        {name}
      </label>
      <input
        ref={input}
        id={id}
        type='file'
        hidden
        className='hidden'
        accept='image/png,image/jpeg,image/webp'
        aria-describedby={statusId}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0]
          event.currentTarget.value = ''
          onSelect(file)
        }}
      />
      <Button
        type='button'
        variant='outline'
        aria-label={name}
        aria-describedby={statusId}
        onClick={() => input.current?.click()}
      >
        {t('branding.chooseFile')}
      </Button>
      <span
        id={statusId}
        role='status'
        aria-live='polite'
        className='min-w-0 text-sm break-all text-muted-foreground'
      >
        {fileName
          ? t('branding.selectedFile', { name: fileName })
          : t('branding.noFileSelected')}
      </span>
    </div>
  )
}

export function BrandingPane() {
  const { t } = useTranslation('settings')
  const q = useQuery(brandingQuery())
  const qc = useQueryClient()
  const [draft, setDraft] = useState<Branding | null>(null)
  const [busy, setBusy] = useState(false)
  const [selectedFiles, setSelectedFiles] = useState<
    Partial<Record<BrandingImageKey, { name: string; value: string }>>
  >({})
  const form = draft || q.data || DEFAULT_BRANDING
  async function upload(file: File | undefined, key: BrandingImageKey) {
    if (!file) return
    if (
      !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) ||
      file.size > 256 * 1024
    )
      return toast.error(t('branding.imageHint'))
    const reader = new FileReader()
    reader.onload = () => {
      const value = String(reader.result)
      setDraft((current) => ({
        ...(current || q.data || DEFAULT_BRANDING),
        [key]: value,
      }))
      setSelectedFiles((current) => ({
        ...current,
        [key]: { name: file.name, value },
      }))
    }
    reader.onerror = () => toast.error(t('branding.readFailed'))
    reader.readAsDataURL(file)
  }
  if (q.isPending) return <p>{t('loading')}</p>
  if (q.error) return <p role='alert'>{q.error.message}</p>
  return (
    <form
      className='max-w-2xl space-y-5 rounded-xl border p-5'
      onSubmit={async (e) => {
        e.preventDefault()
        setBusy(true)
        try {
          await api('/api/panel/site', {
            method: 'PUT',
            body: JSON.stringify(form),
          })
          await qc.invalidateQueries({ queryKey: ['site', 'branding'] })
          setDraft(null)
          toast.success(t('branding.saved'))
        } catch (err) {
          toast.error((err as Error).message)
        } finally {
          setBusy(false)
        }
      }}
    >
      <h2 className='text-lg font-semibold'>{t('branding.title')}</h2>
      <p className='text-sm text-muted-foreground'>
        {t('branding.description')}
      </p>
      {(
        [
          ['name', t('branding.name')],
          ['tagline', t('branding.tagline')],
        ] as const
      ).map(([key, label]) => (
        <FormField key={key}>
          {label}
          <Input
            required={key === 'name'}
            maxLength={80}
            value={form[key]}
            onChange={(e) => setDraft({ ...form, [key]: e.target.value })}
          />
        </FormField>
      ))}
      {(
        [
          ['logo_url', t('branding.logoUrl')],
          ['favicon_url', t('branding.faviconUrl')],
        ] as const
      ).map(([key, label]) => (
        <section key={key} className='space-y-2'>
          <FormField>
            {label}
            <Input
              value={form[key].startsWith('data:') ? '' : form[key]}
              placeholder={
                form[key].startsWith('data:')
                  ? t('branding.upload')
                  : 'https://…'
              }
              onChange={(e) => setDraft({ ...form, [key]: e.target.value })}
            />
          </FormField>
          <BrandingImageUpload
            label={t(
              key === 'logo_url'
                ? 'branding.logoImage'
                : 'branding.faviconImage'
            )}
            fileName={
              selectedFiles[key]?.value === form[key]
                ? selectedFiles[key]?.name
                : undefined
            }
            onSelect={(file) => void upload(file, key)}
          />
          {form[key] && (
            <img
              src={form[key]}
              alt={label}
              className='size-16 rounded border object-contain'
            />
          )}
          {form[key] && (
            <Button
              type='button'
              variant='ghost'
              onClick={() => setDraft({ ...form, [key]: '' })}
            >
              {t('branding.removeImage')}
            </Button>
          )}
        </section>
      ))}
      <p className='text-xs text-muted-foreground'>{t('branding.imageHint')}</p>
      <div className='flex gap-2'>
        <Button disabled={busy || !draft}>{t('save')}</Button>
        <Button
          type='button'
          variant='outline'
          onClick={() => setDraft({ ...DEFAULT_BRANDING })}
        >
          {t('restoreDefaults')}
        </Button>
      </div>
    </form>
  )
}
