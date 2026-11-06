// 分组媒体计费表单字段，与 groups-repo.mjs 的 MEDIA_FLAGS/MEDIA_PRICES 对应
export type MediaBillingForm = {
  allow_image_generation: boolean
  image_count_billing: boolean
  image_rate_independent: boolean
  image_rate_multiplier: number
  image_price_1k: number | null
  image_price_2k: number | null
  image_price_4k: number | null
  web_search_price_per_call: number | null
}

export const MEDIA_BILLING_DEFAULTS: MediaBillingForm = {
  allow_image_generation: true,
  image_count_billing: false,
  image_rate_independent: false,
  image_rate_multiplier: 1,
  image_price_1k: null,
  image_price_2k: null,
  image_price_4k: null,
  web_search_price_per_call: null,
}
