import { dbTime, SYSTEM_TIMEZONE } from '../../shared/system-time.mjs'
import { quoteUsagePricing, decimalUnits as decimal, decimalText as display } from './vendor-pricing.mjs'
import { fromMicros, rowMicros } from '../core/money.mjs'
import crypto from 'node:crypto'
import { dbClient } from '../db/db-client.mjs'
import { zonedWallToMs } from '../core/timezone.mjs'
import { settlementAction, vendorIds } from './vendor-admin.mjs'
import { VendorError } from './vendor-platform.mjs'
import { createSettlementSnapshot } from '../usage/settlement-snapshot.mjs'
import {
  deleteExpiredSettlementPreviews,
  insertSettlement,
  insertSettlementPreview,
  insertSettlementAllocations,
  legacySettlementPeriods,
  linkSettlementPreview,
  releaseSettlementAllocations,
  settlementById,
  settlementByIdempotencyKey,
  settlementPaidTotal,
  settlementPaymentExists,
  settlementPayments,
  settlementPreviewForActor,
  settlementSnapshotRows,
  settlementWatermark,
  supplierSettlementRows,
  updateSettlementStatus,
} from './repos/settlements-repo.mjs'
import { listOverlappingSettlements } from './repos/admin-settlements-repo.mjs'

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
async function requirePayer(platform, identity, vendorId) {
  await platform.requireActive(identity)
  await platform.requireCapability(identity, 'vendor.settlement.read')
  await platform.requireCapability(identity, 'vendor.create_child')
  const payee = await platform.vendorRow(vendorId)
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
  const timezone = SYSTEM_TIMEZONE
  const from = zonedWallToMs(start, timezone),
    until = zonedWallToMs({ ...end, day: end.day + 1 }, timezone)
  if (from >= until || until - from > 367 * 86400000)
    fail('invalid_settlement_period', '结束日期不能早于开始日期，账期最长一年')
  if (body.exchange_rate != null || body.exchange_rate_source != null)
    fail('pricing_settings_required', '汇率由全局结算设置按生效日期确定')
  const adjustment = decimal(body.adjustment ?? '0', 6, true),
    reason = String(body.adjustment_reason || '').trim()
  if ((adjustment !== 0n && !reason) || reason.length > 1000) fail('invalid_settlement_reason', '请填写调整原因')
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
    adjustment: display(adjustment),
    adjustment_reason: reason,
    account_id: account,
    group_id: groupId,
    platform: provider,
  }
}
// 平台向一级供应商结算（payer 为 null）：用量含其直属下级；下游结算只含收款方自身用量。
async function usageVendorIds(platform, payerId, payee) {
  return payerId ? [payee.id] : vendorIds(platform, payee.id)
}
async function requirePlatformPayee(platform, vendorId) {
  const payee = await platform.vendorRow(vendorId)
  if (!payee || payee.tier !== 1) fail('invalid_settlement_vendor', '请选择一级供应商', 409)
  return payee
}
async function buildSnapshot(platform, payerId, payee, input, watermark, snapshotAt) {
  const db = platform.db
  const ids = await usageVendorIds(platform, payerId, payee)
  const rows = await settlementSnapshotRows(db, payerId, payee.id, ids, input, watermark, snapshotAt)
  if (rows.length > 50000) fail('settlement_too_large', '记录超过 50000 条，请缩短结算账期')
  // Previously issued invoices had no per-request allocation. Preserve their paid/held periods.
  const legacy = await legacySettlementPeriods(db, payerId, payee.id)
  const available = rows.filter(
    (row) =>
      !row.occupied &&
      !legacy.some((period) => row.created_at >= period.period_start && row.created_at < period.period_end),
  )
  // Freeze the usage facts before pricing. The legacy SQL row shape remains
  // unchanged, while the snapshot layer makes unknown amounts explicit and
  // prevents a future reader from silently treating them as zero.
  const factsSnapshot = createSettlementSnapshot({
    rows: available.map((row) => ({ ...row, cost_usd: row.total_cost, cost_usd_micros: rowMicros(row, 'total_cost') })),
    periodStart: input.start_at,
    periodEnd: input.end_at,
  })
  if (
    available.some(
      (row) =>
        row.pricing_model === 'unpriced' || rowMicros(row, 'total_cost') == null || rowMicros(row, 'total_cost') < 0,
    )
  )
    fail('settlement_unpriced_usage', '存在未定价用量，请先补齐价格后再结算', 409)
  const quote = await quoteUsagePricing(platform, payee.id, payerId, available, {
    emptyAt: new Date(Math.min(Date.parse(input.end_at), Date.parse(snapshotAt)) - 1).toISOString(),
  })
  const subtotal = decimal(quote.subtotal_usdt, 6)
  const adjustment = decimal(input.adjustment, 6, true),
    total = subtotal + adjustment
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) fail('settlement_amount_too_large', '结算金额超出支持范围')
  if (total < 0n) fail('negative_settlement_total', '调整后的结算总额不能为负数')
  const snapshot = {
    source: 'usage_logs_v2',
    ...input,
    vendor_id: payee.id,
    vendor_name: payee.name,
    payer_vendor_id: payerId,
    contract_id: quote.contract_id,
    contract_version: quote.contract_version,
    pricing_versions: quote.pricing_versions,
    pricing_basis: 'request_time',
    cost_basis: 'official_usd',
    coefficient_unit: 'CNY/USD',
    currency: 'USDT',
    snapshot_at: snapshotAt,
    available_count: available.length,
    amount_known: factsSnapshot.amount_known,
    occupied_count: rows.length - available.length,
    usage: quote.usage,
    accounts: quote.accounts,
    cost_usd: quote.cost_usd,
    subtotal_usdt: display(subtotal),
    total_usdt: display(total),
    lines: quote.lines,
  }
  return {
    snapshot,
    available,
    dataHash: hash({ snapshot, rows: available.map(({ occupied, watermark, ...row }) => row) }),
  }
}
export async function previewDownstreamSettlements(platform, identity, body = {}, { now = Date.now() } = {}) {
  const ids = [...new Set((Array.isArray(body.vendor_ids) ? body.vendor_ids : []).map(String))]
  if (!ids.length || ids.length > 20) fail('invalid_settlement_vendors', '请选择 1–20 个下游供应商')
  const input = normalizeInput(body)
  return dbClient(platform.db).tx(async () => {
    // 预览的 snapshot_at 会进 data_hash，确认时从库里读回同一行重算：两处必须是同一表示形式，
    // 否则确认必然报 settlement_preview_changed（时间戳按 UTC+8 存储，system-time.mjs dbTime）
    const stamp = dbTime(now),
      expires = dbTime(now + 15 * 60000)
    await deleteExpiredSettlementPreviews(platform.db, stamp)
    const watermark = (await settlementWatermark(platform.db)).value
    // 逐个供应商顺序处理（事务内有写入），结果顺序与请求一致
    const items = []
    for (const id of ids) {
      const payee = await requirePayer(platform, identity, id)
      const result = await buildSnapshot(platform, identity.vendor.id, payee, input, watermark, stamp)
      const token = crypto.randomBytes(32).toString('base64url')
      await insertSettlementPreview(
        platform.db,
        hash(token),
        identity.user_id,
        identity.vendor.id,
        payee.id,
        result.snapshot.contract_id,
        JSON.stringify(input),
        JSON.stringify(result.snapshot),
        result.dataHash,
        watermark,
        expires,
        stamp,
      )
      items.push({
        vendor_id: id,
        preview_token: token,
        expires_at: expires,
        available_count: result.snapshot.available_count,
        occupied_count: result.snapshot.occupied_count,
        statement: result.snapshot,
      })
    }
    return { items }
  })
}
async function statement(platform, id) {
  const row = await settlementById(platform.db, id)
  if (!row) return null
  const { usage_snapshot_json, idempotency_key, input_hash, created_by, ...publicRow } = row
  const snapshot = parse(usage_snapshot_json)
  return {
    ...publicRow,
    usage: { ...snapshot, ...(snapshot.usage || {}) },
    paid_usdt: (await settlementPaidTotal(platform.db, id)).n,
    payments: await settlementPayments(platform.db, id),
  }
}
// 平台与下游共用：按服务端预览重建快照，数据未变才开单，并逐条占用用量（同一付款边上一条请求只能有一张有效账单）。
async function createFromPreview(platform, { actorUserId, payerId, body, now, resolvePayee, status, auditAction }) {
  const key = String(body.idempotency_key || ''),
    token = String(body.preview_token || '')
  if (!/^[a-zA-Z0-9_.:-]{8,128}$/.test(key) || !token)
    fail('settlement_preview_required', '请先预览结算，再提交有效的幂等标识')
  // 竞态 R20：同一幂等标识按同一规则返回已开出的账单或幂等冲突；写入用 ON CONFLICT DO NOTHING，
  // 并发重复提交时读回先写入的一条，而不是撞唯一索引报错。
  const replay = (old) => {
    if (old.input_hash !== hash(token)) fail('idempotency_conflict', '幂等标识已用于另一份预览', 409)
    return statement(platform, old.id)
  }
  return dbClient(platform.db).tx(async () => {
    const old = await settlementByIdempotencyKey(platform.db, actorUserId, key)
    const preview = await settlementPreviewForActor(platform.db, hash(token), actorUserId, payerId)
    if (!preview) fail('settlement_preview_not_found', '结算预览不存在或不属于当前账号', 404)
    const payee = await resolvePayee(preview.payee_vendor_id)
    if (old) return replay(old)
    if (preview.statement_id) return statement(platform, preview.statement_id)
    if (Date.parse(preview.expires_at) <= now) fail('settlement_preview_expired', '预览已过期，请重新预览', 409)
    const result = await buildSnapshot(
      platform,
      payerId,
      payee,
      parse(preview.input_json),
      preview.watermark,
      preview.created_at,
    )
    if (result.dataHash !== preview.data_hash)
      fail('settlement_preview_changed', '合同或用量状态已变化，请重新预览', 409)
    if (!result.available.length) fail('settlement_no_usage', '当前范围没有未结算用量', 409)
    const id = 'settlement_' + crypto.randomUUID(),
      stamp = new Date(now).toISOString()
    const inserted = await insertSettlement(
      platform.db,
      id,
      result.snapshot.contract_id,
      result.snapshot.start_at,
      result.snapshot.end_at,
      status,
      Number(decimal(result.snapshot.total_usdt, 6)),
      fromMicros(Number(decimal(result.snapshot.total_usdt, 6))),
      JSON.stringify(result.snapshot),
      actorUserId,
      stamp,
      stamp,
      key,
      hash(token),
      payerId,
      payee.id,
    )
    if (!inserted.changes) return replay(await settlementByIdempotencyKey(platform.db, actorUserId, key))
    await insertSettlementAllocations(platform.db, id, payerId, payee.id, result.available)
    await linkSettlementPreview(platform.db, id, hash(token))
    await platform.audit({
      actorUserId,
      vendorId: payerId || payee.id,
      action: auditAction,
      resourceType: 'settlement',
      resourceId: id,
      payload: {
        payee_vendor_id: payee.id,
        period_start: result.snapshot.start_at,
        period_end: result.snapshot.end_at,
        requests: result.available.length,
        amount_usdt: Number(result.snapshot.total_usdt),
      },
    })
    return statement(platform, id)
  })
}
export async function createDownstreamSettlement(platform, identity, body = {}, { now = Date.now() } = {}) {
  return createFromPreview(platform, {
    actorUserId: identity.user_id,
    payerId: identity.vendor.id,
    body,
    now,
    resolvePayee: (id) => requirePayer(platform, identity, id),
    status: 'draft',
    auditAction: 'settlement.draft_created',
  })
}
/** 平台向一级供应商的结算预览：与下游相同的逐条占用快照，另附与该周期重叠的有效账单供核对。 */
export async function previewPlatformSettlement(platform, actor, body = {}, { now = Date.now() } = {}) {
  const input = normalizeInput(body)
  if (Date.parse(input.end_at) > now) fail('future_settlement', '不能结算尚未结束的日期', 409)
  return dbClient(platform.db).tx(async () => {
    // 预览的 snapshot_at 会进 data_hash，确认时从库里读回同一行重算：两处必须是同一表示形式，
    // 否则确认必然报 settlement_preview_changed（时间戳按 UTC+8 存储，system-time.mjs dbTime）
    const stamp = dbTime(now),
      expires = dbTime(now + 15 * 60000)
    await deleteExpiredSettlementPreviews(platform.db, stamp)
    const payee = await requirePlatformPayee(platform, String(body.vendor_id || ''))
    const watermark = (await settlementWatermark(platform.db)).value
    const result = await buildSnapshot(platform, null, payee, input, watermark, stamp)
    const token = crypto.randomBytes(32).toString('base64url')
    await insertSettlementPreview(
      platform.db,
      hash(token),
      actor,
      null,
      payee.id,
      result.snapshot.contract_id,
      JSON.stringify(input),
      JSON.stringify(result.snapshot),
      result.dataHash,
      watermark,
      expires,
      stamp,
    )
    const overlaps = await listOverlappingSettlements(platform.db, payee.id, null, input.end_at, input.start_at)
    return {
      vendor_id: payee.id,
      preview_token: token,
      expires_at: expires,
      available_count: result.snapshot.available_count,
      occupied_count: result.snapshot.occupied_count,
      statement: result.snapshot,
      overlaps: overlaps.map((row) => ({
        id: row.id,
        status: row.status,
        period_start: row.period_start,
        period_end: row.period_end,
        amount_usdt: row.amount_usdt,
      })),
    }
  })
}
export async function createPlatformSettlement(platform, actor, body = {}, { now = Date.now() } = {}) {
  return createFromPreview(platform, {
    actorUserId: actor,
    payerId: null,
    body,
    now,
    resolvePayee: (id) => requirePlatformPayee(platform, id),
    status: 'review',
    auditAction: 'settlement.created',
  })
}
export async function mutateDownstreamSettlement(platform, identity, id, action, body = {}) {
  if (!['confirm', 'payments', 'void'].includes(action)) fail('invalid_settlement_action', '结算操作无效')
  return dbClient(platform.db).tx(async () => {
    const row = await settlementById(platform.db, id)
    if (!row || row.payer_vendor_id !== identity.vendor.id) fail('settlement_payer_scope', '账单不属于当前供应商', 403)
    await requirePayer(platform, identity, row.payee_vendor_id)
    await platform.requireCapability(identity, 'vendor.settlement.pay')
    if (action === 'payments') return settlementAction(platform, id, action, body, identity.user_id, identity.vendor.id)
    const status = action === 'confirm' ? (rowMicros(row, 'amount_usdt') === 0 ? 'paid' : 'confirmed') : 'void'
    if (action === 'confirm' && ['confirmed', 'partial', 'paid'].includes(row.status)) return statement(platform, id)
    if (row.status === status) return statement(platform, id)
    if (action === 'confirm' && !['draft', 'review'].includes(row.status))
      fail('invalid_settlement_state', '仅草稿可以确认', 409)
    if (
      action === 'void' &&
      (!['draft', 'review', 'confirmed'].includes(row.status) || (await settlementPaymentExists(platform.db, id)))
    )
      fail('invalid_settlement_state', '当前账单不能作废', 409)
    const reason = String(body.reason || '').trim()
    if (action === 'void' && (!reason || reason.length > 1000)) fail('settlement_reason_required', '请填写作废原因')
    const stamp = new Date().toISOString()
    await updateSettlementStatus(platform.db, status, action === 'confirm' ? stamp : row.confirmed_at, stamp, id)
    if (action === 'void') await releaseSettlementAllocations(platform.db, stamp, id)
    await platform.audit({
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
export async function supplierBilling(platform, identity) {
  await platform.requireCapability(identity, 'vendor.settlement.read')
  const rows = await supplierSettlementRows(platform.db, identity.vendor.id)
  const upstream = [],
    downstream = []
  for (const row of rows) {
    const item = await statement(platform, row.id)
    if (row.payee_vendor_id === identity.vendor.id) {
      if (!['draft', 'void'].includes(item.status))
        upstream.push({
          ...item,
          contract_version: item.usage.contract_version ?? null,
          direction: 'upstream',
          counterparty_name: row.payer_name || null,
        })
    } else if (identity.vendor.tier === 1 && identity.vendor.capabilities.includes('vendor.create_child'))
      downstream.push({
        ...item,
        contract_version: item.usage.contract_version ?? null,
        direction: 'downstream',
        counterparty_name: row.vendor_name,
      })
  }
  return {
    upstream,
    downstream,
  }
}
