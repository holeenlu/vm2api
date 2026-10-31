import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { t } from '@/i18n'
import type { Price, PricingEntry } from '@/types/panel-pricing'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cacheFillHint } from '@/features/models/price-display'
import { invalidatePricing } from '@/features/models/queries'

type ModeKey = 'fast' | 'flex' | 'priority'

type FieldDraft = {
  input: string
  output: string
  cache_read: string
  cache_5m: string
  cache_1h: string
}

type TierDraft = FieldDraft & { above: string; unpriced: boolean }

type ImageDraft = { input: string; output: string; cache_read: string }

type Draft = FieldDraft & {
  tiers: TierDraft[]
  modes: Partial<Record<ModeKey, FieldDraft | null>>
  /** GPT Image token band; null when the model has none. */
  image: ImageDraft | null
}

/** Anthropic prices `fast`; OpenAI service tiers are flex / priority. */
const PLATFORM_MODES: Record<'anthropic' | 'openai', ModeKey[]> = {
  anthropic: ['fast'],
  openai: ['flex', 'priority'],
}

const MODE_LABEL: Record<ModeKey, string> = {
  fast: /* i18n-exempt "fast" -- OpenAI service_tier wire identifier; price mode keys are not translated. */ 'fast',
  flex: /* i18n-exempt "flex" -- OpenAI service_tier wire identifier; price mode keys are not translated. */ 'flex',
  priority:
    /* i18n-exempt "priority" -- OpenAI service_tier wire identifier; price mode keys are not translated. */ 'priority',
}

function emptyFields(): FieldDraft {
  return { input: '', output: '', cache_read: '', cache_5m: '', cache_1h: '' }
}

function fromPrice(price: Price | null | undefined): FieldDraft {
  if (!price) return emptyFields()
  return {
    input: String(price.input),
    output: String(price.output),
    cache_read: String(price.cache_read),
    cache_5m: price.cache_5m == null ? '' : String(price.cache_5m),
    cache_1h: price.cache_1h == null ? '' : String(price.cache_1h),
  }
}

function fromImage(price: Price | null | undefined): ImageDraft | null {
  if (!price?.image) return null
  return {
    input: String(price.image.input),
    output: String(price.image.output),
    cache_read: String(price.image.cache_read),
  }
}

function fromEntry(entry: PricingEntry): Draft {
  const src = entry.override ?? entry.effective
  const modes: Draft['modes'] = {}
  for (const key of ['fast', 'flex', 'priority'] as const) {
    const mode = src?.modes?.[key]
    modes[key] = mode ? fromPrice(mode) : null
  }
  return {
    ...fromPrice(src),
    tiers: (src?.tiers || []).map((tier) => {
      if ('unpriced' in tier) {
        return {
          ...emptyFields(),
          above: String(tier.above),
          unpriced: true,
        }
      }
      return {
        input: String(tier.input),
        output: String(tier.output),
        cache_read: String(tier.cache_read),
        cache_5m: String(tier.cache_5m),
        cache_1h: String(tier.cache_1h),
        above: String(tier.above),
        unpriced: false,
      }
    }),
    modes,
    image: fromImage(src) || fromImage(entry.effective),
  }
}

function parseReq(raw: string, label: string): number | { error: string } {
  const trimmed = raw.trim()
  if (!trimmed) return { error: t('models:fieldRequired', { label }) }
  const n = Number(trimmed)
  if (!Number.isFinite(n) || n < 0)
    return { error: t('models:fieldNonnegative', { label }) }
  return n
}

function parseOpt(
  raw: string,
  label: string
): number | undefined | { error: string } {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  const n = Number(trimmed)
  if (!Number.isFinite(n) || n < 0) {
    return { error: t('models:fieldNonnegative', { label }) }
  }
  return n
}

/** PUT 体：cache_5m / cache_1h 可省略，交给服务端按平台补全。 */
type OverridePrice = {
  input: number
  output: number
  cache_read: number
  cache_5m?: number
  cache_1h?: number
  tiers?: Array<
    { above: number; unpriced: true } | (OverridePrice & { above: number })
  >
  modes?: {
    fast?: OverridePrice
    flex?: OverridePrice
    priority?: OverridePrice
  }
  image?: { input: number; output: number; cache_read: number }
}

function assembleFields(
  d: FieldDraft,
  context: { tier?: number; mode?: ModeKey }
): OverridePrice | { error: string } {
  const label = (field: keyof FieldDraft) =>
    context.tier != null
      ? t('models:tierField', { tier: context.tier, field })
      : context.mode
        ? t('models:modeField', { mode: context.mode, field })
        : field
  const input = parseReq(d.input, label('input'))
  if (typeof input === 'object') return input
  const output = parseReq(d.output, label('output'))
  if (typeof output === 'object') return output
  const cache_read = parseReq(d.cache_read, label('cache_read'))
  if (typeof cache_read === 'object') return cache_read
  const cache_5m = parseOpt(d.cache_5m, label('cache_5m'))
  if (typeof cache_5m === 'object') return cache_5m
  const cache_1h = parseOpt(d.cache_1h, label('cache_1h'))
  if (typeof cache_1h === 'object') return cache_1h
  const price: OverridePrice = { input, output, cache_read }
  if (cache_5m != null) price.cache_5m = cache_5m
  if (cache_1h != null) price.cache_1h = cache_1h
  return price
}

function assemblePrice(d: Draft): OverridePrice | { error: string } {
  const base = assembleFields(d, {})
  if ('error' in base) return base
  if (d.tiers.length) {
    const tiers: NonNullable<OverridePrice['tiers']> = []
    for (const [i, tier] of d.tiers.entries()) {
      const above = parseReq(
        tier.above,
        t('models:tierField', { tier: i + 1, field: 'above' })
      )
      if (typeof above === 'object') return above
      if (tier.unpriced) {
        tiers.push({ above, unpriced: true })
        continue
      }
      const body = assembleFields(tier, { tier: i + 1 })
      if ('error' in body) return body
      tiers.push({ above, ...body })
    }
    base.tiers = tiers
  }
  const modes: NonNullable<OverridePrice['modes']> = {}
  for (const key of ['fast', 'flex', 'priority'] as const) {
    const mode = d.modes[key]
    if (!mode) continue
    const body = assembleFields(mode, { mode: key })
    if ('error' in body) return body
    modes[key] = body
  }
  if (Object.keys(modes).length) base.modes = modes
  if (d.image) {
    const filled = [d.image.input, d.image.output, d.image.cache_read].some(
      (v) => v.trim() !== ''
    )
    // All blank: the server keeps the builtin image band for this model.
    if (filled) {
      const input = parseReq(d.image.input, t('models:imageInput'))
      if (typeof input === 'object') return input
      const cache_read = parseReq(
        d.image.cache_read,
        t('models:imageCachedInput')
      )
      if (typeof cache_read === 'object') return cache_read
      const output = parseReq(d.image.output, t('models:imageOutput'))
      if (typeof output === 'object') return output
      base.image = { input, output, cache_read }
    }
  }
  return base
}

function FieldGrid({
  value,
  onChange,
  platform,
  idPrefix,
}: {
  value: FieldDraft
  onChange: (next: FieldDraft) => void
  platform: 'anthropic' | 'openai'
  idPrefix: string
}) {
  const { t } = useTranslation('models')

  const openai = platform === 'openai'
  function set(key: keyof FieldDraft, raw: string) {
    // OpenAI has one cache-write rate; keep both stored fields equal.
    if (openai && key === 'cache_5m') {
      onChange({ ...value, cache_5m: raw, cache_1h: raw })
      return
    }
    onChange({ ...value, [key]: raw })
  }
  const fields = openai
    ? ([
        ['input', t('models:inputPrice'), true],
        ['cache_read', t('models:cachedInput'), true],
        ['output', t('models:outputPrice'), true],
        ['cache_5m', t('models:cacheWrite'), false],
      ] as const)
    : ([
        ['input', t('models:inputPrice'), true],
        ['output', t('models:outputPrice'), true],
        ['cache_read', t('models:cacheReadPrice'), true],
        ['cache_5m', t('models:cache5mPrice'), false],
        ['cache_1h', t('models:cache1hPrice'), false],
      ] as const)
  return (
    <div
      className={cn('grid gap-2', openai ? 'sm:grid-cols-4' : 'sm:grid-cols-5')}
    >
      {fields.map(([key, label, required]) => (
        <div key={key} className='space-y-1'>
          <Label htmlFor={`${idPrefix}-${key}`} className='text-xs'>
            {required ? label : t('models:optionalField', { label })}
          </Label>
          <Input
            id={`${idPrefix}-${key}`}
            inputMode='decimal'
            value={value[key]}
            placeholder={
              openai && key === 'cache_5m'
                ? t('models:defaultZero')
                : key === 'cache_5m' || key === 'cache_1h'
                  ? cacheFillHint(platform, key, value.input)
                  : undefined
            }
            onChange={(e) => set(key, e.target.value)}
          />
        </div>
      ))}
    </div>
  )
}

export function PriceOverrideDialog({
  entry,
  open,
  onOpenChange,
}: {
  entry: PricingEntry | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation('models')

  const qc = useQueryClient()
  const [draft, setDraft] = useState<Draft>(() =>
    entry
      ? fromEntry(entry)
      : { ...emptyFields(), tiers: [], modes: {}, image: null }
  )

  useEffect(() => {
    if (open && entry) setDraft(fromEntry(entry))
  }, [open, entry])

  const key =
    entry?.override_key || (entry ? `${entry.platform}/${entry.id}` : '')

  const save = useMutation({
    mutationFn: (price: OverridePrice) =>
      api('/api/panel/pricing/overrides', {
        method: 'PUT',
        body: JSON.stringify({ key, price }),
      }),
    onSuccess: async () => {
      toast.success(t('models:overrideSaved'))
      await invalidatePricing(qc)
      onOpenChange(false)
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const reset = useMutation({
    mutationFn: () =>
      api('/api/panel/pricing/overrides', {
        method: 'PUT',
        body: JSON.stringify({ key, price: null }),
      }),
    onSuccess: async () => {
      toast.success(t('models:overrideCleared'))
      await invalidatePricing(qc)
      onOpenChange(false)
    },
    onError: (error: Error) => toast.error(error.message),
  })

  if (!entry) return null
  const platform = entry.platform

  function submit() {
    const price = assemblePrice(draft)
    if ('error' in price) {
      toast.error(price.error)
      return
    }
    save.mutate(price)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-h-[min(92svh,760px)] overflow-y-auto sm:max-w-3xl'>
        <DialogHeader>
          <DialogTitle>
            {t('models:overrideTitle', { model: entry.id })}
          </DialogTitle>
          <DialogDescription>
            {t(
              platform === 'openai'
                ? 'models:openaiOverrideDescription'
                : 'models:overrideDescription',
              { key }
            )}
          </DialogDescription>
        </DialogHeader>

        <div className='space-y-5'>
          <section className='space-y-2'>
            <h4 className='text-sm font-medium'>{t('models:basePrice')}</h4>
            <FieldGrid
              idPrefix='base'
              platform={platform}
              value={draft}
              onChange={(next) => setDraft({ ...draft, ...next })}
            />
          </section>

          <section className='space-y-2'>
            <div className='flex items-center justify-between gap-2'>
              <h4 className='text-sm font-medium'>
                {t('models:contextTiers')}
              </h4>
              <Button
                type='button'
                size='sm'
                variant='outline'
                onClick={() =>
                  setDraft({
                    ...draft,
                    tiers: [
                      ...draft.tiers,
                      { ...emptyFields(), above: '', unpriced: false },
                    ],
                  })
                }
              >
                {t('models:addTier')}
              </Button>
            </div>
            {draft.tiers.length === 0 ? (
              <p className='text-xs text-muted-foreground'>
                {t('models:tierHint')}
              </p>
            ) : (
              <div className='space-y-3'>
                {draft.tiers.map((tier, i) => (
                  <div
                    key={i}
                    className='space-y-2 rounded-lg border border-border/70 p-3'
                  >
                    <div className='flex flex-wrap items-center gap-3'>
                      <Label className='text-xs' htmlFor={`tier-${i}-above`}>
                        {t('common:pricingThreshold')}
                      </Label>
                      <Input
                        id={`tier-${i}-above`}
                        className='w-32'
                        inputMode='numeric'
                        value={tier.above}
                        placeholder='200000'
                        onChange={(e) => {
                          const tiers = draft.tiers.slice()
                          tiers[i] = { ...tier, above: e.target.value }
                          setDraft({ ...draft, tiers })
                        }}
                      />
                      <label className='flex items-center gap-2 text-xs'>
                        <Checkbox
                          checked={tier.unpriced}
                          onCheckedChange={(v) => {
                            const tiers = draft.tiers.slice()
                            tiers[i] = { ...tier, unpriced: v === true }
                            setDraft({ ...draft, tiers })
                          }}
                        />
                        {t('models:tierUnpriced')}
                      </label>
                      <Button
                        type='button'
                        size='sm'
                        variant='ghost'
                        className='ms-auto'
                        onClick={() =>
                          setDraft({
                            ...draft,
                            tiers: draft.tiers.filter((_, j) => j !== i),
                          })
                        }
                      >
                        {t('models:delete')}
                      </Button>
                    </div>
                    {tier.unpriced ? null : (
                      <FieldGrid
                        idPrefix={`tier-${i}`}
                        platform={platform}
                        value={tier}
                        onChange={(next) => {
                          const tiers = draft.tiers.slice()
                          tiers[i] = { ...tier, ...next }
                          setDraft({ ...draft, tiers })
                        }}
                      />
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className='space-y-3'>
            <h4 className='text-sm font-medium'>
              {platform === 'openai'
                ? t('models:openaiModePrices')
                : t('models:claudeModePrices')}
            </h4>
            {(['fast', 'flex', 'priority'] as const)
              // An existing price for the other platform's mode stays visible so it is not lost.
              .filter(
                (mode) =>
                  PLATFORM_MODES[platform].includes(mode) || draft.modes[mode]
              )
              .map((mode) => {
                const modeDraft = draft.modes[mode]
                return (
                  <div key={mode} className='space-y-2'>
                    <label className='flex items-center gap-2 text-sm'>
                      <Checkbox
                        checked={Boolean(modeDraft)}
                        onCheckedChange={(v) =>
                          setDraft({
                            ...draft,
                            modes: {
                              ...draft.modes,
                              [mode]: v === true ? emptyFields() : null,
                            },
                          })
                        }
                      />
                      {MODE_LABEL[mode]}
                    </label>
                    {modeDraft ? (
                      <FieldGrid
                        idPrefix={mode}
                        platform={platform}
                        value={modeDraft}
                        onChange={(next) =>
                          setDraft({
                            ...draft,
                            modes: { ...draft.modes, [mode]: next },
                          })
                        }
                      />
                    ) : null}
                  </div>
                )
              })}
          </section>

          {draft.image ? (
            <section className='space-y-2'>
              <h4 className='text-sm font-medium'>{t('models:imageTokens')}</h4>
              <p className='text-xs text-muted-foreground'>
                {t('models:imagePriceHelp')}
              </p>
              <div className='grid gap-2 sm:grid-cols-3'>
                {(
                  [
                    ['input', t('models:inputPrice')],
                    ['cache_read', t('models:cachedInput')],
                    ['output', t('models:outputPrice')],
                  ] as const
                ).map(([field, label]) => (
                  <div key={field} className='space-y-1'>
                    <Label htmlFor={`image-${field}`} className='text-xs'>
                      {label}
                    </Label>
                    <Input
                      id={`image-${field}`}
                      inputMode='decimal'
                      value={draft.image?.[field] ?? ''}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          image: {
                            ...(draft.image as ImageDraft),
                            [field]: e.target.value,
                          },
                        })
                      }
                    />
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </div>

        <DialogFooter className='gap-2 sm:justify-between'>
          <Button
            type='button'
            variant='outline'
            disabled={!entry.override || reset.isPending}
            onClick={() => reset.mutate()}
          >
            {reset.isPending ? t('models:clearing') : t('models:resetOverride')}
          </Button>
          <div className='flex gap-2'>
            <Button
              type='button'
              variant='outline'
              onClick={() => onOpenChange(false)}
            >
              {t('models:cancel')}
            </Button>
            <Button type='button' disabled={save.isPending} onClick={submit}>
              {save.isPending ? t('models:saving') : t('models:saveOverride')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
