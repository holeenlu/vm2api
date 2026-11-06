/**
 * Official request cost from the three-layer price catalog.
 * Usage reaching this module is treated as DISJOINT after normalizeUsage:
 * input_tokens excludes cache read/write.
 */
import { extractOpenaiUsage, isOpenaiWireUsage } from '../protocol/openai-usage.mjs'
import { resolvePrice } from './price-catalog.mjs'
import { mediaCharge } from './media-pricing.mjs'
import {
  addPicos,
  allocateMicros,
  fromMicros,
  microsToPicos,
  priceMicros,
  roundDiv,
  tokenPicos,
} from '../core/money.mjs'

export const PRICING_CURRENCY = 'USD'
export const UNPRICED_MODEL = 'unpriced'

/** Response `usage.speed` is authoritative; request `speed` is the fallback. */
export function billedSpeed(usage = {}) {
  const raw = usage?.speed ?? usage?.requested_speed
  return String(raw ?? '')
    .trim()
    .toLowerCase() === 'fast'
    ? 'fast'
    : 'standard'
}

/** Request/response `service_tier` → billing band. Unknown tiers stay unpriced. */
export function normalizeOpenaiServiceTier(raw) {
  const t = String(raw ?? '')
    .trim()
    .toLowerCase()
  if (!t || t === 'default' || t === 'standard' || t === 'auto') return 'standard'
  if (t === 'flex') return 'flex'
  if (t === 'fast' || t === 'priority') return 'fast'
  return null
}

export function shanghaiDay(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d)
}

/** Shanghai calendar-day start as UTC ISO (for request_logs.ts). */
export function shanghaiDayStartIso(d = new Date()) {
  return new Date(`${shanghaiDay(d)}T00:00:00+08:00`).toISOString()
}

function n(v) {
  const x = Number(v)
  return Number.isFinite(x) && x > 0 ? x : 0
}

function webSearchRequestsOf(usage) {
  const v = usage?.server_tool_use?.web_search_requests ?? usage?.web_search_requests ?? 0
  const x = Number(v)
  return Number.isFinite(x) && x > 0 ? x : 0
}

/**
 * DISJOINT usage, idempotent. OpenAI wire shape (inclusive input) is converted
 * to Anthropic cache names so a second pass is a no-op.
 */
export function normalizeUsage(usage = {}) {
  if (!usage || typeof usage !== 'object') return {}
  const extracted = extractOpenaiUsage(usage)
  const details = usage.input_tokens_details || usage.prompt_tokens_details || {}
  const input = usage.input_tokens ?? usage.tokens_in ?? usage.prompt_tokens ?? extracted?.input_tokens
  const output = usage.output_tokens ?? usage.tokens_out ?? usage.completion_tokens ?? extracted?.output_tokens
  const cacheRead =
    usage.cache_read_tokens ?? usage.cache_read_input_tokens ?? details.cached_tokens ?? extracted?.cached_tokens
  const cacheCreate =
    usage.cache_creation_tokens ??
    usage.cache_creation_input_tokens ??
    details.cache_creation_tokens ??
    details.cache_write_tokens ??
    extracted?.cache_write_tokens
  const web_search_requests = webSearchRequestsOf(usage)
  if (isOpenaiWireUsage(usage)) {
    const hasRead = cacheRead != null
    const hasWrite = cacheCreate != null
    const read = hasRead ? n(cacheRead) : 0
    const write = hasWrite ? n(cacheCreate) : 0
    const inp = n(input)
    return {
      ...usage,
      input_tokens: Math.max(inp - read - write, 0),
      output_tokens: output,
      cache_read_tokens: hasRead ? read : cacheRead,
      cache_read_input_tokens: hasRead ? read : cacheRead,
      cache_creation_tokens: hasWrite ? write : cacheCreate,
      cache_creation_input_tokens: hasWrite ? write : cacheCreate,
      web_search_requests,
    }
  }
  return {
    ...usage,
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: cacheRead,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? cacheRead,
    cache_creation_tokens: cacheCreate,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? cacheCreate,
    web_search_requests,
  }
}

/** tokens × 价格表单价（$/MTok）的精确值，皮美元（Number，超出安全整数时 BigInt）；舍入只在 allocateMicros 里做一次（M6）。 */
function picos(tokens, perMTok) {
  return tokenPicos(tokens, priceMicros(perMTok))
}

/** 按次单价（美元）× 次数的精确值，皮美元。 */
function perCallPicos(count, unitUsd) {
  if (!count || !unitUsd) return 0
  return microsToPicos(priceMicros(unitUsd), count)
}

/**
 * 一行的各计价部分（皮美元）→ 整数微单位：总额从精确和四舍五入一次，各部分按最大余数法分摊，使之和恰为总额。
 * `image` 为 undefined 表示这一行没有生图部分（image_cost 保持缺省）。REAL 字段是 micros / 1e6 的镜像，只用于展示。
 */
function moneyOf(parts) {
  const withImage = parts.image !== undefined
  const exact = [
    parts.input || 0,
    parts.output || 0,
    parts.cache_read || 0,
    parts.cache_5m || 0,
    parts.cache_1h || 0,
    parts.web_search || 0,
  ]
  if (withImage) exact.push(parts.image || 0)
  const { total, parts: m } = allocateMicros(exact)
  const cacheCreation = m[3] + m[4]
  const out = {
    input_cost_micros: m[0],
    output_cost_micros: m[1],
    cache_read_cost_micros: m[2],
    cache_creation_cost_micros: cacheCreation,
    cache_creation_5m_cost_micros: m[3],
    cache_creation_1h_cost_micros: m[4],
    web_search_cost_micros: m[5],
    total_cost_micros: total,
    input_cost: fromMicros(m[0]),
    output_cost: fromMicros(m[1]),
    cache_read_cost: fromMicros(m[2]),
    cache_creation_cost: fromMicros(cacheCreation),
    cache_creation_5m_cost: fromMicros(m[3]),
    cache_creation_1h_cost: fromMicros(m[4]),
    web_search_cost: fromMicros(m[5]),
    total_cost: fromMicros(total),
  }
  if (withImage) {
    out.image_cost_micros = m[6]
    out.image_cost = fromMicros(m[6])
  }
  return out
}

function cacheSplit(u) {
  let cache5m = n(u.cache_creation_5m_tokens ?? u.cache_creation?.ephemeral_5m_input_tokens)
  let cache1h = n(u.cache_creation_1h_tokens ?? u.cache_creation?.ephemeral_1h_input_tokens)
  const cacheCreate = n(u.cache_creation_tokens ?? u.cache_creation_input_tokens)
  // Unsplit total (none, or beyond a stale message_start split) — explicit TTL only,
  // never DEFAULT_CACHE_TTL (which is 1h for upstream).
  const unsplit = cacheCreate - cache5m - cache1h
  if (unsplit > 0) {
    if (u.cache_ttl === '1h') cache1h += unsplit
    else cache5m += unsplit
  }
  return { cache5m, cache1h, cacheCreate }
}

function emptyCost(extra = {}) {
  return {
    price_source: extra.price_source ?? null,
    price_version: extra.price_version ?? null,
    currency: PRICING_CURRENCY,
    known: false,
    rates: null,
    mode: extra.mode ?? 'standard',
    long_context: extra.long_context ?? false,
    ...moneyOf({}),
    ...extra,
  }
}

function openaiBillingMode(usage) {
  const tier = normalizeOpenaiServiceTier(usage.service_tier)
  if (!tier) return { tier: null, mode: null }
  if (tier === 'flex') return { tier, mode: 'flex' }
  if (tier === 'fast') return { tier, mode: 'priority' }
  return { tier, mode: 'standard' }
}

function selectBand(price, mode, prompt) {
  let band = price
  let selectedMode = 'standard'
  if (mode && mode !== 'standard') {
    if (!price.modes?.[mode]) return { unpriced: true, mode, long_context: false }
    band = price.modes[mode]
    selectedMode = mode
  }
  let long_context = false
  if (Array.isArray(band.tiers) && band.tiers.length) {
    let chosen = null
    for (const t of band.tiers) {
      if (prompt > t.above) chosen = t
    }
    if (chosen) {
      long_context = true
      if (chosen.unpriced) return { unpriced: true, mode: selectedMode, long_context }
      band = chosen
    }
  }
  return { rates: band, mode: selectedMode, long_context, unpriced: false }
}

/**
 * Official standard cost for one request's usage object.
 * After normalizeUsage, input_tokens is the uncached bucket for every vendor.
 * `parts` 是各计价部分的精确值（皮美元），未定价时为 null；金额字段由 moneyOf 统一舍入。
 */
function textCost(usage = {}, model = null, { resolvedPrice = null } = {}) {
  const u = normalizeUsage(usage)
  const mid = model || u.model || u.upstream_model || u.requested_model || ''
  const resolved = resolvedPrice || resolvePrice(mid)
  const outputTokens = n(u.output_tokens)
  const cacheRead = n(u.cache_read_tokens)
  const { cache5m, cache1h } = cacheSplit(u)
  const inputTokens = n(u.input_tokens)
  const webSearchRequests = n(u.web_search_requests)
  const tokens = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_tokens: cacheRead,
    cache_creation_5m_tokens: cache5m,
    cache_creation_1h_tokens: cache1h,
    web_search_requests: webSearchRequests,
  }

  if (!resolved) {
    return {
      cost: emptyCost({
        model: mid || null,
        pricing_key: null,
        ...tokens,
      }),
      parts: null,
    }
  }

  const { platform, price, source, version, id } = resolved
  let mode = 'standard'
  let service_tier = null
  if (platform === 'openai') {
    const billed = openaiBillingMode(u)
    service_tier = billed.tier
    if (!billed.mode) {
      return {
        cost: emptyCost({
          model: mid || null,
          pricing_key: id,
          price_source: source,
          price_version: version,
          service_tier: null,
          ...tokens,
        }),
        parts: null,
      }
    }
    mode = billed.mode
  } else if (billedSpeed(u) === 'fast' && price.modes?.fast) {
    mode = 'fast'
  }

  const prompt = inputTokens + cacheRead + cache5m + cache1h
  const selected = selectBand(price, mode, prompt)
  if (selected.unpriced) {
    return {
      cost: emptyCost({
        model: mid || null,
        pricing_key: id,
        price_source: source,
        price_version: version,
        mode: selected.mode,
        service_tier,
        speed: selected.mode === 'fast' ? 'fast' : platform === 'anthropic' ? 'standard' : billedSpeed(u),
        long_context: selected.long_context,
        ...tokens,
      }),
      parts: null,
    }
  }

  const rates = selected.rates
  const parts = {
    input: picos(inputTokens, rates.input),
    output: picos(outputTokens, rates.output),
    cache_read: picos(cacheRead, rates.cache_read),
    cache_5m: picos(cache5m, rates.cache_5m),
    cache_1h: picos(cache1h, rates.cache_1h),
    web_search: perCallPicos(webSearchRequests, price.per_call?.web_search),
  }
  const speed = selected.mode === 'fast' ? 'fast' : 'standard'

  return {
    cost: {
      model: mid || null,
      pricing_key: id,
      price_source: source,
      price_version: version,
      currency: PRICING_CURRENCY,
      known: true,
      rates,
      mode: selected.mode,
      service_tier,
      speed,
      long_context: selected.long_context,
      ...tokens,
      ...moneyOf(parts),
    },
    parts,
  }
}

function calculateTextCost(usage = {}, model = null, options = {}) {
  return textCost(usage, model, options).cost
}

/** Raw billing band inputs, persisted so a later backfill re-prices with the same band. */
// Commercial settlement carries image evidence in the same persisted usage object.
export function calculateCost(usage = {}, model = null, options = {}) {
  const media = mediaCharge(usage, options.media)
  if (media) return mediaCost(usage, model, media)
  const image = usage?.image_generation
  if (!image) return calculateTextCost(usage, model, options)
  const text = textCost(image.only ? {} : usage, model, options)
  const img = imagePriced(image.usage, image.model, {
    resolvedPrice: image.only ? options.resolvedPrice : options.resolvedPrice?.image_price,
  })
  const known = (image.only || text.cost.known) && img.known
  const money = known ? moneyOf({ ...(image.only ? {} : text.parts), image: img.picos }) : null
  return {
    ...text.cost,
    ...(money || {}),
    known,
    pricing_key: image.only ? img.pricing_key : text.cost.pricing_key,
    price_source: image.only ? img.price_source : text.cost.price_source,
    price_version: image.only ? img.price_version : text.cost.price_version,
    // 已定价时生图部分随其余部分一起按最大余数法分摊（来自 money），各部分之和等于总额；未定价时保留单独估算值
    ...(known
      ? {}
      : {
          image_cost_micros: img.image_cost_micros,
          image_cost: img.image_cost,
          total_cost_micros: null,
          total_cost: null,
        }),
  }
}

// 分组媒体计费（按张生图、按次网页搜索）：费用与 token 无关，rate_multiplier 非空时覆盖分组倍率
function mediaCost(usage, model, media) {
  const isImage = media.kind === 'image'
  return {
    model: model || null,
    pricing_key: isImage ? `image_count:${media.tier}` : 'web_search_per_call',
    price_source: 'group',
    price_version: null,
    currency: PRICING_CURRENCY,
    known: true,
    media,
    rate_multiplier: media.rate_multiplier,
    ...moneyOf(
      isImage
        ? { image: microsToPicos(media.total_cost_micros) }
        : { web_search: microsToPicos(media.total_cost_micros), image: 0 },
    ),
  }
}

export function billingBandFromUsage(usage = {}) {
  const tier = String(usage?.service_tier ?? '')
    .trim()
    .toLowerCase()
  const speed = String(usage?.speed ?? usage?.requested_speed ?? '')
    .trim()
    .toLowerCase()
  return { service_tier: tier || null, speed: speed || null }
}

// GPT Image variants share one price; an omitted model is priced with it.
const IMAGE_DEFAULT_PRICE_ID = 'gpt-image-2.6-flare'

function tokenCount(v) {
  return Number.isSafeInteger(v) && v >= 0 ? v : null
}

/**
 * Image generation usage (`tool_usage.image_gen`, or an Images response `usage`), priced like
 * codex-proxy-rs `image_calculated_cost`: text input at the base rates, image input and output
 * at `price.image`. A split that does not add up stays unpriced; nothing is guessed.
 */
export function imageCostFromUsage(usage, imageModel = null, options = {}) {
  const { picos: _picos, ...out } = imagePriced(usage, imageModel, options)
  return out
}

/** imageCostFromUsage 加上精确值 `picos`（皮美元），供同一行的文本部分一起分摊。 */
function imagePriced(usage, imageModel = null, { resolvedPrice = null } = {}) {
  const unknown = {
    known: false,
    picos: null,
    image_cost_micros: null,
    image_cost: null,
    image_input_tokens: tokenCount(usage?.input_tokens) ?? 0,
    image_output_tokens: tokenCount(usage?.output_tokens) ?? 0,
    pricing_key: null,
    price_source: null,
    price_version: null,
  }
  if (!usage || typeof usage !== 'object') return unknown
  const resolved = resolvedPrice || resolvePrice(imageModel || IMAGE_DEFAULT_PRICE_ID)
  const rates = resolved?.price
  if (!rates?.image) return unknown
  const input = tokenCount(usage.input_tokens)
  const output = tokenCount(usage.output_tokens)
  const text = tokenCount(usage.input_tokens_details?.text_tokens)
  const image = tokenCount(usage.input_tokens_details?.image_tokens)
  const cached =
    usage.input_tokens_details?.cached_tokens == null ? 0 : tokenCount(usage.input_tokens_details.cached_tokens)
  if (input == null || output == null || text == null || image == null || cached == null) return unknown
  if (text + image !== input || cached > input) return unknown
  if (usage.total_tokens != null && usage.total_tokens !== input + output) return unknown
  // The model only outputs images; any other output modality cannot use the image rate.
  const outDetails = usage.output_tokens_details
  if (outDetails != null && (outDetails.image_tokens !== output || outDetails.text_tokens !== 0)) return unknown
  // A cached total alone cannot be split across mixed text and image input.
  let cachedText = 0
  let cachedImage = 0
  if (cached) {
    if (image === 0) cachedText = cached
    else if (text === 0) cachedImage = cached
    else if (cached === input) {
      cachedText = text
      cachedImage = image
    } else return unknown
  }
  const exact = [
    picos(text - cachedText, rates.input),
    picos(cachedText, rates.cache_read),
    picos(image - cachedImage, rates.image.input),
    picos(cachedImage, rates.image.cache_read),
    picos(output, rates.image.output),
  ].reduce(addPicos, 0)
  const micros = typeof exact === 'number' ? roundDiv(exact, 1_000_000) : Number(roundDiv(exact, 1_000_000n))
  return {
    known: true,
    picos: exact,
    image_cost_micros: micros,
    image_cost: fromMicros(micros),
    image_input_tokens: input,
    image_output_tokens: output,
    pricing_key: resolved.id,
    price_source: resolved.source,
    price_version: resolved.version,
  }
}

/** usage_logs 金额列：整数列为权威值，REAL 列是镜像；未定价时两者都为 null。 */
export const COST_COLUMN_KEYS = [
  'input_cost',
  'output_cost',
  'cache_read_cost',
  'cache_creation_cost',
  'web_search_cost',
  'image_cost',
  'total_cost',
]

function costColumns(money, known) {
  const out = {}
  for (const key of COST_COLUMN_KEYS) {
    const micros = known ? (money[key + '_micros'] ?? null) : null
    out[key + '_micros'] = micros
    out[key] = fromMicros(micros)
  }
  return out
}

/**
 * `image` = `{ usage, model, only }`: image generation usage on the same row. `only` marks an
 * Images endpoint row, which has no text-model usage. Either part unpriced → the whole row is.
 */
export function costColumnsFromUsage(usage, model, image = null, options = {}) {
  const media = mediaCharge(usage, options.media)
  if (media) {
    const c = mediaCost(usage, model, media)
    return {
      ...costColumns(c, true),
      pricing_model: c.pricing_key,
      price_source: c.price_source,
      price_version: null,
      service_tier: null,
      speed: null,
      long_context: 0,
    }
  }
  image = image || usage?.image_generation
  const img = image
    ? imagePriced(image.usage, image.model, {
        resolvedPrice: image.only ? options.resolvedPrice : options.resolvedPrice?.image_price,
      })
    : null
  const band = billingBandFromUsage(normalizeUsage(usage))
  if (image?.only) {
    const known = img.known
    return {
      ...costColumns(known ? moneyOf({ image: img.picos }) : {}, known),
      pricing_model: known ? img.pricing_key : UNPRICED_MODEL,
      price_source: known ? img.price_source : null,
      price_version: known ? img.price_version : null,
      ...band,
      long_context: known ? 0 : null,
    }
  }
  const text = textCost(usage, model, options)
  const c = text.cost
  const known = c.known && (!img || img.known)
  const money = known ? moneyOf(img ? { ...text.parts, image: img.picos } : text.parts) : {}
  return {
    // 没有生图部分时 money 不含 image_cost_micros，image_cost 为 null（与改造前一致）
    ...costColumns(money, known),
    pricing_model: known ? c.pricing_key : UNPRICED_MODEL,
    price_source: known ? c.price_source : null,
    price_version: known ? c.price_version : null,
    ...band,
    long_context: known ? (c.long_context ? 1 : 0) : null,
  }
}

const BUCKET_COST_KEYS = ['input_cost', 'output_cost', 'cache_read_cost', 'cache_creation_cost', 'total_cost']

/** 成本桶：金额按整数微单位累加（`*_micros`），REAL 字段只是镜像。 */
export function emptyCostBucket() {
  const out = {
    requests: 0,
    success: 0,
    errors: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
  }
  for (const key of BUCKET_COST_KEYS) {
    out[key] = 0
    out[key + '_micros'] = 0
  }
  return out
}

/** 合并成本桶；行里的金额读 `*_micros`（SQL 一律 SUM 整数列），不再对 REAL 求和。 */
export function sumCostBuckets(rows = []) {
  const out = emptyCostBucket()
  for (const r of rows) {
    out.requests += n(r.requests)
    out.success += n(r.success)
    out.errors += n(r.errors)
    out.input_tokens += n(r.input_tokens)
    out.output_tokens += n(r.output_tokens)
    out.cache_read_tokens += n(r.cache_read_tokens)
    out.cache_creation_tokens += n(r.cache_creation_tokens)
    for (const key of BUCKET_COST_KEYS) out[key + '_micros'] += Math.round(n(r[key + '_micros']))
  }
  for (const key of BUCKET_COST_KEYS) out[key] = fromMicros(out[key + '_micros'])
  return out
}
