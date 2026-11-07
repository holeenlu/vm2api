// Native adaptation of holeenlu/sub2api supplier administration workflows.
// Source reference: 0276190e775b369319acc18bc1c120a4469a71ae, VendorsView.vue
// and vendor workbenches. Shares vm2api's existing supplier domain and tables.
import crypto from 'node:crypto'
import { dbClient } from '../db/db-client.mjs'
import { rowMicros, toMicros } from '../core/money.mjs'
import { GroupsRepo } from '../db/repos/groups-repo.mjs'
import { VendorError, CAPABILITIES, projectResource, rejectInlinePricing } from './vendor-platform.mjs'
import * as vendorsRepo from './repos/vendors-repo.mjs'
import * as membersRepo from './repos/members-repo.mjs'
import * as resourcesRepo from './repos/resources-repo.mjs'
import * as settlementsRepo from './repos/admin-settlements-repo.mjs'
import {
  releaseSettlementAllocations,
  settlementById,
  settlementPayments,
  updateSettlementStatus,
} from './repos/settlements-repo.mjs'
import { listLiveGroupIds } from './repos/account-groups-repo.mjs'
const stamp = () => new Date().toISOString()
const uid = (kind) => `${kind}_${crypto.randomUUID()}`
const fail = (code, message, status = 400) => {
  throw new VendorError(code, message, status)
}

export async function adminVendorIdentity(platform, vendorId, actor) {
  const vendor = await platform.getVendor(vendorId)
  if (!vendor) fail('vendor_not_found', '供应商不存在', 404)
  return {
    user_id: actor,
    system_admin: true,
    vendor: { ...vendor, remark: (await platform.vendorRow(vendorId)).remark || '', capabilities: CAPABILITIES },
  }
}
/** 供应商账号池可修改的账号字段；其他入口修改供应商自有账号时同样只允许这些字段。 */
export const VENDOR_ACCOUNT_PATCH_FIELDS = Object.freeze([
  'name',
  'notes',
  'group_ids',
  'proxy_id',
  'proxy_endpoint',
  'proxy_source',
  'proxy_region',
  'expected_updated_at',
  'expected_group_version',
  'status',
])

/**
 * 虚拟机页、Codex 账号页修改供应商自有资源时与账号池同一规则：供应商及其父级必须处于启用状态。
 * 账号池的字段白名单（VENDOR_ACCOUNT_PATCH_FIELDS）只约束账号池接口本身。
 * 平台自有资源（vendorId 为空）不受影响，返回 null。
 */
export async function assertVendorOwnedWritable(platform, vendorId, actor) {
  if (!vendorId) return null
  const identity = await adminVendorIdentity(platform, vendorId, actor)
  await platform.requireActive(identity)
  return identity
}
export async function vendorIds(platform, vendorId, children = true) {
  if (!vendorId || vendorId === 'all') return (await vendorsRepo.listLiveVendorIds(platform.db)).map((r) => r.id)
  const vendor = await platform.getVendor(vendorId)
  if (!vendor) fail('vendor_not_found', '供应商不存在', 404)
  return [
    vendor.id,
    ...(children && vendor.tier === 1 ? (await vendorsRepo.listChildIds(platform.db, vendor.id)).map((r) => r.id) : []),
  ]
}
export async function adminVendors(platform) {
  const members = await membersRepo.listActiveMemberLogins(platform.db)
  const counts = await resourcesRepo.countLiveResourcesByVendorType(platform.db)
  const vendors = await vendorsRepo.listLiveVendorRemarks(platform.db)
  return Promise.all(
    vendors.map(async ({ id, remark }) => {
      const vendor = await platform.getVendor(id)
      const scope = await vendorIds(platform, id)
      const count = (type) =>
        counts.filter((r) => scope.includes(r.vendor_id) && r.resource_type === type).reduce((n, r) => n + r.n, 0)
      return {
        ...vendor,
        remark,
        members: members.filter((m) => m.vendor_id === id),
        account_count: count('account'),
        proxy_count: count('proxy'),
      }
    }),
  )
}
export async function adminResources(platform, type, query = {}) {
  const ids = await vendorIds(
    platform,
    query.vendor_id,
    query.include_children === true || query.include_children === 'true',
  )
  return (await resourcesRepo.listAdminResources(platform.db, type, ids)).map((r) => projectResource(r))
}
export async function updateAdminVendor(platform, id, body, actor) {
  rejectInlinePricing(body)
  const row = await platform.getVendor(id)
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
  const next = { ...row, remark: (await platform.vendorRow(id)).remark || '', ...body }
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
  const groupIds = new Set((await listLiveGroupIds(platform.db)).map((r) => String(r.id)))
  if (next.groups.some((g) => !groupIds.has(g))) fail('invalid_group', '分组不存在')
  const relations =
    row.tier === 2
      ? [[next, await platform.getVendor(row.parent_id)]]
      : await Promise.all(
          (await vendorsRepo.listChildIds(platform.db, id)).map(async (r) => [await platform.getVendor(r.id), next]),
        )
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
  const inventory = (await adminVendors(platform)).find((v) => v.id === id)
  if (
    (next.account_limit && inventory.account_count > next.account_limit) ||
    (next.proxy_limit && inventory.proxy_count > next.proxy_limit)
  )
    fail('limit_below_usage', '资源上限低于当前已用数量', 409)
  return dbClient(platform.db).tx(async () => {
    const ts = stamp()
    await vendorsRepo.updateVendorAdmin(
      platform.db,
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
    if (Object.hasOwn(body, 'groups')) {
      const groups = new GroupsRepo(platform.db)
      const members = await membersRepo.listActiveMemberUserIds(platform.db, id)
      for (const member of members) {
        const previous = new Map((await groups.grants(member.user_id)).map((grant) => [String(grant.group_id), grant]))
        await groups.setGrants(
          member.user_id,
          next.groups.map((groupId) => previous.get(groupId) || { group_id: Number(groupId) }),
          actor,
        )
      }
    }
    for (const [field, capability] of [
      ['create_child', 'vendor.create_child'],
      ['settlement_pay', 'vendor.settlement.pay'],
    ]) {
      if (body[field] != null)
        await vendorsRepo.upsertCapability(platform.db, id, capability, body[field] ? 1 : 0, ts, ts)
    }

    await platform.audit({
      actorUserId: actor,
      vendorId: id,
      action: 'vendor.admin_updated',
      payload: { fields: Object.keys(body), status: next.status },
    })
    return { ...(await platform.getVendor(id)), remark: next.remark }
  })
}

export async function syncVendorUserGroups(platform, userId, grants, actor) {
  const memberships = await membersRepo.listUserVendorMemberships(platform.db, userId)
  for (const { vendor_id } of memberships)
    await updateAdminVendor(
      platform,
      vendor_id,
      {
        groups: grants.map((grant) => String(typeof grant === 'number' ? grant : grant.group_id)),
      },
      actor,
    )
}

export async function listSettlements(platform, query = {}) {
  const ids = await vendorIds(platform, query.vendor_id, query.include_children === true)
  const rows = await settlementsRepo.listSettlementsByPayees(platform.db, ids)
  return Promise.all(
    rows.map(async (row) => {
      const { usage_snapshot_json, ...rest } = row
      return {
        ...rest,
        usage: JSON.parse(usage_snapshot_json || '{}'),
        payments: await settlementPayments(platform.db, row.id),
      }
    }),
  )
}
export async function settlementAction(platform, id, action, body, actor, payerId = null) {
  return dbClient(platform.db).tx(async () => {
    const row = await settlementById(platform.db, id)
    if (!row) fail('settlement_not_found', '结算单不存在', 404)
    if (row.payer_vendor_id !== payerId) fail('settlement_payer_scope', '仅当前付款方可以操作该结算单', 403)
    const ts = stamp()
    if (action === 'confirm') {
      if (['confirmed', 'partial', 'paid'].includes(row.status)) return row
      if (row.status !== 'review') fail('invalid_settlement_state', '仅待审核结算单可确认', 409)
      await updateSettlementStatus(platform.db, rowMicros(row, 'amount_usdt') === 0 ? 'paid' : 'confirmed', ts, ts, id)
    } else if (action === 'void') {
      if (!['draft', 'review', 'confirmed'].includes(row.status))
        fail('invalid_settlement_state', '已付款结算单不能作废', 409)
      if (!String(body.reason || '').trim()) fail('reason_required', '请填写作废原因')
      await settlementsRepo.voidSettlement(platform.db, ts, id)
      await releaseSettlementAllocations(platform.db, ts, id)
    } else if (action === 'payments') {
      // 金额按整数微单位比较与累加（M6）：输入的 USDT 在这里换算一次
      const amountMicros = toMicros(body.amount_usdt),
        key = String(body.idempotency_key || ''),
        reason = String(body.reason || '').trim()
      if (amountMicros == null || amountMicros <= 0 || !key || key.length > 160 || !reason)
        fail('invalid_payment', '请填写有效金额、凭证和幂等标识')
      // 竞态 R20：重复的付款标识按同一规则返回已登记的付款或幂等冲突。先以 ON CONFLICT DO NOTHING 写入，
      // 并发重复提交时读回先写入的一条重放，而不是撞唯一索引报错；已付合计在写入后按含本笔重新汇总，
      // 超过应付即抛错回滚本笔（与原先“已付 + 本笔 > 应付”同一判断）。
      const replay = async (previous) => {
        if (
          previous.settlement_id !== id ||
          rowMicros(previous, 'amount_usdt') !== amountMicros ||
          previous.reason !== reason
        )
          fail('idempotency_conflict', '付款标识已用于其他记录', 409)
        return settlementById(platform.db, id)
      }
      const previous = await settlementsRepo.findPaymentByIdempotencyKey(platform.db, key)
      if (previous) return replay(previous)
      if (!['confirmed', 'partial'].includes(row.status)) fail('invalid_settlement_state', '请先确认结算单', 409)
      const inserted = await settlementsRepo.insertPayment(
        platform.db,
        uid('payment'),
        id,
        key,
        amountMicros,
        reason,
        actor,
        ts,
      )
      if (!inserted.changes) return replay(await settlementsRepo.findPaymentByIdempotencyKey(platform.db, key))
      const paid = Number((await settlementsRepo.sumSettlementPayments(platform.db, id)).micros)
      const due = rowMicros(row, 'amount_usdt')
      if (paid > due) fail('payment_exceeds_due', '登记金额超过未付金额', 409)
      await settlementsRepo.setSettlementStatus(platform.db, paid >= due ? 'paid' : 'partial', ts, id)
    } else fail('not_found', '操作不存在', 404)
    await platform.audit({
      actorUserId: actor,
      vendorId: row.payee_vendor_id,
      action: `settlement.${action}`,
      resourceType: 'settlement',
      resourceId: id,
      payload: { amount_usdt: body.amount_usdt, reason: body.reason },
    })
    return settlementById(platform.db, id)
  })
}
