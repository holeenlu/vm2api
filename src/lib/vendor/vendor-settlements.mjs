import { VENDOR_ACCOUNT_LOGS } from './vendor-account-usage.mjs'
import crypto from 'node:crypto'
import { withTransaction } from '../db/database.mjs'
import { zonedWallToMs } from '../core/timezone.mjs'
import { settlementAction, settlementContract } from './vendor-admin.mjs'
import { VendorError } from './vendor-platform.mjs'

const SCALE = 10n ** 10n
const MONEY_SCALE = 10n ** 6n
const hash = (value) =>
  crypto
    .createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex')
const parse = (text, fallback = {}) => {
  try {
    return JSON.parse(text || '{}')
  } catch {
    return fallback
  }
}
const fail = (code, message, status = 400) => {
  throw new VendorError(code, message, status)
}
function decimal(value, digits = 10, signed = false) {
  const text = typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : String(value ?? '')
  if (!new RegExp(`^${signed ? '-?' : ''}\\d{1,12}(?:\\.\\d{1,${digits}})?$`).test(text))
    fail('invalid_settlement_amount', '请输入有效的结算金额或汇率')
  const negative = text.startsWith('-')
  const [whole, fraction = ''] = text.replace('-', '').split('.')
  const units = BigInt(whole) * 10n ** BigInt(digits) + BigInt(fraction.padEnd(digits, '0'))
  return negative ? -units : units
}
function display(value, digits = 6) {
  const negative = value < 0n
  const n = negative ? -value : value
  const s = n.toString().padStart(digits + 1, '0')
  return `${negative ? '-' : ''}${s.slice(0, -digits)}.${s.slice(-digits)}`
}
function roundDivide(numerator, denominator) {
  if (denominator <= 0n) fail('invalid_settlement_rate', '结算单价、倍率和汇率必须大于零')
  return (numerator + denominator / 2n) / denominator
}
function requirePayer(platform, identity, vendorId) {
  platform.requireActive(identity)
  platform.requireCapability(identity, 'vendor.settlement.read')
  platform.requireCapability(identity, 'vendor.create_child')
  const payee = platform.vendorRow(vendorId)
  if (identity.vendor.tier !== 1 || !payee || payee.parent_id !== identity.vendor.id || payee.tier !== 2)
    fail('vendor_scope_forbidden', '只能为自己的直属供应商创建结算', 403)
  return payee
}
function dateParts(value) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(String(value)) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  )
    fail('invalid_settlement_period', '请选择有效的开始和结束日期')
  const [year, month, day] = value.split('-').map(Number)
  return { year, month, day }
}
function normalizeInput(body) {
  const start = dateParts(body.start_date),
    end = dateParts(body.end_date)
  const timezone = String(body.timezone || 'Asia/Shanghai')
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone }).format()
  } catch {
    fail('invalid_settlement_timezone', '结算时区无效')
  }
  const from = zonedWallToMs(start, timezone),
    until = zonedWallToMs({ ...end, day: end.day + 1 }, timezone)
  if (from >= until || until - from > 367 * 86400000)
    fail('invalid_settlement_period', '结束日期不能早于开始日期，账期最长一年')
  const exchange = decimal(body.exchange_rate)
  if (exchange <= 0n) fail('invalid_settlement_rate', '结算汇率必须大于零')
  const adjustment = decimal(body.adjustment ?? '0', 6, true)
  const reason = String(body.adjustment_reason || '').trim()
  const source = String(body.exchange_rate_source || '').trim()
  if (!source || source.length > 240 || (adjustment !== 0n && !reason) || reason.length > 1000)
    fail('invalid_settlement_reason', '请填写汇率来源及调整原因')
  const groupId = body.group_id == null || body.group_id === '' ? null : Number(body.group_id)
  if (groupId != null && (!Number.isSafeInteger(groupId) || groupId <= 0)) fail('invalid_settlement_group', '分组无效')
  const account = String(body.account_id || '').trim()
  const provider = String(body.platform || '')
  if (provider && !['anthropic', 'openai'].includes(provider)) fail('invalid_settlement_platform', '平台无效')
  return {
    start_date: body.start_date,
    end_date: body.end_date,
    start_at: new Date(from).toISOString(),
    end_at: new Date(until).toISOString(),
    timezone,
    exchange_rate: display(exchange, 10),
    exchange_rate_source: source,
    adjustment: display(adjustment),
    adjustment_reason: reason,
    account_id: account,
    group_id: groupId,
    platform: provider,
  }
}
function contractFor(platform, identity, payee, input) {
  return settlementContract(platform, payee.id, { start: input.start_at, end: input.end_at }, identity.vendor.id)
}
function buildSnapshot(platform, identity, payee, contract, input, watermark, snapshotAt) {
  const db = platform.db
  const rows = db
    .prepare(`SELECT l.request_id AS id,l.watermark,l.created_at,l.group_id,g.name AS group_name,
    COALESCE(l.upstream_model,l.pricing_model,l.model) AS model,l.total_cost,l.pricing_model,l.input_tokens,l.output_tokens,l.cache_read_tokens,l.cache_creation_tokens,
    a.id AS account_id,a.name AS account_name,json_extract(a.config_json,'$.platform') AS platform,
    EXISTS(SELECT 1 FROM vendor_settlement_allocations al WHERE al.usage_log_id=l.request_id AND al.payer_vendor_id=? AND al.payee_vendor_id=? AND al.released_at IS NULL) AS occupied
    FROM (${VENDOR_ACCOUNT_LOGS}) l LEFT JOIN vendor_resources a ON a.id=l.account_resource_id AND a.vendor_id=l.vendor_id
    LEFT JOIN groups g ON g.id=l.group_id
    WHERE l.vendor_id=? AND l.created_at>=? AND l.created_at<? AND l.watermark<=? AND l.status>=200 AND l.status<300 AND l.created_at<=?
    AND (COALESCE(l.total_cost,0)>0 OR COALESCE(l.input_tokens,0)+COALESCE(l.output_tokens,0)+COALESCE(l.cache_read_tokens,0)+COALESCE(l.cache_creation_tokens,0)>0)
    ${input.account_id ? 'AND a.id=?' : ''} ${input.group_id ? 'AND l.group_id=?' : ''} ${input.platform ? "AND json_extract(a.config_json,'$.platform')=?" : ''}
    ORDER BY l.watermark,l.id LIMIT 50001`)
    .all(
      identity.vendor.id,
      payee.id,
      payee.id,
      input.start_at,
      input.end_at,
      watermark,
      snapshotAt,
      ...(input.account_id ? [input.account_id] : []),
      ...(input.group_id ? [input.group_id] : []),
      ...(input.platform ? [input.platform] : []),
    )
  if (rows.length > 50000) fail('settlement_too_large', '记录超过 50000 条，请缩短结算账期')
  // Previously issued invoices had no per-request allocation. Preserve their paid/held periods.
  const legacy = db
    .prepare(
      "SELECT s.period_start,s.period_end FROM vendor_settlements s JOIN vendor_contracts c ON c.id=s.contract_id WHERE c.payer_vendor_id=? AND c.payee_vendor_id=? AND s.status<>'void' AND COALESCE(json_extract(s.usage_snapshot_json,'$.source'),'')<>'usage_logs_v2'",
    )
    .all(identity.vendor.id, payee.id)
  const available = rows.filter(
    (row) =>
      !row.occupied &&
      !legacy.some((period) => row.created_at >= period.period_start && row.created_at < period.period_end),
  )
  if (
    available.some(
      (row) =>
        row.pricing_model === 'unpriced' ||
        row.total_cost == null ||
        !Number.isFinite(Number(row.total_cost)) ||
        Number(row.total_cost) < 0,
    )
  )
    fail('settlement_unpriced_usage', '存在未定价用量，请先补齐价格后再结算', 409)
  const coefficients = parse(contract.group_prices_json)
  const fx = decimal(input.exchange_rate),
    multiplier = decimal(contract.multiplier)
  if (multiplier <= 0n) fail('invalid_settlement_rate', '结算倍率必须大于零')
  const buckets = new Map()
  for (const row of available) {
    const coefficient = decimal(
      coefficients[String(row.group_id)] ?? coefficients[row.platform] ?? contract.price_cny_per_usd,
    )
    if (coefficient <= 0n) fail('invalid_settlement_rate', '采购单价必须大于零')
    const key = String(row.group_id) + '|' + display(coefficient, 10)
    let line = buckets.get(key)
    if (!line) {
      line = {
        group_id: row.group_id,
        group_name: row.group_name || '',
        coefficient: display(coefficient, 10),
        cost: 0n,
        requests: 0,
      }
      buckets.set(key, line)
    }
    line.cost += decimal(Number(row.total_cost))
    line.requests++
  }
  let totalCost = 0n,
    subtotal = 0n
  const lines = [...buckets.values()].map((line) => {
    const amount = roundDivide(line.cost * decimal(line.coefficient) * multiplier * MONEY_SCALE, SCALE * SCALE * fx)
    totalCost += line.cost
    subtotal += amount
    return {
      group_id: line.group_id,
      group_name: line.group_name,
      coefficient: line.coefficient,
      cost_usd: display(line.cost, 10),
      amount_usdt: display(amount),
      requests: line.requests,
    }
  })
  const adjustment = decimal(input.adjustment, 6, true),
    total = subtotal + adjustment
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) fail('settlement_amount_too_large', '结算金额超出支持范围')
  if (total < 0n) fail('negative_settlement_total', '调整后的结算总额不能为负数')
  const snapshot = {
    source: 'usage_logs_v2',
    ...input,
    vendor_id: payee.id,
    vendor_name: payee.name,
    binance_id: payee.binance_id || '',
    payer_vendor_id: identity.vendor.id,
    contract_id: contract.id,
    contract_version: contract.version,
    multiplier: display(multiplier, 10),
    cost_basis: 'official_usd',
    coefficient_unit: 'CNY/USD',
    currency: 'USDT',
    snapshot_at: snapshotAt,
    available_count: available.length,
    occupied_count: rows.length - available.length,
    cost_usd: display(totalCost, 10),
    subtotal_usdt: display(subtotal),
    total_usdt: display(total),
    lines,
  }
  return {
    snapshot,
    available,
    dataHash: hash({ snapshot, rows: available.map(({ occupied, watermark, ...row }) => row) }),
  }
}
export function previewDownstreamSettlements(platform, identity, body = {}, { now = Date.now() } = {}) {
  const ids = [...new Set((Array.isArray(body.vendor_ids) ? body.vendor_ids : []).map(String))]
  if (!ids.length || ids.length > 20) fail('invalid_settlement_vendors', '请选择 1–20 个下游供应商')
  const input = normalizeInput(body)
  return withTransaction(platform.db, () => {
    const stamp = new Date(now).toISOString(),
      expires = new Date(now + 15 * 60000).toISOString()
    platform.db.prepare('DELETE FROM vendor_settlement_previews WHERE expires_at<? AND statement_id IS NULL').run(stamp)
    const watermark = platform.db
      .prepare(
        'SELECT MAX((SELECT COALESCE(MAX(rowid),0) FROM usage_logs),(SELECT COALESCE(MAX(rowid),0) FROM vendor_usage_facts)) value',
      )
      .get().value
    return {
      items: ids.map((id) => {
        const payee = requirePayer(platform, identity, id),
          contract = contractFor(platform, identity, payee, input)
        const result = buildSnapshot(platform, identity, payee, contract, input, watermark, stamp)
        const token = crypto.randomBytes(32).toString('base64url')
        platform.db
          .prepare(
            'INSERT INTO vendor_settlement_previews(token_hash,actor_user_id,payer_vendor_id,payee_vendor_id,contract_id,input_json,snapshot_json,data_hash,watermark,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
          )
          .run(
            hash(token),
            identity.user_id,
            identity.vendor.id,
            payee.id,
            contract.id,
            JSON.stringify(input),
            JSON.stringify(result.snapshot),
            result.dataHash,
            watermark,
            expires,
            stamp,
          )
        return {
          vendor_id: id,
          preview_token: token,
          expires_at: expires,
          available_count: result.snapshot.available_count,
          occupied_count: result.snapshot.occupied_count,
          statement: result.snapshot,
        }
      }),
    }
  })
}
function statement(platform, id) {
  const row = platform.db.prepare('SELECT * FROM vendor_settlements WHERE id=?').get(id)
  if (!row) return null
  const { usage_snapshot_json, idempotency_key, input_hash, created_by, ...publicRow } = row
  const snapshot = parse(usage_snapshot_json)
  return {
    ...publicRow,
    usage: { ...snapshot, ...(snapshot.usage || {}) },
    paid_usdt: platform.db
      .prepare("SELECT COALESCE(SUM(amount_usdt),0) n FROM vendor_payments WHERE settlement_id=? AND action='payment'")
      .get(id).n,
    payments: platform.db
      .prepare(
        'SELECT id,amount_usdt,action,reason,created_at FROM vendor_payments WHERE settlement_id=? ORDER BY created_at,id',
      )
      .all(id),
  }
}
export function createDownstreamSettlement(platform, identity, body = {}, { now = Date.now() } = {}) {
  const key = String(body.idempotency_key || ''),
    token = String(body.preview_token || '')
  if (!/^[a-zA-Z0-9_.:-]{8,128}$/.test(key) || !token)
    fail('settlement_preview_required', '请先预览结算，再提交有效的幂等标识')
  return withTransaction(platform.db, () => {
    const old = platform.db
      .prepare('SELECT id,input_hash,contract_id FROM vendor_settlements WHERE created_by=? AND idempotency_key=?')
      .get(identity.user_id, key)
    const preview = platform.db
      .prepare('SELECT * FROM vendor_settlement_previews WHERE token_hash=? AND actor_user_id=? AND payer_vendor_id=?')
      .get(hash(token), identity.user_id, identity.vendor.id)
    if (!preview) fail('settlement_preview_not_found', '结算预览不存在或不属于当前账号', 404)
    const payee = requirePayer(platform, identity, preview.payee_vendor_id)
    if (old) {
      if (old.input_hash !== hash(token)) fail('idempotency_conflict', '幂等标识已用于另一份预览', 409)
      return statement(platform, old.id)
    }
    if (preview.statement_id) return statement(platform, preview.statement_id)
    if (Date.parse(preview.expires_at) <= now) fail('settlement_preview_expired', '预览已过期，请重新预览', 409)
    const contract = contractFor(platform, identity, payee, parse(preview.input_json))
    const result = buildSnapshot(
      platform,
      identity,
      payee,
      contract,
      parse(preview.input_json),
      preview.watermark,
      preview.created_at,
    )
    if (result.dataHash !== preview.data_hash)
      fail('settlement_preview_changed', '合同或用量状态已变化，请重新预览', 409)
    if (!result.available.length) fail('settlement_no_usage', '当前范围没有未结算用量', 409)
    const id = 'settlement_' + crypto.randomUUID(),
      stamp = new Date(now).toISOString()
    platform.db
      .prepare(
        "INSERT INTO vendor_settlements(id,contract_id,period_start,period_end,status,amount_usdt,usage_snapshot_json,created_by,created_at,updated_at,idempotency_key,input_hash) VALUES (?,?,?,?,'draft',?,?,?,?,?,?,?)",
      )
      .run(
        id,
        contract.id,
        result.snapshot.start_at,
        result.snapshot.end_at,
        Number(result.snapshot.total_usdt),
        JSON.stringify(result.snapshot),
        identity.user_id,
        stamp,
        stamp,
        key,
        hash(token),
      )
    const allocate = platform.db.prepare(
      'INSERT INTO vendor_settlement_allocations(statement_id,usage_log_id,payer_vendor_id,payee_vendor_id,snapshot_json) VALUES (?,?,?,?,?)',
    )
    for (const row of result.available) allocate.run(id, row.id, identity.vendor.id, payee.id, JSON.stringify(row))
    platform.db.prepare('UPDATE vendor_settlement_previews SET statement_id=? WHERE token_hash=?').run(id, hash(token))
    platform.audit({
      actorUserId: identity.user_id,
      vendorId: identity.vendor.id,
      action: 'settlement.draft_created',
      resourceType: 'settlement',
      resourceId: id,
      payload: { payee_vendor_id: payee.id, requests: result.available.length },
    })
    return statement(platform, id)
  })
}
export function mutateDownstreamSettlement(platform, identity, id, action, body = {}) {
  if (!['confirm', 'payments', 'void'].includes(action)) fail('invalid_settlement_action', '结算操作无效')
  return withTransaction(platform.db, () => {
    const row = platform.db
      .prepare(
        'SELECT s.*,c.payer_vendor_id,c.payee_vendor_id FROM vendor_settlements s JOIN vendor_contracts c ON c.id=s.contract_id WHERE s.id=?',
      )
      .get(id)
    if (!row || row.payer_vendor_id !== identity.vendor.id) fail('settlement_payer_scope', '账单不属于当前供应商', 403)
    requirePayer(platform, identity, row.payee_vendor_id)
    platform.requireCapability(identity, 'vendor.settlement.pay')
    if (action === 'payments') return settlementAction(platform, id, action, body, identity.user_id, identity.vendor.id)
    const status = action === 'confirm' ? 'confirmed' : 'void'
    if (row.status === status) return statement(platform, id)
    if (action === 'confirm' && !['draft', 'review'].includes(row.status))
      fail('invalid_settlement_state', '仅草稿可以确认', 409)
    if (
      action === 'void' &&
      (!['draft', 'review', 'confirmed'].includes(row.status) ||
        platform.db.prepare('SELECT 1 FROM vendor_payments WHERE settlement_id=?').get(id))
    )
      fail('invalid_settlement_state', '当前账单不能作废', 409)
    const reason = String(body.reason || '').trim()
    if (action === 'void' && (!reason || reason.length > 1000)) fail('settlement_reason_required', '请填写作废原因')
    const stamp = new Date().toISOString()
    platform.db
      .prepare('UPDATE vendor_settlements SET status=?,confirmed_at=?,updated_at=? WHERE id=?')
      .run(status, action === 'confirm' ? stamp : row.confirmed_at, stamp, id)
    if (action === 'void')
      platform.db
        .prepare('UPDATE vendor_settlement_allocations SET released_at=? WHERE statement_id=? AND released_at IS NULL')
        .run(stamp, id)
    platform.audit({
      actorUserId: identity.user_id,
      vendorId: identity.vendor.id,
      action: 'settlement.' + action,
      resourceType: 'settlement',
      resourceId: id,
      payload: { reason },
    })
    return statement(platform, id)
  })
}
export function supplierBilling(platform, identity) {
  platform.requireCapability(identity, 'vendor.settlement.read')
  const rows = platform.db
    .prepare(`SELECT s.id,c.payer_vendor_id,c.payee_vendor_id,v.name AS vendor_name,p.name AS payer_name,c.version AS contract_version
    FROM vendor_settlements s JOIN vendor_contracts c ON c.id=s.contract_id JOIN vendors v ON v.id=c.payee_vendor_id LEFT JOIN vendors p ON p.id=c.payer_vendor_id
    WHERE c.payee_vendor_id=? OR (c.payer_vendor_id=? AND v.parent_id=?) ORDER BY s.created_at DESC,s.id DESC`)
    .all(identity.vendor.id, identity.vendor.id, identity.vendor.id)
  const upstream = [],
    downstream = []
  for (const row of rows) {
    const item = statement(platform, row.id)
    if (row.payee_vendor_id === identity.vendor.id) {
      if (!['draft', 'void'].includes(item.status))
        upstream.push({
          ...item,
          contract_version: row.contract_version,
          direction: 'upstream',
          counterparty_name: row.payer_name || null,
        })
    } else if (identity.vendor.tier === 1 && identity.vendor.capabilities.includes('vendor.create_child'))
      downstream.push({
        ...item,
        contract_version: row.contract_version,
        direction: 'downstream',
        counterparty_name: row.vendor_name,
      })
  }
  return {
    upstream,
    downstream,
    profile: {
      binance_id: identity.vendor.binance_id,
      default_price_cny_per_usd: identity.vendor.default_price_cny_per_usd,
      fx_cny_per_usdt: identity.vendor.fx_cny_per_usdt,
      default_multiplier: identity.vendor.default_multiplier,
      group_prices: identity.vendor.group_prices,
      contract_version: identity.vendor.contract_version,
    },
  }
}
