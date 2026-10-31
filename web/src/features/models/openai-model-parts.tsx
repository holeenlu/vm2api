import type { Price, PriceSource } from '@/types/panel-pricing'
import { useTranslation } from 'react-i18next'
import { fmtAgo } from '@/lib/format'
import { Fact, Metric } from './model-parts'
import type { CatalogFacts } from './policy'
import {
  fmtOpenaiRates,
  fmtPerM,
  openaiServiceModes,
  priceSourceLabel,
  tiersSummary,
} from './price-display'

/** Card metrics for a GPT model: upstream catalog facts, not Claude thinking / max_tokens knobs. */
export function OpenaiCardMetrics({ facts }: { facts: CatalogFacts }) {
  const { t } = useTranslation('models')
  return (
    <div className='grid gap-2 text-xs sm:grid-cols-3'>
      <Metric label={t('models:context')} value={facts.context} strong />
      <Metric label={t('models:reasoning')} value={facts.defaultEffort} />
      <Metric label={t('models:tiers')} value={facts.tierNames} />
    </div>
  )
}

export function OpenaiPriceFacts({
  price,
  source,
}: {
  price: Price | null
  source: PriceSource | null
}) {
  const { t } = useTranslation('models')
  const modes = openaiServiceModes(price)
  return (
    <>
      <Fact label={t('models:source')} value={priceSourceLabel(source)} />
      <Fact
        label={t('models:openaiRateLabel')}
        value={`${fmtOpenaiRates(price)} / 1M`}
        mono
      />
      {price ? (
        <>
          <Fact
            label={t('models:cacheWrite')}
            value={fmtPerM(price.cache_5m)}
            mono
          />
          <Fact label={t('models:longContext')} value={tiersSummary(price)} />
          <Fact
            label={t('models:serviceTierPrices')}
            value={modes.length ? modes.join(' / ') : '—'}
            mono
          />
        </>
      ) : null}
    </>
  )
}

export function OpenaiCapabilityFacts({
  facts,
  live,
}: {
  facts: CatalogFacts
  live: boolean
}) {
  const { t } = useTranslation('models')
  const status = live ? t('models:publicVisible') : t('models:notInCatalog')
  if (!facts.synced) {
    return (
      <>
        <Fact
          label={t('models:upstreamCatalog')}
          value={t('models:catalogSyncHint')}
        />
        <Fact label={t('models:catalogStatus')} value={status} />
      </>
    )
  }
  return (
    <>
      <Fact label={t('models:context')} value={facts.context} />
      <Fact label={t('models:maxContext')} value={facts.maxContext} />
      <Fact label={t('models:defaultReasoning')} value={facts.defaultEffort} />
      <Fact label={t('models:availableReasoning')} value={facts.efforts} />
      <Fact label={t('models:serviceTiers')} value={facts.tiers} />
      <Fact label={t('models:inputPrice')} value={facts.input} />
      <Fact label={t('models:webSearch')} value={facts.search} />
      <Fact label={t('models:parallelTools')} value={facts.parallel} />
      <Fact label={t('models:upstreamVisibility')} value={facts.visibility} />
      <Fact
        label={t('models:syncTime')}
        value={fmtAgo(facts.syncedAt) || facts.syncedAt || '—'}
      />
      <Fact label={t('models:catalogStatus')} value={status} />
    </>
  )
}
