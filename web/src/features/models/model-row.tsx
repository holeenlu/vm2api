import type { PolicyPrice } from '@/types/panel-pricing'
import { BadgeDollarSign, Gauge, SlidersHorizontal } from 'lucide-react'
import { useTranslation, Trans } from 'react-i18next'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { ModelVendorIcon } from '@/components/model-vendor-icon'
import { EditorRow, Fact, Metric, Panel } from './model-parts'
import {
  OpenaiCapabilityFacts,
  OpenaiCardMetrics,
  OpenaiPriceFacts,
} from './openai-model-parts'
import {
  type ModelEntry,
  type ModelParams,
  type ModelPolicy,
  type Pass1mMode,
  catalogFacts,
  contextWindowLabel,
  passContext1mEffective,
  passContext1mMode,
  thinkingPolicyLabel,
} from './policy'
import {
  fmtBaseRates,
  fmtOpenaiRates,
  fmtPerM,
  priceSourceLabel,
  priceSourceVariant,
} from './price-display'

type Props = {
  model: ModelEntry
  live: boolean
  pol: ModelPolicy
  pricing?: PolicyPrice | null
  open: boolean
  platform: 'anthropic' | 'openai'
  onToggleOpen: () => void
  onToggleEnabled: (on: boolean) => void
  onModel: (fn: (rec: Omit<ModelEntry, 'id'>) => void) => void
  onParam: (key: keyof ModelParams, value: string | number) => void
  onPass1m: (mode: Pass1mMode) => void
}

export function ModelRow({
  model,
  live,
  pol,
  pricing,
  open,
  platform,
  onToggleOpen,
  onToggleEnabled,
  onModel,
  onParam,
  onPass1m,
}: Props) {
  const { t } = useTranslation('models')

  const on = model.enabled !== false
  const win = contextWindowLabel(model)
  const caps = model.capabilities || {}
  const params = model.params || {}
  const defs = pol.defaults || {}
  const mode = passContext1mMode(model)
  const effective = passContext1mEffective(model, pol)
  const inheritHit = mode === 'inherit' && effective
  const drop = (model.betas?.drop || []).join(', ') || '—'
  const onEnabled =
    params.on_enabled === 'convert_to_adaptive'
      ? 'passthrough'
      : params.on_enabled || 'passthrough'
  const fallback =
    params.thinking_fallback_budget != null
      ? params.thinking_fallback_budget
      : defs.thinking_fallback_budget || 4096
  const displayName = model.display_name || model.id
  const price = pricing?.effective ?? null
  const priceSource = pricing?.source ?? null
  // GPT rows show upstream catalog facts; Claude thinking / max_tokens / 1M knobs do not apply.
  const claude = platform === 'anthropic'
  const facts = claude ? null : catalogFacts(model)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next !== open) onToggleOpen()
      }}
    >
      <div
        className={cn(
          'group rounded-xl border border-border/70 bg-card p-3 text-sm shadow-sm transition-[border-color,box-shadow,transform,background-color] duration-200 hover:-translate-y-0.5 hover:border-primary/35 hover:bg-muted/15 hover:shadow-md',
          !on && 'opacity-65'
        )}
      >
        <div
          role='button'
          tabIndex={0}
          className='grid gap-3 outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:grid-cols-[minmax(0,1fr)_auto]'
          onClick={onToggleOpen}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            onToggleOpen()
          }}
        >
          <div className='min-w-0 space-y-3'>
            <div className='flex items-start gap-3'>
              <div className='mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg bg-muted/70 ring-1 ring-border/60'>
                <ModelVendorIcon modelId={model.id} className='size-5' />
              </div>
              <div className='min-w-0 flex-1'>
                <div className='flex flex-wrap items-center gap-2'>
                  <h3 className='truncate text-base font-semibold tracking-tight'>
                    {displayName}
                  </h3>
                  <Badge variant={live ? 'default' : 'secondary'}>
                    {live ? t('models:public') : t('models:hidden')}
                  </Badge>
                  {on ? null : (
                    <Badge variant='outline'>{t('models:disabled')}</Badge>
                  )}
                </div>
                <p className='mt-1 truncate font-mono text-[11px] text-muted-foreground'>
                  {model.id}
                </p>
                <div className='mt-1.5 flex flex-wrap items-center gap-1.5'>
                  <span className='font-mono text-xs tabular-nums'>
                    {claude ? fmtBaseRates(price) : fmtOpenaiRates(price)}
                  </span>
                  <span className='text-[10px] text-muted-foreground'>
                    {t('models:perMillion')}
                  </span>
                  <Badge variant={priceSourceVariant(priceSource)}>
                    {priceSourceLabel(priceSource)}
                  </Badge>
                </div>
              </div>
            </div>

            {facts ? (
              <OpenaiCardMetrics facts={facts} />
            ) : (
              <div className='grid gap-2 text-xs sm:grid-cols-3'>
                <Metric label={t('models:context')} value={win.text} strong />
                <Metric
                  label={t('models:outputCap')}
                  value={`${formatK(params.max_tokens_cap ?? 64000)}`}
                />
                <Metric
                  label={t('models:thinking')}
                  value={thinkingPolicyLabel(model)}
                />
              </div>
            )}

            {claude ? (
              <div className='flex flex-wrap gap-1.5'>
                {(model.aliases || []).slice(0, 4).map((alias) => (
                  <Badge key={alias} variant='outline' className='font-mono'>
                    {alias}
                  </Badge>
                ))}
                {(model.aliases || []).length > 4 ? (
                  <Badge variant='secondary'>
                    +{(model.aliases || []).length - 4}
                  </Badge>
                ) : null}
                {!(model.aliases || []).length ? (
                  <span className='text-xs text-muted-foreground'>
                    {t('models:noAliases')}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className='flex items-center justify-between gap-3 sm:w-32 sm:flex-col sm:items-end'>
            <div
              className='flex items-center gap-2 rounded-lg border border-border/60 bg-background/70 px-2 py-1.5'
              onClick={(event) => event.stopPropagation()}
            >
              <Checkbox
                checked={on}
                onCheckedChange={(value) => onToggleEnabled(value === true)}
                aria-label={t('models:enableModel', { name: displayName })}
              />
              <span className='text-xs text-muted-foreground'>
                {t('models:enabled')}
              </span>
            </div>
            <Button size='sm' variant='outline' className='gap-1.5'>
              <SlidersHorizontal className='size-3.5' />
              {t('models:configure')}
            </Button>
          </div>
        </div>
      </div>

      <DialogContent className='max-h-[min(92svh,760px)] overflow-y-auto sm:max-w-3xl'>
        <DialogHeader className='gap-3'>
          <div className='flex items-start gap-3'>
            <div className='grid size-11 shrink-0 place-items-center rounded-xl bg-muted ring-1 ring-border/70'>
              <ModelVendorIcon modelId={model.id} className='size-6' />
            </div>
            <div className='min-w-0'>
              <DialogTitle className='truncate text-xl'>
                {displayName}
              </DialogTitle>
              <DialogDescription className='font-mono text-xs break-all'>
                {model.id}
              </DialogDescription>
              {facts?.description ? (
                <p className='mt-1 text-xs leading-5 text-muted-foreground'>
                  {facts.description}
                </p>
              ) : null}
            </div>
          </div>
        </DialogHeader>

        <div className='grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]'>
          <section className='space-y-4'>
            <Panel
              title={claude ? t('models:modelOverrides') : t('models:catalog')}
              icon={<SlidersHorizontal className='size-4' />}
            >
              <EditorRow label={t('models:publicEnabled')}>
                <div className='flex items-center gap-2'>
                  <Checkbox
                    checked={on}
                    onCheckedChange={(value) => onToggleEnabled(value === true)}
                    aria-label={t('models:publicEnabled')}
                  />
                  <span className='text-xs text-muted-foreground'>
                    {t('models:publicEnabledHint')}
                  </span>
                </div>
              </EditorRow>
              {claude ? (
                <>
                  <EditorRow label={t('models:contextWindow')}>
                    <NumberInput
                      value={Number(caps.context_window || 0)}
                      onChange={(value) =>
                        onModel((rec) => {
                          rec.capabilities = {
                            ...(rec.capabilities || {}),
                            context_window: value,
                          }
                        })
                      }
                    />
                    <span className='text-xs text-muted-foreground'>token</span>
                  </EditorRow>
                  <div className='space-y-2'>
                    <span className='text-xs font-medium text-muted-foreground'>
                      {t('models:aliases')}
                    </span>
                    <Textarea
                      className='min-h-24 font-mono text-xs'
                      value={(model.aliases || []).join('\n')}
                      placeholder={t('models:aliasesPlaceholder')}
                      onChange={(event) =>
                        onModel((rec) => {
                          rec.aliases = splitList(event.target.value)
                        })
                      }
                    />
                  </div>
                </>
              ) : (
                <p className='text-xs leading-5 text-muted-foreground'>
                  {t('models:catalogHelp')}
                </p>
              )}
            </Panel>

            {claude ? (
              <Panel
                title={t('models:modelParameters')}
                icon={<Gauge className='size-4' />}
              >
                <EditorRow label={t('models:maxTokensDefault')}>
                  <NumberInput
                    value={params.max_tokens_default ?? 8192}
                    onChange={(value) => onParam('max_tokens_default', value)}
                  />
                </EditorRow>
                <EditorRow label={t('models:maxTokensCap')}>
                  <NumberInput
                    value={params.max_tokens_cap ?? 64000}
                    onChange={(value) => onParam('max_tokens_cap', value)}
                  />
                </EditorRow>
                <EditorRow label={t('models:fallbackBudget')}>
                  <NumberInput
                    value={fallback}
                    onChange={(value) =>
                      onParam('thinking_fallback_budget', value)
                    }
                  />
                </EditorRow>
                <EditorRow
                  label={
                    /* i18n-exempt "adaptive" -- Anthropic thinking mode wire value, displayed for protocol inspection. */ 'adaptive'
                  }
                >
                  <Select
                    value={params.on_adaptive || 'passthrough'}
                    onValueChange={(value) => onParam('on_adaptive', value)}
                  >
                    <SelectTrigger className='h-8 w-full sm:w-[220px]'>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value='passthrough'>
                        {t('models:passthrough')}
                      </SelectItem>
                      <SelectItem value='convert_to_enabled'>
                        {t('models:convertToEnabled')}
                      </SelectItem>
                      <SelectItem value='strip'>
                        {t('models:stripThinking')}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </EditorRow>
                <EditorRow
                  label={
                    /* i18n-exempt "enabled" -- Anthropic thinking mode wire value, displayed for protocol inspection. */ 'enabled'
                  }
                >
                  <Select
                    value={onEnabled}
                    onValueChange={(value) => onParam('on_enabled', value)}
                  >
                    <SelectTrigger className='h-8 w-full sm:w-[220px]'>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value='passthrough'>
                        {t('models:passthrough')}
                      </SelectItem>
                      <SelectItem value='strip'>
                        {t('models:stripThinking')}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </EditorRow>
              </Panel>
            ) : null}
          </section>

          <aside className='space-y-4'>
            {claude ? (
              <Panel
                title={t('models:officialBeta')}
                icon={<Gauge className='size-4' />}
                compact
              >
                <Select
                  value={mode}
                  onValueChange={(value) => {
                    if (
                      value === 'true' ||
                      value === 'false' ||
                      value === 'inherit'
                    ) {
                      onPass1m(value)
                    }
                  }}
                >
                  <SelectTrigger
                    className={cn('h-9 w-full', inheritHit && 'text-primary')}
                    title={
                      inheritHit
                        ? t('models:wildcardMatched')
                        : mode === 'true'
                          ? t('models:policyPass')
                          : mode === 'false'
                            ? t('models:policyStrip')
                            : t('models:wildcardFallback')
                    }
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='true'>
                      {t('models:pass1mBeta')}
                    </SelectItem>
                    <SelectItem value='false'>
                      {t('models:strip1mBeta')}
                    </SelectItem>
                    <SelectItem value='inherit'>
                      {effective
                        ? t('models:wildcardPass')
                        : t('models:wildcardStrip')}
                    </SelectItem>
                  </SelectContent>
                </Select>
                <p className='text-xs text-muted-foreground'>
                  <Trans
                    t={t}
                    i18nKey='models:betaDrop'
                    values={{ drop }}
                    components={{ value: <span className='font-mono' /> }}
                  />
                </p>
              </Panel>
            ) : null}

            <Panel
              title={t('models:priceBilling')}
              icon={<BadgeDollarSign className='size-4' />}
              compact
            >
              {claude ? (
                <>
                  <Fact
                    label={t('models:source')}
                    value={priceSourceLabel(priceSource)}
                  />
                  <Fact
                    label={t('models:baseRateLabel')}
                    value={`${fmtBaseRates(price)} / 1M`}
                    mono
                  />
                  {price ? (
                    <Fact
                      label={t('models:cacheWriteLabel')}
                      value={`${fmtPerM(price.cache_5m)} / ${fmtPerM(price.cache_1h)}`}
                      mono
                    />
                  ) : null}
                </>
              ) : (
                <OpenaiPriceFacts price={price} source={priceSource} />
              )}
            </Panel>

            <Panel
              title={t('models:capabilities')}
              icon={<Gauge className='size-4' />}
              compact
            >
              {facts ? (
                <OpenaiCapabilityFacts facts={facts} live={live} />
              ) : (
                <>
                  <Fact label={t('models:context')} value={win.text} />
                  <Fact
                    label={t('models:thinking')}
                    value={thinkingPolicyLabel(model)}
                  />
                  <Fact
                    label={t('models:catalogStatus')}
                    value={
                      live
                        ? t('models:publicVisible')
                        : t('models:notInCatalog')
                    }
                  />
                </>
              )}
            </Panel>
          </aside>
        </div>

        <DialogFooter className='items-center gap-2 sm:justify-between'>
          <p className='text-xs text-muted-foreground'>
            {t('models:dialogSaveHint')}
          </p>
          <DialogClose asChild>
            <Button type='button' variant='outline'>
              {t('models:done')}
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function NumberInput({
  value,
  onChange,
}: {
  value: number
  onChange: (value: number) => void
}) {
  useTranslation('models')

  return (
    <Input
      className='field-count h-8 w-full sm:w-[150px]'
      type='number'
      min={0}
      value={value}
      onChange={(event) => onChange(Number(event.target.value) || 0)}
    />
  )
}

function splitList(value: string): string[] {
  return value
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function formatK(value: number): string {
  if (value >= 1_000_000) return `${Math.floor(value / 1_000_000)}M`
  if (value >= 1000) return `${Math.floor(value / 1000)}K`
  return String(value)
}
