import crypto from 'node:crypto'
import { withTransaction } from '../db/database.mjs'
import { zonedWallToMs, zonedParts } from '../core/timezone.mjs'
import { VendorError, normalizeVendorRate } from './vendor-platform.mjs'
import {
  activeGlobalContracts,
  activeLegacyContracts,
  contractById,
  globalContractByIdempotencyKey,
  insertGlobalContract,
  iterateSettlementUsageRows,
  nextGlobalContractVersion,
} from './repos/pricing-repo.mjs'

export function settlementUsageRows(platform, ids, period) {
  return iterateSettlementUsageRows(platform.db, ids, period)
}

export const PRICING_TIMEZONE = 'Asia/Shanghai'
const SCALE = 10n ** 10n,
  MICROS = 10n ** 6n
const fail = (code, message, status = 400) => {
  throw new VendorError(code, message, status)
}
export function decimalUnits(value, digits = 10, signed = false) {
  const text = typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : String(value ?? '')
  if (!new RegExp(`^${signed ? '-?' : ''}\\d{1,12}(?:\\.\\d{1,${digits}})?$`).test(text))
    fail('invalid_settlement_amount', '金额或结算参数超出支持范围')
  const [whole, fraction = ''] = text.replace('-', '').split('.')
  const units = BigInt(whole) * 10n ** BigInt(digits) + BigInt(fraction.padEnd(digits, '0'))
  return text.startsWith('-') ? -units : units
}
export function decimalText(value, digits = 6) {
  const n = value < 0n ? -value : value,
    s = n.toString().padStart(digits + 1, '0')
  return `${value < 0n ? '-' : ''}${s.slice(0, -digits)}.${s.slice(-digits)}`
}
function roundDivide(n, d) {
  if (d <= 0n) fail('invalid_settlement_rate', '结算参数必须为正数')
  return (n + d / 2n) / d
}
const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function pricingEffectiveAt(date) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(String(date)) ||
    !Number.isFinite(Date.parse(date)) ||
    new Date(date).toISOString().slice(0, 10) !== date
  )
    fail('invalid_effective_date', '请选择有效的生效日期')
  const [year, month, day] = date.split('-').map(Number)
  return new Date(zonedWallToMs({ year, month, day }, PRICING_TIMEZONE)).toISOString()
}
const dateOf = (stamp) => {
  const p = zonedParts(Date.parse(stamp), PRICING_TIMEZONE)
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}
function pricesOf(rule) {
  let prices
  try {
    prices = JSON.parse(rule.group_prices_json || '{}')
  } catch {
    fail('invalid_contract_rates', '历史结算价格数据无效', 409)
  }
  if (!prices || typeof prices !== 'object' || Array.isArray(prices))
    fail('invalid_contract_rates', '结算价格数据无效', 409)
  return prices
}
function publicRule(row) {
  const prices = pricesOf(row)
  return {
    id: row.id,
    version: row.version,
    openai_price: prices.openai,
    claude_price: prices.anthropic,
    exchange_rate: row.fx_cny_per_usdt,
    effective_date: dateOf(row.effective_at),
    effective_at: row.effective_at,
    timezone: PRICING_TIMEZONE,
    created_at: row.created_at,
  }
}
export function listGlobalPricing(platform, { now = Date.now() } = {}) {
  const rows = activeGlobalContracts(platform.db)
  const current = rows.find((r) => Date.parse(r.effective_at) <= now)
  return {
    timezone: PRICING_TIMEZONE,
    current: current ? publicRule(current) : null,
    items: rows.map((r) => ({
      ...publicRule(r),
      state: rows.some((other) => other.effective_at === r.effective_at && other.version > r.version)
        ? 'superseded'
        : r.id === current?.id
          ? 'active'
          : Date.parse(r.effective_at) > now
            ? 'scheduled'
            : 'historical',
    })),
  }
}
export function createGlobalPricing(platform, actor, body) {
  if (actor?.system_admin !== true) fail('forbidden', '只有超级管理员可以设置全局结算规则', 403)
  if (
    Object.keys(body || {}).some(
      (k) => !['openai_price', 'claude_price', 'exchange_rate', 'effective_date', 'idempotency_key'].includes(k),
    )
  )
    fail('invalid_pricing_fields', '结算设置仅支持两种单价、汇率和生效日期')
  const input = {
    openai_price: normalizeVendorRate(body.openai_price),
    claude_price: normalizeVendorRate(body.claude_price),
    exchange_rate: normalizeVendorRate(body.exchange_rate),
    effective_at: pricingEffectiveAt(body.effective_date),
  }
  const key = String(body.idempotency_key || '')
  if (!/^[a-zA-Z0-9_.:-]{8,128}$/.test(key)) fail('invalid_pricing_request', '缺少有效的保存标识')
  const hash = digest(input),
    user = platform.actorId(actor.user_id)
  return withTransaction(platform.db, () => {
    const old = globalContractByIdempotencyKey(platform.db, user, key)
    if (old) {
      if (old.input_hash !== hash) fail('idempotency_conflict', '保存标识已用于其他价格设置', 409)
      return publicRule(old)
    }
    const version = nextGlobalContractVersion(platform.db).n
    const id = 'pricing_' + crypto.randomUUID(),
      stamp = new Date().toISOString()
    insertGlobalContract(
      platform.db,
      id,
      version,
      input.effective_at,
      input.exchange_rate,
      JSON.stringify({ openai: input.openai_price, anthropic: input.claude_price }),
      user,
      stamp,
      key,
      hash,
    )
    platform.audit({
      actorUserId: user,
      vendorId: null,
      action: 'pricing.version_created',
      resourceType: 'pricing',
      resourceId: id,
      payload: { version, ...input },
    })
    return publicRule(contractById(platform.db, id))
  })
}
/** All new prices are global. Legacy vendor prices are read only before the first global cutover. */
export function pricingResolver(platform, payeeId, payerId = null) {
  const global = activeGlobalContracts(platform.db)
  const legacy = activeLegacyContracts(platform.db, payeeId, payerId)
  const first = global.at(-1)?.effective_at
  return (at) => {
    const picked = global.find((r) => Date.parse(r.effective_at) <= Date.parse(at))
    if (picked) return { ...picked, pricing_source: 'global' }
    if (!first || Date.parse(at) < Date.parse(first)) {
      const old =
        legacy.find((r) => Date.parse(r.effective_at) <= Date.parse(at)) || legacy.find((r) => r.version === 1)
      if (old) return { ...old, pricing_source: 'legacy' }
    }
    fail('pricing_not_effective', '用量发生时没有生效的结算价格，请先检查全局结算设置', 409)
  }
}

/** Aggregate USD by the rule that applied at request time, then round each pricing segment to USDT micros. */
export function quoteUsagePricing(platform, payeeId, payerId, records, { emptyAt } = {}) {
  const resolve = pricingResolver(platform, payeeId, payerId),
    buckets = new Map(),
    rules = new Map(),
    accounts = new Map(),
    evidence = crypto.createHash('sha256')
  let requests = 0,
    inputTokens = 0,
    outputTokens = 0
  for (const row of records) {
    const at = row.created_at || row.occurred_at
    const rule = resolve(at),
      prices = pricesOf(rule)
    const provider = { claude: 'anthropic', codex: 'openai' }[row.platform] || row.platform
    if (
      row.pricing_model === 'unpriced' ||
      row.total_cost == null ||
      !Number.isFinite(Number(row.total_cost)) ||
      Number(row.total_cost) < 0
    )
      fail('settlement_unpriced_usage', '存在未定价用量，请先补齐价格', 409)
    const global = rule.pricing_source === 'global'
    if (
      (global || (Object.keys(prices).length && prices[String(row.group_id)] == null)) &&
      !['anthropic', 'openai'].includes(provider) &&
      Number(row.total_cost) > 0
    )
      fail('unknown_usage_platform', '用量缺少平台归属，不能猜测结算单价', 409)
    if (global && (!Object.hasOwn(prices, 'openai') || !Object.hasOwn(prices, 'anthropic')))
      fail('invalid_contract_rates', '全局价格缺少OpenAI或Claude单价', 409)
    const selectedPrice = global
      ? prices[provider]
      : (prices[String(row.group_id)] ?? prices[row.platform] ?? prices[provider] ?? rule.price_cny_per_usd)
    const rate = decimalUnits(selectedPrice),
      multiplier = global ? SCALE : decimalUnits(rule.multiplier),
      fx = decimalUnits(rule.fx_cny_per_usdt)
    if (rate <= 0n || multiplier <= 0n || fx <= 0n) fail('invalid_contract_rates', '结算参数无效', 409)
    const platformKey = Object.keys(prices).length ? provider : ''
    const key = rule.id + '|' + platformKey + (global || rule.leg !== 'l1_to_l2' ? '' : '|' + String(row.group_id))
    let line = buckets.get(key)
    if (!line) {
      line = {
        pricing_id: rule.id,
        pricing_version: rule.version,
        pricing_source: rule.pricing_source,
        effective_at: rule.effective_at,
        effective_date: dateOf(rule.effective_at),
        platform: platformKey || null,
        price_cny_per_usd: decimalText(roundDivide(rate * multiplier, SCALE), 10),
        exchange_rate: decimalText(fx, 10),
        cost: 0n,
        requests: 0,
        rate,
        multiplier,
        fx,
      }
      buckets.set(key, line)
    }
    line.cost += decimalUnits(Number(row.total_cost))
    line.requests++
    requests++
    inputTokens += Number(row.input_tokens || 0)
    outputTokens += Number(row.output_tokens || 0)
    const accountId = row.account_resource_id || row.account_id || '',
      accountKey = [row.vendor_id || payeeId, accountId, row.model || ''].join('|')
    let account = accounts.get(accountKey)
    if (!account) {
      account = {
        vendor_id: row.vendor_id || payeeId,
        vendor_name: row.vendor_name || '',
        resource_id: accountId,
        account_name: row.account_name || '',
        platform: provider || null,
        model: row.model || '',
        requests: 0,
        input_tokens: 0,
        output_tokens: 0,
        cost: 0n,
      }
      accounts.set(accountKey, account)
    }
    account.requests++
    account.input_tokens += Number(row.input_tokens || 0)
    account.output_tokens += Number(row.output_tokens || 0)
    account.cost += decimalUnits(Number(row.total_cost))
    evidence.update(
      JSON.stringify([
        row.request_id || row.id,
        at,
        accountId,
        row.model,
        row.total_cost,
        row.input_tokens,
        row.output_tokens,
        rule.id,
      ]),
    )

    rules.set(rule.id, {
      id: rule.id,
      version: rule.version,
      source: rule.pricing_source,
      effective_at: rule.effective_at,
    })
  }
  if (!rules.size) {
    const rule = resolve(emptyAt || new Date().toISOString())
    rules.set(rule.id, {
      id: rule.id,
      version: rule.version,
      source: rule.pricing_source,
      effective_at: rule.effective_at,
    })
  }
  let total = 0n,
    cost = 0n
  const lines = [...buckets.values()].map(({ cost: usd, rate, multiplier, fx, ...line }) => {
    const amount = roundDivide(usd * rate * multiplier * MICROS, SCALE * SCALE * fx)
    total += amount
    cost += usd
    return { ...line, cost_usd: decimalText(usd, 10), amount_usdt: decimalText(amount) }
  })
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) fail('settlement_amount_too_large', '结算金额超出支持范围')
  const versions = [...rules.values()].sort(
    (a, b) => a.effective_at.localeCompare(b.effective_at) || a.version - b.version,
  )
  return {
    usage: {
      requests,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_usd: Number(decimalText(cost, 10)),
      unpriced_requests: 0,
    },
    accounts: [...accounts.values()].map(({ cost, ...a }) => ({ ...a, cost_usd: Number(decimalText(cost, 10)) })),
    evidence_hash: evidence.digest('hex'),
    contract_id: versions[0].id,
    contract_version: versions.length === 1 ? versions[0].version : null,
    pricing_versions: versions,
    lines,
    cost_usd: decimalText(cost, 10),
    subtotal_usdt: decimalText(total),
    amount_usdt: Number(decimalText(total)),
  }
}
