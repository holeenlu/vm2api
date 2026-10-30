import {quoteUsagePricing,settlementUsageRows} from './vendor-pricing.mjs'
// Native adaptation of holeenlu/sub2api supplier administration workflows.
// Source reference: 0276190e775b369319acc18bc1c120a4469a71ae, VendorsView.vue
// and vendor workbenches. Shares vm2api's existing supplier domain and tables.
import crypto from 'node:crypto'
import { withTransaction } from '../db/database.mjs'
import {
  VendorError,
  CAPABILITIES,
  projectResource,
  rejectInlinePricing,
} from './vendor-platform.mjs'
import { usagePeriod } from './vendor-usage.mjs'
const stamp = () => new Date().toISOString()
const uid = (kind) => `${kind}_${crypto.randomUUID()}`
const round = (value) => Math.round(value * 1e6) / 1e6
const fail = (code, message, status = 400) => {
  throw new VendorError(code, message, status)
}

export function adminVendorIdentity(platform, vendorId, actor) {
  const vendor = platform.getVendor(vendorId)
  if (!vendor) fail('vendor_not_found', '供应商不存在', 404)
  return {
    user_id: actor,
    system_admin: true,
    vendor: { ...vendor, remark: platform.vendorRow(vendorId).remark || '', capabilities: CAPABILITIES },
  }
}
export function vendorIds(platform, vendorId, children = true) {
  if (!vendorId || vendorId === 'all')
    return platform.db
      .prepare('SELECT id FROM vendors WHERE deleted_at IS NULL')
      .all()
      .map((r) => r.id)
  const vendor = platform.getVendor(vendorId)
  if (!vendor) fail('vendor_not_found', '供应商不存在', 404)
  return [
    vendor.id,
    ...(children && vendor.tier === 1
      ? platform.db
          .prepare('SELECT id FROM vendors WHERE parent_id=? AND deleted_at IS NULL')
          .all(vendor.id)
          .map((r) => r.id)
      : []),
  ]
}
export function adminVendors(platform) {
  const members = platform.db
    .prepare(`SELECT m.vendor_id,u.id,u.username FROM vendor_members m JOIN users u ON u.id=m.user_id
    WHERE m.status='active' AND u.deleted_at IS NULL ORDER BY m.is_primary DESC,m.created_at,m.id`)
    .all()
  const counts = platform.db
    .prepare(`SELECT vendor_id,resource_type,COUNT(*) AS n FROM vendor_resources
    WHERE status<>'archived' GROUP BY vendor_id,resource_type`)
    .all()
  return platform.db
    .prepare('SELECT id,remark FROM vendors WHERE deleted_at IS NULL ORDER BY tier,name,id')
    .all()
    .map(({ id, remark }) => {
      const vendor = platform.getVendor(id)
      const scope = vendorIds(platform, id)
      const count = (type) =>
        counts.filter((r) => scope.includes(r.vendor_id) && r.resource_type === type).reduce((n, r) => n + r.n, 0)
      return {
        ...vendor,
        remark,
        members: members.filter((m) => m.vendor_id === id),
        account_count: count('account'),
        proxy_count: count('proxy'),
      }
    })
}
export function adminResources(platform, type, query = {}) {
  const ids = vendorIds(platform, query.vendor_id, query.include_children === true)
  return platform.db
    .prepare(`SELECT r.* FROM vendor_resources r WHERE r.resource_type=? ${type === 'account' ? '' : "AND r.status<>'archived'"}
    AND r.vendor_id IN (${ids.map(() => '?').join(',') || 'NULL'}) ORDER BY r.created_at DESC,r.id`)
    .all(type, ...ids)
    .map((r) => projectResource(r))
}
export function updateAdminVendor(platform, id, body, actor) {
  rejectInlinePricing(body)
  const row = platform.getVendor(id)
  if (!row) fail('vendor_not_found', '供应商不存在', 404)
  const keys = [
    'status',
    'groups',
    'platforms',
    'account_limit',
    'proxy_limit',
    'child_limit',
    'remark',
    'create_child',
    'settlement_pay',
  ]
  if (Object.keys(body).some((k) => !keys.includes(k))) fail('invalid_vendor_patch', '包含不允许修改的供应商字段')
  if (body.create_child != null && typeof body.create_child !== 'boolean')
    fail('invalid_capability', '下级供应商开关须为布尔值')
  if (body.settlement_pay != null && typeof body.settlement_pay !== 'boolean')
    fail('invalid_capability', '结算付款开关须为布尔值')
  if (row.status === 'archived') fail('vendor_archived', '已归档供应商只读', 409)
  const next = { ...row, remark: platform.vendorRow(id).remark || '', ...body }
  if (typeof next.remark !== 'string' || next.remark.length > 1000)
    fail('invalid_vendor_remark', '备注不能超过 1000 个字符')
  next.remark = next.remark.trim()
  if (!['active', 'disabled', 'archived'].includes(next.status)) fail('invalid_vendor_status', '供应商状态无效')
  for (const key of ['account_limit', 'proxy_limit', 'child_limit'])
    if (!Number.isSafeInteger(next[key]) || next[key] < 0) fail('invalid_limit', '资源上限须为非负整数')
  for (const key of ['groups', 'platforms']) {
    if (!Array.isArray(next[key])) fail('invalid_scope', '分组和平台必须为数组')
    next[key] = [...new Set(next[key].map(String))]
  }
  if (next.platforms.some((p) => !['anthropic', 'openai'].includes(p))) fail('invalid_platform', '不支持的供应平台')
  const groupIds = new Set(
    platform.db
      .prepare('SELECT id FROM groups WHERE deleted_at IS NULL')
      .all()
      .map((r) => String(r.id)),
  )
  if (next.groups.some((g) => !groupIds.has(g))) fail('invalid_group', '分组不存在')
  const relations =
    row.tier === 2
      ? [[next, platform.getVendor(row.parent_id)]]
      : platform.db
          .prepare('SELECT id FROM vendors WHERE parent_id=? AND deleted_at IS NULL')
          .all(id)
          .map((r) => [platform.getVendor(r.id), next])
  for (const [child, parent] of relations) {
    if (!parent) fail('vendor_parent_inactive', '父级供应商不存在', 409)
    if (
      (parent.groups.length && child.groups.some((g) => !parent.groups.includes(g))) ||
      (parent.platforms.length && child.platforms.some((p) => !parent.platforms.includes(p)))
    )
      fail('parent_scope_violation', '请先调整下级供应商的分组或平台', 409)
    for (const key of ['account_limit', 'proxy_limit'])
      if (parent[key] > 0 && (child[key] === 0 || child[key] > parent[key]))
        fail('quota_exceeds_parent', '下级供应商额度不能超过父级', 409)
  }
  if (row.tier === 2 && (body.create_child || body.settlement_pay))
    fail('child_vendor_forbidden', '二级供应商不能创建下级', 409)
  const inventory = adminVendors(platform).find((v) => v.id === id)
  if (
    (next.account_limit && inventory.account_count > next.account_limit) ||
    (next.proxy_limit && inventory.proxy_count > next.proxy_limit)
  )
    fail('limit_below_usage', '资源上限低于当前已用数量', 409)
  return withTransaction(platform.db, () => {
    const ts = stamp()
    platform.db
      .prepare(
        `UPDATE vendors SET status=?,groups_json=?,platforms_json=?,account_limit=?,proxy_limit=?,child_limit=?,remark=?,policy_revision=policy_revision+1,updated_at=? WHERE id=?`,
      )
      .run(
        next.status,
        JSON.stringify(next.groups),
        JSON.stringify(next.platforms),
        next.account_limit,
        next.proxy_limit,
        next.child_limit,
        next.remark,
        ts,
        id,
      )
    for (const [field, capability] of [
      ['create_child', 'vendor.create_child'],
      ['settlement_pay', 'vendor.settlement.pay'],
    ]) {
      if (body[field] != null)
        platform.db
          .prepare(`INSERT INTO vendor_capabilities (vendor_id,capability,enabled,revision,created_at,updated_at)
        VALUES (?,?,?,1,?,?) ON CONFLICT(vendor_id,capability) DO UPDATE SET enabled=excluded.enabled,revision=revision+1,updated_at=excluded.updated_at`)
          .run(id, capability, body[field] ? 1 : 0, ts, ts)
    }

    platform.audit({
      actorUserId: actor,
      vendorId: id,
      action: 'vendor.admin_updated',
      payload: { fields: Object.keys(body), status: next.status },
    })
    return { ...platform.getVendor(id), remark: next.remark }
  })
}

export function listSettlements(platform, query = {}) {
  const ids = vendorIds(platform, query.vendor_id, query.include_children === true)
  return platform.db
    .prepare(`SELECT s.*,v.name AS vendor_name,
      COALESCE((SELECT SUM(p.amount_usdt) FROM vendor_payments p WHERE p.settlement_id=s.id AND p.action='payment'),0) AS paid_usdt
    FROM vendor_settlements s JOIN vendors v ON v.id=s.payee_vendor_id
    WHERE s.payee_vendor_id IN (${ids.map(()=>'?').join(',')||'NULL'}) ORDER BY s.created_at DESC,s.id`)
    .all(...ids)
    .map((row) => {
      const { usage_snapshot_json, ...rest } = row
      return {
        ...rest,
        usage: JSON.parse(usage_snapshot_json || '{}'),
        payments: platform.db
          .prepare(
            'SELECT id,amount_usdt,action,reason,created_at FROM vendor_payments WHERE settlement_id=? ORDER BY created_at,id',
          )
          .all(row.id),
      }
    })
}
export function settlementPreview(platform, vendorId, body = {}, payerId = null) {
  const vendor = platform.getVendor(vendorId)
  if (!vendor || (payerId ? vendor.parent_id !== payerId : vendor.tier !== 1))
    fail('invalid_settlement_vendor', '请选择当前付款方的直属供应商', 409)
  if (!body.start_date || !body.end_date) fail('invalid_period', '请选择结算开始和结束时间')
  const period = usagePeriod(body)
  if (period.end > stamp()) fail('future_settlement', '不能结算尚未结束的周期', 409)
  const quote=quoteUsagePricing(platform,vendorId,payerId,settlementUsageRows(platform,vendorIds(platform,vendorId),period),{emptyAt:new Date(Date.parse(period.end)-1).toISOString()})
  const preview={vendor_id:vendorId,vendor_name:vendor.name,period_start:period.start,period_end:period.end,
    ...quote,rate_breakdown:quote.lines,pricing_basis:'request_time'}
  return { ...preview, preview_token: crypto.createHash('sha256').update(JSON.stringify(preview)).digest('hex') }
}
export function createSettlement(platform, vendorId, body, actor, payerId = null) {
  return withTransaction(platform.db, () => {
    const vendor = platform.getVendor(vendorId)
    if (!vendor || (payerId ? vendor.parent_id !== payerId : vendor.tier !== 1))
      fail('invalid_settlement_vendor', '结算供应商不属于当前付款边', 403)
    const period = usagePeriod(body)
    const previous = platform.db
      .prepare(`SELECT s.* FROM vendor_settlements s
      WHERE s.payee_vendor_id=? AND s.payer_vendor_id IS ? AND s.period_start=? AND s.period_end=? AND s.status<>'void'`)
      .get(vendorId, payerId, period.start, period.end)
    if (previous) return previous
    const voided = platform.db
      .prepare(`SELECT 1 FROM vendor_settlements s
      WHERE s.payee_vendor_id=? AND s.payer_vendor_id IS ? AND s.period_start=? AND s.period_end=? AND s.status='void'`)
      .get(vendorId, payerId, period.start, period.end)
    if (voided) fail('settlement_period_voided', '该结算周期已有作废记录，请使用新的结算周期', 409)
    const preview = settlementPreview(platform, vendorId, body, payerId)
    if (body.preview_token != null && body.preview_token !== preview.preview_token)
      fail('settlement_preview_changed', '用量或合同已变化，请重新预览结算', 409)
    if (
      body.expected_amount_usdt != null &&
      Number(body.expected_amount_usdt) !== preview.amount_usdt
    )
      fail('settlement_preview_changed', '用量或合同已变化，请重新预览结算', 409)
    const existing = platform.db
      .prepare(`SELECT s.* FROM vendor_settlements s
      WHERE s.payee_vendor_id=? AND s.payer_vendor_id IS ? AND s.status<>'void' AND s.period_start<? AND s.period_end>?`)
      .all(vendorId, payerId, preview.period_end, preview.period_start)
    if (existing.length) {
      const same = existing.find((s) => s.period_start === preview.period_start && s.period_end === preview.period_end)
      if (same) return same
      fail('settlement_overlap', '该周期与已有结算单重叠', 409)
    }
    const id = uid('settlement'),
      ts = stamp()
    platform.db
      .prepare(`INSERT INTO vendor_settlements (id,contract_id,period_start,period_end,status,amount_usdt,usage_snapshot_json,created_by,created_at,updated_at,payer_vendor_id,payee_vendor_id)
      VALUES (?,?,?,?,'review',?,?,?,?,?,?,?)`)
      .run(
        id,
        preview.contract_id,
        preview.period_start,
        preview.period_end,
        preview.amount_usdt,
        JSON.stringify(preview),
        actor,
        ts,
        ts,
        payerId,
        vendorId,
      )
    platform.audit({
      actorUserId: actor,
      vendorId,
      action: 'settlement.created',
      resourceType: 'settlement',
      resourceId: id,
      payload: { period_start: preview.period_start, period_end: preview.period_end, amount_usdt: preview.amount_usdt },
    })
    return platform.db.prepare('SELECT * FROM vendor_settlements WHERE id=?').get(id)
  })
}
export function settlementAction(platform, id, action, body, actor, payerId = null) {
  return withTransaction(platform.db, () => {
    const row = platform.db
      .prepare(
        `SELECT * FROM vendor_settlements WHERE id=?`,
      )
      .get(id)
    if (!row) fail('settlement_not_found', '结算单不存在', 404)
    if (row.payer_vendor_id !== payerId) fail('settlement_payer_scope', '仅当前付款方可以操作该结算单', 403)
    const ts = stamp()
    if (action === 'confirm') {
      if (['confirmed', 'partial', 'paid'].includes(row.status)) return row
      if (row.status !== 'review') fail('invalid_settlement_state', '仅待审核结算单可确认', 409)
      platform.db
        .prepare('UPDATE vendor_settlements SET status=?,confirmed_at=?,updated_at=? WHERE id=?')
        .run(row.amount_usdt === 0 ? 'paid' : 'confirmed', ts, ts, id)
    } else if (action === 'void') {
      if (!['draft', 'review', 'confirmed'].includes(row.status))
        fail('invalid_settlement_state', '已付款结算单不能作废', 409)
      if (!String(body.reason || '').trim()) fail('reason_required', '请填写作废原因')
      platform.db.prepare("UPDATE vendor_settlements SET status='void',updated_at=? WHERE id=?").run(ts, id)
    } else if (action === 'payments') {
      const amount = round(Number(body.amount_usdt)),
        key = String(body.idempotency_key || ''),
        reason = String(body.reason || '').trim()
      if (
        !Number.isFinite(amount) ||
        !Number.isSafeInteger(Math.round(amount * 1e6)) ||
        amount <= 0 ||
        !key ||
        key.length > 160 ||
        !reason
      )
        fail('invalid_payment', '请填写有效金额、凭证和幂等标识')
      const previous = platform.db.prepare('SELECT * FROM vendor_payments WHERE idempotency_key=?').get(key)
      if (previous) {
        if (previous.settlement_id !== id || previous.amount_usdt !== amount || previous.reason !== reason)
          fail('idempotency_conflict', '付款标识已用于其他记录', 409)
        return platform.db.prepare('SELECT * FROM vendor_settlements WHERE id=?').get(id)
      }
      if (!['confirmed', 'partial'].includes(row.status)) fail('invalid_settlement_state', '请先确认结算单', 409)
      const paid = platform.db
        .prepare(
          "SELECT COALESCE(SUM(amount_usdt),0) AS n FROM vendor_payments WHERE settlement_id=? AND action='payment'",
        )
        .get(id).n
      if (round(paid + amount) > row.amount_usdt) fail('payment_exceeds_due', '登记金额超过未付金额', 409)
      platform.db
        .prepare(
          `INSERT INTO vendor_payments (id,settlement_id,idempotency_key,amount_usdt,action,reason,actor_user_id,created_at) VALUES (?,?,?,?,'payment',?,?,?)`,
        )
        .run(uid('payment'), id, key, amount, reason, actor, ts)
      platform.db
        .prepare('UPDATE vendor_settlements SET status=?,updated_at=? WHERE id=?')
        .run(round(paid + amount) >= row.amount_usdt ? 'paid' : 'partial', ts, id)
    } else fail('not_found', '操作不存在', 404)
    platform.audit({
      actorUserId: actor,
      vendorId: row.payee_vendor_id,
      action: `settlement.${action}`,
      resourceType: 'settlement',
      resourceId: id,
      payload: { amount_usdt: body.amount_usdt, reason: body.reason },
    })
    return platform.db.prepare('SELECT * FROM vendor_settlements WHERE id=?').get(id)
  })
}
