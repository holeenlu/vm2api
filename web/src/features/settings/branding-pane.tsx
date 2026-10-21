import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import {
  brandingQuery,
  DEFAULT_BRANDING,
  type Branding,
} from '@/context/branding-provider'
import { useLocale } from '@/context/locale-provider'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { FormField } from '@/components/form-field'

export function BrandingPane() {
  const { t } = useLocale()
  const q = useQuery(brandingQuery())
  const qc = useQueryClient()
  const [draft, setDraft] = useState<Branding | null>(null)
  const [busy, setBusy] = useState(false)
  const form = draft || q.data || DEFAULT_BRANDING
  async function upload(
    file: File | undefined,
    key: 'logo_url' | 'favicon_url'
  ) {
    if (!file) return
    if (
      !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) ||
      file.size > 256 * 1024
    )
      return toast.error(
        t('支持 PNG、JPEG、WebP，最大 256 KB；留空使用默认图标。')
      )
    const reader = new FileReader()
    reader.onload = () =>
      setDraft((current) => ({
        ...(current || q.data || DEFAULT_BRANDING),
        [key]: String(reader.result),
      }))
    reader.onerror = () => toast.error(t('图片读取失败'))
    reader.readAsDataURL(file)
  }
  if (q.isPending) return <p>{t('加载中…')}</p>
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
          toast.success(t('品牌已保存'))
        } catch (err) {
          toast.error((err as Error).message)
        } finally {
          setBusy(false)
        }
      }}
    >
      <h2 className='text-lg font-semibold'>{t('网站品牌')}</h2>
      <p className='text-sm text-muted-foreground'>
        {t('品牌名称、Logo 与网站图标统一应用于登录页和管理台。')}
      </p>
      {(
        [
          ['name', '品牌名称'],
          ['tagline', '副标题'],
        ] as const
      ).map(([key, label]) => (
        <FormField key={key}>
          {t(label)}
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
          ['logo_url', 'Logo 地址'],
          ['favicon_url', '网站图标地址'],
        ] as const
      ).map(([key, label]) => (
        <section key={key} className='space-y-2'>
          <FormField>
            {t(label)}
            <Input
              value={form[key].startsWith('data:') ? '' : form[key]}
              placeholder={
                form[key].startsWith('data:') ? t('上传图片') : 'https://…'
              }
              onChange={(e) => setDraft({ ...form, [key]: e.target.value })}
            />
          </FormField>
          <Input
            aria-label={`${t('上传图片')} · ${t(label)}`}
            type='file'
            accept='image/png,image/jpeg,image/webp'
            onChange={(e) => void upload(e.target.files?.[0], key)}
          />
          {form[key] && (
            <img
              src={form[key]}
              alt={t(label)}
              className='size-16 rounded border object-contain'
            />
          )}
          {form[key] && (
            <Button
              type='button'
              variant='ghost'
              onClick={() => setDraft({ ...form, [key]: '' })}
            >
              {t('移除图片')}
            </Button>
          )}
        </section>
      ))}
      <p className='text-xs text-muted-foreground'>
        {t('支持 PNG、JPEG、WebP，最大 256 KB；留空使用默认图标。')}
      </p>
      <div className='flex gap-2'>
        <Button disabled={busy || !draft}>{t('保存')}</Button>
        <Button
          type='button'
          variant='outline'
          onClick={() => setDraft({ ...DEFAULT_BRANDING })}
        >
          {t('恢复默认')}
        </Button>
      </div>
    </form>
  )
}
