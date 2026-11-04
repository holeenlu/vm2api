/**
 * Codex 生图按张与网页搜索按次计费（对齐 sub2api 分组媒体计费）。
 * 纯函数：分组策略在请求准入时冻结，结算时据此计算，不读数据库。
 */

// 默认单价：1K = $0.134，2K 为 1.5 倍，4K 为 2 倍；网页搜索 $0.01/次（官方 $10/1000 次）
export const DEFAULT_IMAGE_PRICE_1K = 0.134
export const DEFAULT_WEB_SEARCH_PRICE = 0.01
const TIER_FACTOR = { '1K': 1, '2K': 1.5, '4K': 2 }

function price(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/** 请求准入时从分组冻结的媒体计费策略。 */
export function groupMediaPolicy(group) {
  if (!group) return null
  return {
    allow_image_generation: group.allow_image_generation !== false,
    image_count_billing: !!group.image_count_billing,
    image_rate_independent: !!group.image_rate_independent,
    image_rate_multiplier: Math.max(0, Number(group.image_rate_multiplier ?? 1) || 0),
    image_price_1k: price(group.image_price_1k),
    image_price_2k: price(group.image_price_2k),
    image_price_4k: price(group.image_price_4k),
    web_search_price_per_call: price(group.web_search_price_per_call),
  }
}

/** 尺寸档位：1k/2k/4k 或宽×高按最长边（≤1024 为 1K，≤2048 为 2K，否则 4K）；无法识别按 2K。 */
export function imageBillingTier(size) {
  const text = String(size ?? '')
    .trim()
    .toLowerCase()
  if (text === '1k' || text === '2k' || text === '4k') return text.toUpperCase()
  const match = /^(\d+)\s*[x×*]\s*(\d+)$/.exec(text)
  if (!match) return '2K'
  const edge = Math.max(Number(match[1]), Number(match[2]))
  if (edge <= 1024) return '1K'
  if (edge <= 2048) return '2K'
  return '4K'
}

export function imageUnitPrice(media, tier) {
  const key = { '1K': 'image_price_1k', '2K': 'image_price_2k', '4K': 'image_price_4k' }[tier] || 'image_price_2k'
  const configured = price(media?.[key])
  if (configured != null) return configured
  return DEFAULT_IMAGE_PRICE_1K * (TIER_FACTOR[tier] ?? TIER_FACTOR['2K'])
}

export function webSearchUnitPrice(media) {
  return price(media?.web_search_price_per_call) ?? DEFAULT_WEB_SEARCH_PRICE
}

const round8 = (n) => Math.round(n * 1e8) / 1e8

/**
 * 媒体计费：usage.web_search_calls 按次；Images 端点在分组开启按张计费时按 usage.image_count 计价。
 * 返回 { kind, total_cost, rate_multiplier }；rate_multiplier 为 null 表示沿用分组有效倍率。
 * 不适用时返回 null，由 token 计价处理。
 */
export function mediaCharge(usage, media) {
  if (!media || !usage || typeof usage !== 'object') return null
  const searches = Number(usage.web_search_calls)
  if (Number.isFinite(searches) && searches > 0) {
    const unit = webSearchUnitPrice(media)
    return {
      kind: 'web_search',
      unit_price: unit,
      count: searches,
      total_cost: round8(unit * searches),
      rate_multiplier: null,
    }
  }
  const images = Number(usage.image_count)
  if (media.image_count_billing && usage.image_endpoint && Number.isFinite(images) && images > 0) {
    const tier = imageBillingTier(usage.image_size)
    const unit = imageUnitPrice(media, tier)
    return {
      kind: 'image',
      tier,
      unit_price: unit,
      count: images,
      total_cost: round8(unit * images),
      rate_multiplier: media.image_rate_independent ? media.image_rate_multiplier : null,
    }
  }
  return null
}
