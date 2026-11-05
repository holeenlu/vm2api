/** USD per 1M tokens unless noted. */
export type Price = {
  input: number
  output: number
  cache_read: number
  cache_5m: number
  cache_1h: number
  tiers?: Array<
    | {
        above: number
        input: number
        output: number
        cache_read: number
        cache_5m: number
        cache_1h: number
      }
    | { above: number; unpriced: true }
  >
  modes?: { fast?: Price; flex?: Price; priority?: Price }
  per_call?: { web_search?: number }
  /** GPT Image: image-token rates; the base fields price the text tokens. */
  image?: { input: number; output: number; cache_read: number }
}

export type PriceSource = 'override' | 'models.dev' | 'builtin'

export type SyncStatus = {
  at: string
  status: 'ok' | 'error' | 'skipped'
  added: string[]
  error: string | null
}

export type PricingEntry = {
  platform: 'anthropic' | 'openai'
  id: string
  name: string | null
  context: number | null
  effective: Price | null
  source: PriceSource | null
  version: string | null
  mode_sources: {
    fast?: PriceSource
    flex?: PriceSource
    priority?: PriceSource
  }
  builtin: Price | null
  models_dev: Price | null
  override: (Price & { updated_at?: string }) | null
  override_key: string | null
  diff: boolean
  in_policy: boolean
}

export type PolicyPrice = {
  id: string
  source: PriceSource
  effective: Price
}

export type ModelsDevStatus = {
  fetched_at: string | null
  status: 'ok' | 'error' | 'never'
  error: string | null
  models: number
}

export type UnpricedModel = {
  model: string
  requests: number
  last_seen: string | null
}

export type PricingPayload = {
  models: PricingEntry[]
  models_dev: ModelsDevStatus
  overrides: Record<string, Price & { updated_at?: string }>
  unpriced: UnpricedModel[]
  policy: Record<string, PolicyPrice | null>
  catalog_sync: {
    claude: SyncStatus | null
    codex: SyncStatus | null
  }
}

export type RepriceResult = {
  rows: number
  changed: number
  still_unpriced: number
  delta_usd: number
}

export type WindowEstimate = {
  status: 'ok' | 'no_data' | 'no_reset' | 'log_gap' | 'low_usage' | 'resampling'
  spent_usd: number
  /** Window capacity sampled from the used% history (codex-proxy-rs forecast). */
  total_usd: number | null
  remaining_usd: number | null
  total_tokens: number | null
  used_ratio: number | null
  /** Fewer than 10pp sampled or under 2 recent blocks. */
  low_sample?: boolean
  /** Some requests in the sample are unpriced, so the dollar figure understates. */
  incomplete_cost?: boolean
}
