import type { PolicyPrice } from '@/types/panel-pricing'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { ModelVendorIcon } from '@/components/model-vendor-icon'
import { Fact } from './model-parts'
import type { ImageToolModel } from './policy'
import {
  fmtImageRates,
  fmtOpenaiRates,
  priceSourceLabel,
} from './price-display'

type Props = {
  models: ImageToolModel[]
  /** Draft switches; a model missing here shows its saved state. */
  enabled: Record<string, { enabled: boolean }> | undefined
  pricing: Record<string, PolicyPrice | null> | undefined
  onToggle: (id: string, on: boolean) => void
}

export function ImageToolSection({
  models,
  enabled,
  pricing,
  onToggle,
}: Props) {
  const { t } = useTranslation('models')
  if (!models.length) return null
  return (
    <section className='space-y-3 rounded-2xl border border-border/70 bg-card p-4 shadow-sm'>
      <div className='max-w-3xl space-y-1'>
        <h3 className='font-semibold'>{t('models:imageModels')}</h3>
        <p className='text-sm leading-6 text-muted-foreground'>
          {t('models:imageHelp')}
        </p>
      </div>
      <div className='grid gap-3 md:grid-cols-2'>
        {models.map((m) => {
          const on = enabled?.[m.id]?.enabled ?? m.enabled
          const price = pricing?.[m.id]
          return (
            <div
              key={m.id}
              className='flex gap-3 rounded-xl border border-border/70 bg-background/60 p-3 text-sm'
            >
              <div className='mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg bg-muted/70 ring-1 ring-border/60'>
                <ModelVendorIcon modelId={m.id} className='size-5' />
              </div>
              <div className='min-w-0 flex-1 space-y-2'>
                <div className='flex flex-wrap items-center gap-2'>
                  <h4 className='truncate font-semibold'>{m.display_name}</h4>
                  <Badge variant='outline'>{t('models:image')}</Badge>
                  {m.upstream_default ? (
                    <Badge variant='secondary'>
                      {t('models:upstreamDefault')}
                    </Badge>
                  ) : null}
                  {on ? null : (
                    <Badge variant='outline'>{t('models:disabled')}</Badge>
                  )}
                </div>
                <p className='truncate font-mono text-[11px] text-muted-foreground'>
                  {m.id}
                  {m.snapshots.length ? ` · ${m.snapshots.join(', ')}` : ''}
                </p>
                <div className='space-y-1'>
                  <Fact
                    label={t('models:textRates')}
                    value={`${fmtOpenaiRates(price?.effective)} / 1M`}
                    mono
                  />
                  <Fact
                    label={t('models:imageRates')}
                    value={`${fmtImageRates(price?.effective)} / 1M`}
                    mono
                  />
                  <Fact
                    label={t('models:priceSource')}
                    value={priceSourceLabel(price?.source)}
                  />
                </div>
              </div>
              <div className='flex shrink-0 flex-col items-end gap-1'>
                <Switch
                  checked={on}
                  onCheckedChange={(next) => onToggle(m.id, next)}
                  aria-label={t('models:enableModel', { name: m.display_name })}
                />
                <span className='text-xs text-muted-foreground'>
                  {on ? t('models:enabled') : t('models:disabled')}
                </span>
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
