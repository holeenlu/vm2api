import { ownerPred } from '../db/repos/usage-log-preds.mjs'
import { resolvePrice } from './price-catalog.mjs'
import { DEFAULT_IMAGE_TOOL_MODEL } from '../protocol/image-tool-models.mjs'
import crypto from 'node:crypto'
import { getDb } from '../db/database.mjs'
import { dbClient } from '../db/db-client.mjs'
import { GroupsRepo } from '../db/repos/groups-repo.mjs'
import { UsersRepo } from '../db/repos/users-repo.mjs'
import { audit, moneyMicros, relayError } from './relay-common.mjs'
import { usageForStorage } from '../core/usage-persist.mjs'
import { calculateCost } from './pricing.mjs'
import { groupMediaPolicy } from './media-pricing.mjs'
import { applyRate } from '../core/money.mjs'
import {
  addDomainWalletBalance,
  addUserWalletBalance,
  chargeByRequestId,
  debitDomainWallet,
  debitUserWallet,
  domainWalletBalance,
  insertBillingCharge,
  insertSubscription,
  insertTransferLedger,
  insertWalletLedger,
  ledgerById,
  ledgerByIdempotencyKey,
  ledgerRows,
  overlappingSubscription,
  setLedgerMetadata,
  subscriptionById,
  subscriptionRows,
  subscriptionUsedSince,
  updateSubscriptionStatus,
  userWalletBalance,
} from './repos/relay-billing-repo.mjs'

const NOW = () => new Date().toISOString()
// 嵌套事务里发现幂等键已被并发写入：抛出它回滚本次余额变动，外层按已有流水返回 duplicate
const IDEMPOTENT_REPLAY = Symbol('idempotent-replay')
const SUBSCRIPTION_PERIODS = [
  ['daily', 86400000],
  ['weekly', 7 * 86400000],
  ['monthly', 30 * 86400000],
]
function optionalReason(reason) {
  if (reason != null && typeof reason !== 'string') throw relayError('invalid_reason', '原因必须是文字')
  return (reason || '').trim().slice(0, 1000)
}
function walletOf(user, userId) {
  if (!user) throw relayError('user_not_found', '用户不存在', 404)
  const domainId = user.role === 'admin' ? user.admin_domain_id : null
  if (user.role === 'admin' && !domainId) throw relayError('wallet_unavailable', '管理员共享钱包不可用', 409)
  return { userId, domainId }
}
function walletBalanceOf(row) {
  if (!row) throw relayError('wallet_unavailable', '钱包不存在', 409)
  return row.balance_micros
}
function assertAdjustmentReplay(previous, userId, delta, kind) {
  if (previous.user_id !== userId || previous.amount_micros !== delta || previous.kind !== kind)
    throw relayError('idempotency_conflict', '幂等标识已用于不同操作', 409)
}
function assertTransferReplay(previousDebit, previousCredit, fromUserId, toUserId, value) {
  if (
    !previousDebit ||
    !previousCredit ||
    previousDebit.user_id !== fromUserId ||
    previousCredit.user_id !== toUserId ||
    previousDebit.amount_micros !== -value ||
    previousCredit.amount_micros !== value ||
    previousDebit.kind !== 'transfer' ||
    previousCredit.kind !== 'transfer'
  )
    throw relayError('idempotency_conflict', '幂等标识已用于不同操作', 409)
}
/**
 * 管理面（充值扣款、转账、冲正、流水、套餐）经 DbClient 异步执行（R6 B6b），读写放在同一个 `db.tx`：
 * 扣款是条件更新（余额不足不改行），流水按幂等键 `ON CONFLICT DO NOTHING` 写入，并发重复提交按 duplicate 返回（竞态 R1–R3）。
 * 推理热路径的准入 authorize 与结算 settle 同样经 DbClient（R6 B7a）：准入只读、不预占（竞态 R6，允许并发超支）；
 * 结算按 request_id 抢占 billing_charges 后再扣款，同一请求只扣一次（竞态 R4），扣款允许余额为负。
 */
export class RelayBilling {
  constructor(db = getDb()) {
    this.db = db
    this.client = dbClient(db)
    this.groups = new GroupsRepo(db)
    this.users = new UsersRepo(db)
  }
  async wallet(userId) {
    return walletOf(await this.users.getById(userId), userId)
  }
  async walletAmount({ userId, domainId }) {
    return walletBalanceOf(
      domainId ? await domainWalletBalance(this.db, domainId) : await userWalletBalance(this.db, userId),
    )
  }
  /**
   * 管理面余额变动：入账是增量更新；扣款是条件更新，余额不足（含并发扣款后不足）抛 insufficient_balance，不透支。
   * 与结算扣款 settlementDebit 共用入账 SQL；结算扣款允许余额为负，按原逻辑无条件扣减。
   */
  async changeWallet(wallet, delta, now) {
    if (!Number.isSafeInteger((await this.walletAmount(wallet)) + delta))
      throw relayError('invalid_amount', '余额超出安全范围')
    if (delta < 0) {
      const debited = wallet.domainId
        ? await debitDomainWallet(this.db, -delta, now, wallet.domainId)
        : await debitUserWallet(this.db, -delta, now, wallet.userId)
      if (debited.changes !== 1) throw relayError('insufficient_balance', '可用余额不足', 409)
    } else if (wallet.domainId) await addDomainWalletBalance(this.db, delta, now, wallet.domainId)
    else await addUserWalletBalance(this.db, delta, now, wallet.userId)
    return this.walletAmount(wallet)
  }
  /** 结算扣款（delta 为负）：与原同步结算一致，无条件增量扣减，余额可以为负；返回扣后余额。 */
  async settlementDebit(wallet, delta, now) {
    if (!Number.isSafeInteger((await this.walletAmount(wallet)) + delta))
      throw relayError('invalid_amount', '余额超出安全范围')
    if (wallet.domainId) await addDomainWalletBalance(this.db, delta, now, wallet.domainId)
    else await addUserWalletBalance(this.db, delta, now, wallet.userId)
    return this.walletAmount(wallet)
  }
  async balance(userId) {
    const wallet = await this.wallet(userId)
    const balance = await this.walletAmount(wallet)
    return {
      user_id: userId,
      wallet_domain_id: wallet.domainId,
      balance: balance / 1e6,
      available: balance / 1e6,
    }
  }
  async adjust(userId, { amount, operation = 'add', reason, idempotency_key }, actor, kind = 'adjustment') {
    if (!['add', 'subtract'].includes(operation)) throw relayError('invalid_operation', '请选择充值或扣款')
    const value = moneyMicros(amount)
    if (!value) throw relayError('invalid_adjustment', '金额必须大于零')
    const note = optionalReason(reason)
    if (typeof idempotency_key !== 'string' || idempotency_key.length < 8 || idempotency_key.length > 160)
      throw relayError('idempotency_key_required', '请提供有效幂等标识')
    const delta = operation === 'subtract' ? -value : value
    return this.client.tx(async (tx) => {
      const replay = async (previous) => {
        assertAdjustmentReplay(previous, userId, delta, kind)
        return { ...(await this.balance(userId)), transaction: previous, duplicate: true }
      }
      const previous = await ledgerByIdempotencyKey(this.db, idempotency_key)
      if (previous) return replay(previous)
      const before = await this.balance(userId)
      // 预检按读到的余额快照（整数微单位换算，精确）；并发扣款由下面的条件更新兜底（竞态 R1–R3）
      if (operation === 'subtract' && moneyMicros(before.available, { negative: true }) < value)
        throw relayError('insufficient_balance', '可用余额不足', 409)
      const now = NOW()
      const wallet = await this.wallet(userId)
      const id = crypto.randomUUID()
      const applied = await tx
        .tx(async () => {
          const currentBalance = await this.changeWallet(wallet, delta, now)
          const inserted = await insertWalletLedger(
            this.db,
            id,
            userId,
            kind,
            delta,
            currentBalance,
            idempotency_key,
            actor,
            note,
            now,
            wallet.domainId,
          )
          if (inserted.changes !== 1) throw IDEMPOTENT_REPLAY
          await audit(this.db, actor, 'wallet.' + operation, userId, before.balance, currentBalance / 1e6, note)
          return true
        })
        .catch(async (error) => {
          // 幂等键已被并发写入（含并发请求先扣了款导致本次余额不足）：按已有流水返回
          if (error === IDEMPOTENT_REPLAY || (await ledgerByIdempotencyKey(this.db, idempotency_key))) return false
          throw error
        })
      if (!applied) return replay(await ledgerByIdempotencyKey(this.db, idempotency_key))
      return {
        ...(await this.balance(userId)),
        transaction: await ledgerById(this.db, id),
        duplicate: false,
      }
    })
  }
  /**
   * Moves funds between two wallets in one transaction. `reclaim` reverses the
   * usual admin → user direction: an administrator deducts from a user and the
   * amount returns to the domain's shared wallet, audited against the user.
   */
  async transfer(fromUserId, toUserId, { amount, reason, idempotency_key }, actor, { reclaim = false } = {}) {
    const value = moneyMicros(amount)
    if (!value) throw relayError('invalid_transfer', '金额必须大于零')
    const note = optionalReason(reason)
    if (fromUserId === toUserId) throw relayError('invalid_transfer', '不能给自己充值')
    if (typeof idempotency_key !== 'string' || idempotency_key.length < 8 || idempotency_key.length > 160)
      throw relayError('idempotency_key_required', '请提供有效幂等标识')
    const transferKey = 'transfer:' + crypto.createHash('sha256').update(idempotency_key).digest('hex')
    const debitKey = transferKey + ':debit'
    const creditKey = transferKey + ':credit'
    return this.client.tx(async (tx) => {
      const replay = async (previousDebit, previousCredit) => {
        assertTransferReplay(previousDebit, previousCredit, fromUserId, toUserId, value)
        return {
          ...(await this.balance(toUserId)),
          source: await this.balance(fromUserId),
          transaction: previousCredit,
          source_transaction: previousDebit,
          duplicate: true,
        }
      }
      const previousDebit = await ledgerByIdempotencyKey(this.db, debitKey)
      const previousCredit = await ledgerByIdempotencyKey(this.db, creditKey)
      if (previousDebit || previousCredit) return replay(previousDebit, previousCredit)
      const sourceBefore = await this.balance(fromUserId)
      const targetBefore = await this.balance(toUserId)
      if (moneyMicros(sourceBefore.available, { negative: true }) < value)
        throw relayError('insufficient_balance', '可用余额不足', 409)
      const source = await this.wallet(fromUserId)
      const target = await this.wallet(toUserId)
      if (source.domainId && source.domainId === target.domainId)
        throw relayError('invalid_transfer', '同域管理员已经共用余额，不能重复转账')
      const now = NOW()
      const metadata = JSON.stringify({ transfer_id: transferKey, from_user_id: fromUserId, to_user_id: toUserId })
      const sourceId = crypto.randomUUID()
      const targetId = crypto.randomUUID()
      const applied = await tx
        .tx(async () => {
          const sourceAfter = await this.changeWallet(source, -value, now)
          const targetAfter = await this.changeWallet(target, value, now)
          const debit = await insertTransferLedger(
            this.db,
            sourceId,
            fromUserId,
            'transfer',
            -value,
            sourceAfter,
            debitKey,
            actor,
            note,
            metadata,
            now,
            source.domainId,
          )
          const credit = await insertTransferLedger(
            this.db,
            targetId,
            toUserId,
            'transfer',
            value,
            targetAfter,
            creditKey,
            actor,
            note,
            metadata,
            now,
            target.domainId,
          )
          if (debit.changes !== 1 || credit.changes !== 1) throw IDEMPOTENT_REPLAY
          if (reclaim)
            await audit(this.db, actor, 'wallet.reclaim', fromUserId, sourceBefore.balance, sourceAfter / 1e6, note)
          else await audit(this.db, actor, 'wallet.transfer', toUserId, targetBefore.balance, targetAfter / 1e6, note)
          return true
        })
        .catch(async (error) => {
          if (
            error === IDEMPOTENT_REPLAY ||
            (await ledgerByIdempotencyKey(this.db, debitKey)) ||
            (await ledgerByIdempotencyKey(this.db, creditKey))
          )
            return false
          throw error
        })
      if (!applied)
        return replay(await ledgerByIdempotencyKey(this.db, debitKey), await ledgerByIdempotencyKey(this.db, creditKey))
      return {
        ...(await this.balance(toUserId)),
        source: await this.balance(fromUserId),
        transaction: await ledgerById(this.db, targetId),
        source_transaction: await ledgerById(this.db, sourceId),
        duplicate: false,
      }
    })
  }
  async reverse(transactionId, { reason }, actor) {
    if (!reason?.trim()) throw relayError('reason_required', '冲正必须填写原因')
    return this.client.tx(async () => {
      const original = await ledgerById(this.db, transactionId)
      if (!original || !original.amount_micros || ['reversal', 'transfer', 'usage'].includes(original.kind))
        throw relayError('invalid_reversal', '该流水不可冲正', 409)
      if (((await this.wallet(original.user_id)).domainId || null) !== (original.wallet_domain_id || null))
        throw relayError('wallet_changed', '该流水的钱包归属已变化，需要人工对账', 409)
      // adjust 在同一事务里嵌套执行（SAVEPOINT）；并发重复冲正由 reversal:<id> 幂等键按 duplicate 返回
      const result = await this.adjust(
        original.user_id,
        {
          amount: Math.abs(original.amount_micros) / 1e6,
          operation: original.amount_micros > 0 ? 'subtract' : 'add',
          reason,
          idempotency_key: 'reversal:' + original.id,
        },
        actor,
        'reversal',
      )
      if (!result.duplicate)
        await setLedgerMetadata(
          this.db,
          JSON.stringify({ reverses: original.id, request_id: original.request_id }),
          result.transaction.id,
        )
      return result
    })
  }
  async ledger(userId, { limit = 50, before = null, before_id = null } = {}) {
    const count = Math.min(200, Math.max(1, Number(limit) || 50))
    const where = []
    const args = []
    if (userId) {
      const selected = typeof userId === 'string' ? userId : userId.userId
      const wallet = selected ? await this.wallet(selected) : null
      const own = wallet?.domainId ? { sql: 'wallet_domain_id = ?', params: [wallet.domainId] } : ownerPred(userId)
      if (!selected && userId?.type === 'panel_users' && userId.scopeRootId) {
        own.sql = `(wallet_domain_id = ? OR (${own.sql}))`
        own.params.unshift(userId.scopeRootId)
      }
      where.push(own.sql)
      args.push(...own.params)
    }
    if (before) {
      // created_at 先给范围下界，索引从游标处开始扫（数据访问分层 R4）
      where.push(before_id ? 'created_at<=? AND (created_at<? OR id<?)' : 'created_at<?')
      args.push(...(before_id ? [before, before, before_id] : [before]))
    }
    where.push("kind <> 'usage'")
    return (await ledgerRows(this.db, where, args, count)).map((row) => ({
      ...row,
      amount: row.amount_micros / 1e6,
      balance_after: row.balance_after_micros / 1e6,
    }))
  }
  async subscriptions(userId = null) {
    const own = ownerPred(userId)
    const out = []
    for (const s of await subscriptionRows(this.db, own))
      out.push({ ...s, windows: await this.subscriptionWindows(s.id, await this.groups.getById(s.group_id)) })
    return out
  }
  async createSubscription(input, actor) {
    const group = await this.groups.getById(input.group_id)
    if (!group || group.subscription_type !== 'subscription')
      throw relayError('invalid_subscription_group', '请选择套餐分组')
    if (!(await this.users.getById(input.user_id))) throw relayError('user_not_found', '用户不存在', 404)
    const start = input.starts_at ? new Date(input.starts_at) : new Date()
    const end = input.expires_at ? new Date(input.expires_at) : null
    if (!Number.isFinite(start.getTime()) || (end && (!Number.isFinite(end.getTime()) || end <= start)))
      throw relayError('invalid_subscription_dates', '套餐有效期不正确')
    return this.client.tx(async () => {
      if (
        await overlappingSubscription(this.db, input.user_id, group.id, start.toISOString(), end?.toISOString() || null)
      )
        throw relayError('subscription_overlap', '该用户已有重叠套餐', 409)
      const id = crypto.randomUUID()
      const now = NOW()
      await insertSubscription(
        this.db,
        id,
        input.user_id,
        group.id,
        start.toISOString(),
        end?.toISOString() || null,
        now,
        now,
      )
      const item = await subscriptionById(this.db, id)
      await audit(this.db, actor, 'subscription.create', id, null, item)
      return item
    })
  }
  async updateSubscription(id, status, actor) {
    if (!['active', 'suspended', 'revoked'].includes(status)) throw relayError('invalid_status', '套餐状态不正确')
    return this.client.tx(async () => {
      const before = await subscriptionById(this.db, id)
      if (!before) throw relayError('subscription_not_found', '套餐不存在', 404)
      if (before.status === 'revoked') throw relayError('subscription_revoked', '已撤销套餐不能恢复', 409)
      await updateSubscriptionStatus(this.db, status, NOW(), id)
      const item = await subscriptionById(this.db, id)
      await audit(this.db, actor, 'subscription.status', id, before, item)
      return item
    })
  }
  async subscriptionWindows(id, group, now = Date.now()) {
    return (await this._subscriptionWindowsMicros(id, group, now)).map(({ limit_micros, used_micros, ...w }) => ({
      ...w,
      limit: limit_micros / 1e6,
      used: used_micros / 1e6,
    }))
  }
  /** 套餐窗口的上限与已用（整数微单位），准入判断直接比较整数（M6）。 */
  async _subscriptionWindowsMicros(id, group, now = Date.now()) {
    if (!group) return []
    // Explicit rolling windows, anchored to elapsed UTC time, not vendor quota windows.
    const out = []
    for (const [key, ms] of SUBSCRIPTION_PERIODS) {
      const since = new Date(now - ms).toISOString()
      const row = await subscriptionUsedSince(this.db, id, since)
      out.push({
        period: key,
        limit_micros: group[key + '_limit_micros'],
        used_micros: row.used,
        window: 'rolling',
        since,
      })
    }
    return out
  }
  /**
   * Read-only admission: no funds or estimated tokens are reserved.
   * 竞态 R6：只读准入，不预占余额或套餐额度；并发请求可以同时通过，结算时允许余额为负（现有语义，测试固定）。
   */
  async authorize(record, requestId, model, body = {}) {
    if (!record?.user_id) return null
    const user = await this.users.getById(record.user_id)
    if (!['user', 'admin', 'super_admin'].includes(user?.role)) return null
    const exempt = user.role === 'super_admin'
    if (exempt && !record.group_id) return null
    const { group, subscription, rate } = await this.groups.access(user, record.group_id)
    const wallet = await this.wallet(user.id)
    const usesSubscription = !exempt && group.subscription_type === 'subscription'
    if (usesSubscription && !subscription) throw relayError('subscription_required', '套餐未生效或已到期', 403)
    if (usesSubscription) {
      for (const window of await this._subscriptionWindowsMicros(subscription.id, group))
        if (window.limit_micros > 0 && window.used_micros >= window.limit_micros)
          throw relayError('subscription_quota_exceeded', '套餐额度已用完', 429)
    } else if (!exempt && rate > 0 && (await this.walletAmount(wallet)) <= 0) {
      throw relayError('insufficient_balance', '余额不足', 402)
    }
    const quote = resolvePrice(model)
    const imageTool = body?.tools?.find?.((tool) => tool?.type === 'image_generation')
    if (quote && imageTool) quote.image_price = resolvePrice(imageTool.model || DEFAULT_IMAGE_TOOL_MODEL)
    // Keep ownership/rate stable for this request, only in memory until it finishes.
    return {
      request_id: requestId,
      user_id: user.id,
      api_key_id: record.id,
      group_id: group.id,
      subscription_id: usesSubscription ? subscription.id : null,
      rate_multiplier: rate,
      quote_json: JSON.stringify(quote),
      // 生图按张与网页搜索按次的分组规则，随请求冻结
      media_json: JSON.stringify(groupMediaPolicy(group)),
      wallet_domain_id: wallet.domainId,
      balance_exempt: exempt,
    }
  }
  /** 本请求的结算记录（billing_charges，不含 JSON 列）；没有时为 undefined。 */
  async charge(requestId) {
    return chargeByRequestId(this.db, requestId)
  }

  /**
   * 结算（推理热路径与 Gateway 回执对账共用）。在一个 `db.tx` 里（调用方已开事务时为 SAVEPOINT）：
   * 先按 request_id 写入 billing_charges 抢占（`ON CONFLICT DO NOTHING`），抢占成功才扣款并记 Key 用量（竞态 R4）；
   * 抢占失败说明同一请求已被结算（res finish 与显式提交、或推理路径与回执对账并发），按已有记录返回，不再扣款。
   * `recordKeyUsage(rate, actualMicros, officialMicros)` 可以是 async 函数，在同一事务里等待；不得做网络 I/O。
   * 金额（M6）：实际扣费 = round(官方价整数微单位 × 倍率 ppm / 1e6)，只在这一步四舍五入一次。
   */
  async settle(context, usage, model, recordKeyUsage) {
    if (!context) return null
    const settled = (row) => ({ ...row, status: row.actual_micros == null ? 'unmetered' : 'settled' })
    return this.client.tx(async () => {
      const previous = await this.charge(context.request_id)
      if (previous) return settled(previous)
      const media = context.media_json ? JSON.parse(context.media_json) : null
      const price = calculateCost(usage, model, {
        ...(context.quote_json ? { resolvedPrice: JSON.parse(context.quote_json) } : {}),
        media,
      })
      // 生图独立倍率覆盖分组倍率；其余沿用请求冻结的分组有效倍率
      const rate = price.rate_multiplier ?? context.rate_multiplier
      const actual = price.known || rate === 0 ? applyRate(price.total_cost_micros || 0, rate) : null
      const now = NOW()
      const claimed = await insertBillingCharge(
        this.db,
        context.request_id,
        context.user_id,
        context.api_key_id,
        context.group_id,
        context.subscription_id,
        rate,
        actual,
        model,
        JSON.stringify(usageForStorage(usage)),
        context.quote_json,
        now,
        context.wallet_domain_id,
        context.balance_exempt ? 1 : 0,
      )
      if (claimed.changes !== 1) return settled(await this.charge(context.request_id))
      if (actual != null && !context.subscription_id && !context.balance_exempt) {
        await this.settlementDebit({ userId: context.user_id, domainId: context.wallet_domain_id }, -actual, now)
      }
      await recordKeyUsage?.(
        rate,
        actual == null ? undefined : actual,
        price.known ? price.total_cost_micros : undefined,
      )
      return {
        ...(await this.charge(context.request_id)),
        status: actual == null ? 'unmetered' : 'settled',
      }
    })
  }
}
