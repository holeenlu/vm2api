/**
 * Codex 生图按张与网页搜索按次计费（对齐 sub2api 分组媒体计费）。
 * 纯函数：分组策略在请求准入时冻结，结算时据此计算，不读数据库。
 * 金额按整数微单位计算（M6）：单价取分组的 `*_micros` 列，总额 = 单价 × 张数（次数），不经浮点。
 */
import { fromMicros, microsOf, priceMicros, rowMicros } from '../core/money.mjs'

// 默认单价：1K = $0.134，2K 为 1.5 倍，4K 为 2 倍；网页搜索 $0.01/次（官方 $10/1000 次）
export const DEFAULT_IMAGE_PRICE_1K = 0.134
export const DEFAULT_WEB_SEARCH_PRICE = 0.01
const DEFAULT_IMAGE_MICROS = { '1K': 134_000, '2K': 201_000, '4K': 268_000 }
const DEFAULT_WEB_SEARCH_MICROS = 10_000
const MEDIA_PRICE_KEYS = ['image_price_1k', 'image_price_2k', 'image_price_4k', 'web_search_price_per_call']

/** 分组单价（整数微单位）；未配置或无效为 null。 */
function priceMicrosOf(value) {
  const m = microsOf(value)
  return m != null && m >= 0 ? m : null
}

/** 请求准入时从分组冻结的媒体计费策略；单价取分组的整数列（没有时由 REAL 列换算一次）。 */
export function groupMediaPolicy(group) {
  if (!group) return null
  const policy = {
    allow_image_generation: group.allow_image_generation !== false,
    image_count_billing: !!group.image_count_billing,
    image_rate_independent: !!group.image_rate_independent,
    image_rate_multiplier: Math.max(0, Number(group.image_rate_multiplier ?? 1) || 0),
  }
  // 新旧两种键都写（M6）：整数键是权威值；美元键由它派生，供回滚后的上一版本读取已冻结在对账任务里的策略
  for (const key of MEDIA_PRICE_KEYS) {
    const micros = priceMicrosOf(rowMicros(group, key))
    policy[key] = fromMicros(micros)
    policy[key + '_micros'] = micros
  }
  return policy
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

/** 按张单价，整数微单位。 */
export function imageUnitPriceMicros(media, tier) {
  const key = { '1K': 'image_price_1k', '2K': 'image_price_2k', '4K': 'image_price_4k' }[tier] || 'image_price_2k'
  // 读整数键；只有美元键的（上一版本冻结在对账任务 context_json 里的策略）按美元键换算
  const configured = priceMicrosOf(rowMicros(media, key))
  if (configured != null) return configured
  return DEFAULT_IMAGE_MICROS[tier] ?? DEFAULT_IMAGE_MICROS['2K']
}

/** 按次单价，整数微单位。 */
export function webSearchUnitPriceMicros(media) {
  return priceMicrosOf(rowMicros(media, 'web_search_price_per_call')) ?? DEFAULT_WEB_SEARCH_MICROS
}

export function imageUnitPrice(media, tier) {
  return fromMicros(imageUnitPriceMicros(media, tier))
}

export function webSearchUnitPrice(media) {
  return fromMicros(webSearchUnitPriceMicros(media))
}

/** 单价 × 数量；数量不是整数时按整数微单位四舍五入。 */
function times(unitMicros, count) {
  return Math.round(unitMicros * count)
}

/** 分组表单输入的美元单价 → 整数微单位（groups-repo 写入用）。 */
export function mediaPriceMicros(value) {
  if (value == null || value === '') return null
  return priceMicros(value)
}

/**
 * 媒体计费：usage.web_search_calls 按次；Images 端点在分组开启按张计费时按 usage.image_count 计价。
 * 返回 { kind, total_cost_micros, total_cost（镜像）, rate_multiplier }；rate_multiplier 为 null 表示沿用分组有效倍率。
 * 不适用时返回 null，由 token 计价处理。
 */
export function mediaCharge(usage, media) {
  if (!media || !usage || typeof usage !== 'object') return null
  const searches = Number(usage.web_search_calls)
  if (Number.isFinite(searches) && searches > 0) {
    const unit = webSearchUnitPriceMicros(media)
    const total = times(unit, searches)
    return {
      kind: 'web_search',
      unit_price: fromMicros(unit),
      count: searches,
      total_cost_micros: total,
      total_cost: fromMicros(total),
      rate_multiplier: null,
    }
  }
  const images = Number(usage.image_count)
  if (media.image_count_billing && usage.image_endpoint && Number.isFinite(images) && images > 0) {
    const tier = imageBillingTier(usage.image_size)
    const unit = imageUnitPriceMicros(media, tier)
    const total = times(unit, images)
    return {
      kind: 'image',
      tier,
      unit_price: fromMicros(unit),
      count: images,
      total_cost_micros: total,
      total_cost: fromMicros(total),
      rate_multiplier: media.image_rate_independent ? media.image_rate_multiplier : null,
    }
  }
  return null
}
