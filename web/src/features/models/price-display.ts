import { t } from '@/i18n'
import type { Price, PriceSource } from '@/types/panel-pricing'
import { fmtUsd } from '@/lib/format'

const PRICE_SOURCE_KEYS: Record<PriceSource, string> = {
  override: 'models:override',
  'models.dev': 'models:modelsDevName',
  builtin: 'models:builtin',
}

export function priceSourceLabel(
  source: PriceSource | null | undefined
): string {
  if (!source) return t('models:unpriced')
  return t(PRICE_SOURCE_KEYS[source])
}

export function priceSourceVariant(
  source: PriceSource | null | undefined
): 'default' | 'secondary' | 'outline' {
  if (source === 'override') return 'default'
  if (source === 'models.dev') return 'secondary'
  return 'outline'
}

export function fmtPerM(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return fmtUsd(n, Math.abs(n) >= 1 ? 2 : 3)
}

/** input / output / cache read per 1M. */
export function fmtBaseRates(price: Price | null | undefined): string {
  if (!price) return t('models:unpriced')
  return [
    fmtPerM(price.input),
    fmtPerM(price.output),
    fmtPerM(price.cache_read),
  ].join(' / ')
}

export function cacheFillHint(
  platform: 'anthropic' | 'openai',
  field: 'cache_5m' | 'cache_1h',
  input: string
): string {
  const n = Number(input)
  const has = input.trim() !== '' && Number.isFinite(n) && n >= 0
  if (platform === 'anthropic') {
    if (field === 'cache_5m') {
      return has
        ? t('models:cacheDefaultValue', {
            price: fmtPerM(n * 1.25),
            multiplier: 1.25,
          })
        : t('models:cache5mDefault')
    }
    return has
      ? t('models:cacheDefaultValue', { price: fmtPerM(n * 2), multiplier: 2 })
      : t('models:cache1hDefault')
  }
  if (field === 'cache_5m') return t('models:noCacheWrite')
  return t('models:cache1hSameAs5m')
}

export function tiersSummary(price: Price | null | undefined): string {
  const tiers = price?.tiers
  if (!tiers?.length) return '—'
  return tiers
    .map((tier) => {
      const above =
        tier.above >= 1000
          ? `>${Math.round(tier.above / 1000)}k`
          : `>${tier.above}`
      if ('unpriced' in tier && tier.unpriced)
        return t('models:unpricedTier', { above })
      return above
    })
    .join(' · ')
}

export function modeKeys(
  price: Price | null | undefined
): Array<'fast' | 'flex' | 'priority'> {
  if (!price?.modes) return []
  return (['fast', 'flex', 'priority'] as const).filter((k) => price.modes?.[k])
}
