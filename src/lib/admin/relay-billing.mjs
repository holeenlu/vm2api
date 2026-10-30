import { ownerPred } from '../db/repos/usage-log-preds.mjs'
import { resolvePrice } from './price-catalog.mjs'
import crypto from 'node:crypto'
import { getDb, withTransaction } from '../db/database.mjs'
import { GroupsRepo } from '../db/repos/groups-repo.mjs'
import { UsersRepo } from '../db/repos/users-repo.mjs'
import { audit, moneyMicros, relayError } from './relay-common.mjs'
import { usageForStorage } from '../core/usage-persist.mjs'
import { calculateCost } from './pricing.mjs'

const NOW = () => new Date().toISOString()
function optionalReason(reason) {
  if (reason != null && typeof reason !== 'string') throw relayError('invalid_reason', '原因必须是文字')
  return (reason || '').trim().slice(0, 1000)
}
export class RelayBilling {
  constructor(db = getDb()) {
    this.db = db
    this.groups = new GroupsRepo(db)
    this.users = new UsersRepo(db)
  }
  wallet(userId) {
    const user = this.users.getById(userId)
    if (!user) throw relayError('user_not_found', '用户不存在', 404)
    const domainId = user.role === 'admin' ? user.admin_domain_id : null
    if (user.role === 'admin' && !domainId) throw relayError('wallet_unavailable', '管理员共享钱包不可用', 409)
    return { userId, domainId }
  }
  walletAmount({ userId, domainId }) {
    const row = domainId
      ? this.db.prepare('SELECT balance_micros FROM admin_domains WHERE id=?').get(domainId)
      : this.db.prepare('SELECT balance_micros FROM users WHERE id=?').get(userId)
    if (!row) throw relayError('wallet_unavailable', '钱包不存在', 409)
    return row.balance_micros
  }
  changeWallet(wallet, delta, now) {
    if (!Number.isSafeInteger(this.walletAmount(wallet) + delta)) throw relayError('invalid_amount', '余额超出安全范围')
    if (wallet.domainId)
      this.db
        .prepare('UPDATE admin_domains SET balance_micros=balance_micros+?,updated_at=? WHERE id=?')
        .run(delta, now, wallet.domainId)
    else
      this.db
        .prepare(
          'UPDATE users SET balance_micros=balance_micros+?,balance=(balance_micros+?)/1000000.0,updated_at=? WHERE id=?',
        )
        .run(delta, delta, now, wallet.userId)
    return this.walletAmount(wallet)
  }
  balance(userId) {
    const wallet = this.wallet(userId)
    const balance = this.walletAmount(wallet)
    return {
      user_id: userId,
      wallet_domain_id: wallet.domainId,
      balance: balance / 1e6,
      available: balance / 1e6,
    }
  }
  adjust(userId, { amount, operation = 'add', reason, idempotency_key }, actor, kind = 'adjustment') {
    if (!['add', 'subtract'].includes(operation)) throw relayError('invalid_operation', '请选择充值或扣款')
    const value = moneyMicros(amount)
    if (!value) throw relayError('invalid_adjustment', '金额必须大于零')
    const note = optionalReason(reason)
    if (typeof idempotency_key !== 'string' || idempotency_key.length < 8 || idempotency_key.length > 160)
      throw relayError('idempotency_key_required', '请提供有效幂等标识')
    const delta = operation === 'subtract' ? -value : value
    return withTransaction(this.db, () => {
      const previous = this.db.prepare('SELECT * FROM wallet_ledger WHERE idempotency_key=?').get(idempotency_key)
      if (previous) {
        if (previous.user_id !== userId || previous.amount_micros !== delta || previous.kind !== kind)
          throw relayError('idempotency_conflict', '幂等标识已用于不同操作', 409)
        return { ...this.balance(userId), transaction: previous, duplicate: true }
      }
      const before = this.balance(userId)
      if (operation === 'subtract' && moneyMicros(before.available, { negative: true }) < value)
        throw relayError('insufficient_balance', '可用余额不足', 409)
      const now = NOW()
      const wallet = this.wallet(userId)
      const currentBalance = this.changeWallet(wallet, delta, now)
      const id = crypto.randomUUID()
      this.db
        .prepare(
          'INSERT INTO wallet_ledger(id,user_id,kind,amount_micros,balance_after_micros,idempotency_key,actor,reason,created_at,wallet_domain_id) VALUES(?,?,?,?,?,?,?,?,?,?)',
        )
        .run(id, userId, kind, delta, currentBalance, idempotency_key, actor, note, now, wallet.domainId)
      audit(this.db, actor, 'wallet.' + operation, userId, before.balance, currentBalance / 1e6, note)
      return {
        ...this.balance(userId),
        transaction: this.db.prepare('SELECT * FROM wallet_ledger WHERE id=?').get(id),
        duplicate: false,
      }
    })
  }
  transfer(fromUserId, toUserId, { amount, reason, idempotency_key }, actor) {
    const value = moneyMicros(amount)
    if (!value) throw relayError('invalid_transfer', '金额必须大于零')
    const note = optionalReason(reason)
    if (fromUserId === toUserId) throw relayError('invalid_transfer', '不能给自己充值')
    if (typeof idempotency_key !== 'string' || idempotency_key.length < 8 || idempotency_key.length > 160)
      throw relayError('idempotency_key_required', '请提供有效幂等标识')
    const transferKey = 'transfer:' + crypto.createHash('sha256').update(idempotency_key).digest('hex')
    const debitKey = transferKey + ':debit'
    const creditKey = transferKey + ':credit'
    return withTransaction(this.db, () => {
      const previousDebit = this.db.prepare('SELECT * FROM wallet_ledger WHERE idempotency_key=?').get(debitKey)
      const previousCredit = this.db.prepare('SELECT * FROM wallet_ledger WHERE idempotency_key=?').get(creditKey)
      if (previousDebit || previousCredit) {
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
        return {
          ...this.balance(toUserId),
          source: this.balance(fromUserId),
          transaction: previousCredit,
          source_transaction: previousDebit,
          duplicate: true,
        }
      }
      const sourceBefore = this.balance(fromUserId)
      const targetBefore = this.balance(toUserId)
      if (moneyMicros(sourceBefore.available, { negative: true }) < value)
        throw relayError('insufficient_balance', '可用余额不足', 409)
      const source = this.wallet(fromUserId)
      const target = this.wallet(toUserId)
      if (source.domainId && source.domainId === target.domainId)
        throw relayError('invalid_transfer', '同域管理员已经共用余额，不能重复转账')
      const now = NOW()
      const sourceAfter = this.changeWallet(source, -value, now)
      const targetAfter = this.changeWallet(target, value, now)
      const metadata = JSON.stringify({ transfer_id: transferKey, from_user_id: fromUserId, to_user_id: toUserId })
      const sourceId = crypto.randomUUID()
      const targetId = crypto.randomUUID()
      const insert = this.db.prepare(
        'INSERT INTO wallet_ledger(id,user_id,kind,amount_micros,balance_after_micros,idempotency_key,actor,reason,metadata_json,created_at,wallet_domain_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      )
      insert.run(
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
      insert.run(
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
      audit(this.db, actor, 'wallet.transfer', toUserId, targetBefore.balance, targetAfter / 1e6, note)
      return {
        ...this.balance(toUserId),
        source: this.balance(fromUserId),
        transaction: this.db.prepare('SELECT * FROM wallet_ledger WHERE id=?').get(targetId),
        source_transaction: this.db.prepare('SELECT * FROM wallet_ledger WHERE id=?').get(sourceId),
        duplicate: false,
      }
    })
  }
  reverse(transactionId, { reason }, actor) {
    if (!reason?.trim()) throw relayError('reason_required', '冲正必须填写原因')
    return withTransaction(this.db, () => {
      const original = this.db.prepare('SELECT * FROM wallet_ledger WHERE id=?').get(transactionId)
      if (!original || !original.amount_micros || ['reversal', 'transfer'].includes(original.kind))
        throw relayError('invalid_reversal', '该流水不可冲正', 409)
      if ((this.wallet(original.user_id).domainId || null) !== (original.wallet_domain_id || null))
        throw relayError('wallet_changed', '该流水的钱包归属已变化，需要人工对账', 409)
      const result = this.adjust(
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
        this.db
          .prepare('UPDATE wallet_ledger SET metadata_json=? WHERE id=?')
          .run(JSON.stringify({ reverses: original.id, request_id: original.request_id }), result.transaction.id)
      return result
    })
  }
  ledger(userId, { limit = 50, before = null, before_id = null } = {}) {
    const count = Math.min(200, Math.max(1, Number(limit) || 50))
    const where = []
    const args = []
    if (userId) {
      const selected = typeof userId === 'string' ? userId : userId.userId
      const wallet = selected ? this.wallet(selected) : null
      const own = wallet?.domainId ? { sql: 'wallet_domain_id = ?', params: [wallet.domainId] } : ownerPred(userId)
      if (!selected && userId?.type === 'panel_users' && userId.scopeRootId) {
        own.sql = `(wallet_domain_id = ? OR (${own.sql}))`
        own.params.unshift(userId.scopeRootId)
      }
      where.push(own.sql)
      args.push(...own.params)
    }
    if (before) {
      where.push(before_id ? '(created_at<? OR (created_at=? AND id<?))' : 'created_at<?')
      args.push(...(before_id ? [before, before, before_id] : [before]))
    }
    return this.db
      .prepare(
        'SELECT wallet_ledger.*, (SELECT username FROM users WHERE users.id=wallet_ledger.user_id) AS user_name FROM wallet_ledger' +
          (where.length ? ' WHERE ' + where.join(' AND ') : '') +
          ' ORDER BY created_at DESC,id DESC LIMIT ?',
      )
      .all(...args, count)
      .map((row) => ({ ...row, amount: row.amount_micros / 1e6, balance_after: row.balance_after_micros / 1e6 }))
  }
  subscriptions(userId = null) {
    const own = ownerPred(userId)
    return this.db
      .prepare(
        'SELECT s.*,g.name group_name FROM user_subscriptions s JOIN groups g ON g.id=s.group_id' +
          (own.sql ? ` WHERE ${own.sql}` : '') +
          ' ORDER BY s.created_at DESC',
      )
      .all(...own.params)
      .map((s) => ({ ...s, windows: this.subscriptionWindows(s.id, this.groups.getById(s.group_id)) }))
  }
  createSubscription(input, actor) {
    const group = this.groups.getById(input.group_id)
    if (!group || group.subscription_type !== 'subscription')
      throw relayError('invalid_subscription_group', '请选择套餐分组')
    if (!this.users.getById(input.user_id)) throw relayError('user_not_found', '用户不存在', 404)
    const start = input.starts_at ? new Date(input.starts_at) : new Date()
    const end = input.expires_at ? new Date(input.expires_at) : null
    if (!Number.isFinite(start.getTime()) || (end && (!Number.isFinite(end.getTime()) || end <= start)))
      throw relayError('invalid_subscription_dates', '套餐有效期不正确')
    return withTransaction(this.db, () => {
      if (
        this.db
          .prepare(
            "SELECT id FROM user_subscriptions WHERE user_id=? AND group_id=? AND status IN ('active','suspended') AND (expires_at IS NULL OR expires_at>?) AND (? IS NULL OR starts_at<?)",
          )
          .get(input.user_id, group.id, start.toISOString(), end?.toISOString() || null, end?.toISOString() || null)
      )
        throw relayError('subscription_overlap', '该用户已有重叠套餐', 409)
      const id = crypto.randomUUID()
      const now = NOW()
      this.db
        .prepare(
          "INSERT INTO user_subscriptions(id,user_id,group_id,status,starts_at,expires_at,created_at,updated_at) VALUES(?,?,?,'active',?,?,?,?)",
        )
        .run(id, input.user_id, group.id, start.toISOString(), end?.toISOString() || null, now, now)
      const item = this.db.prepare('SELECT * FROM user_subscriptions WHERE id=?').get(id)
      audit(this.db, actor, 'subscription.create', id, null, item)
      return item
    })
  }
  updateSubscription(id, status, actor) {
    if (!['active', 'suspended', 'revoked'].includes(status)) throw relayError('invalid_status', '套餐状态不正确')
    return withTransaction(this.db, () => {
      const before = this.db.prepare('SELECT * FROM user_subscriptions WHERE id=?').get(id)
      if (!before) throw relayError('subscription_not_found', '套餐不存在', 404)
      if (before.status === 'revoked') throw relayError('subscription_revoked', '已撤销套餐不能恢复', 409)
      this.db.prepare('UPDATE user_subscriptions SET status=?,updated_at=? WHERE id=?').run(status, NOW(), id)
      const item = this.db.prepare('SELECT * FROM user_subscriptions WHERE id=?').get(id)
      audit(this.db, actor, 'subscription.status', id, before, item)
      return item
    })
  }
  subscriptionWindows(id, group, now = Date.now()) {
    if (!group) return []
    // Explicit rolling windows, anchored to elapsed UTC time, not vendor quota windows.
    return [
      ['daily', 86400000],
      ['weekly', 7 * 86400000],
      ['monthly', 30 * 86400000],
    ].map(([key, ms]) => {
      const since = new Date(now - ms).toISOString()
      const row = this.db
        .prepare(
          'SELECT COALESCE(SUM(actual_micros),0) used FROM billing_charges WHERE subscription_id=? AND created_at>?',
        )
        .get(id, since)
      return { period: key, limit: group[key + '_limit_micros'] / 1e6, used: row.used / 1e6, window: 'rolling', since }
    })
  }
  /** Read-only admission: no funds or estimated tokens are reserved. */
  authorize(record, requestId, model, body = {}) {
    if (!record?.user_id) return null
    const user = this.users.getById(record.user_id)
    if (!['user', 'admin', 'super_admin'].includes(user?.role)) return null
    const exempt = user.role === 'super_admin'
    if (exempt && !record.group_id) return null
    const { group, subscription, rate } = this.groups.access(user, record.group_id)
    const wallet = this.wallet(user.id)
    const usesSubscription = !exempt && group.subscription_type === 'subscription'
    if (usesSubscription && !subscription) throw relayError('subscription_required', '套餐未生效或已到期', 403)
    if (usesSubscription) {
      for (const window of this.subscriptionWindows(subscription.id, group))
        if (window.limit > 0 && window.used >= window.limit)
          throw relayError('subscription_quota_exceeded', '套餐额度已用完', 429)
    } else if (!exempt && rate > 0 && this.walletAmount(wallet) <= 0) {
      throw relayError('insufficient_balance', '余额不足', 402)
    }
    const quote = resolvePrice(model)
    const imageTool = body?.tools?.find?.((tool) => tool?.type === 'image_generation')
    if (quote && imageTool) quote.image_price = resolvePrice(imageTool.model || 'gpt-image-2.5-flare')
    // Keep ownership/rate stable for this request, only in memory until it finishes.
    return {
      request_id: requestId,
      user_id: user.id,
      api_key_id: record.id,
      group_id: group.id,
      subscription_id: usesSubscription ? subscription.id : null,
      rate_multiplier: rate,
      quote_json: JSON.stringify(quote),
      wallet_domain_id: wallet.domainId,
      balance_exempt: exempt,
    }
  }
  settle(context, usage, model, recordKeyUsage) {
    if (!context) return null
    return withTransaction(this.db, () => {
      const previous = this.db.prepare('SELECT * FROM billing_charges WHERE request_id=?').get(context.request_id)
      if (previous) return { ...previous, status: previous.actual_micros == null ? 'unmetered' : 'settled' }
      const price = context.quote_json
        ? calculateCost(usage, model, { resolvedPrice: JSON.parse(context.quote_json) })
        : calculateCost(usage, model)
      const actual =
        price.known || context.rate_multiplier === 0
          ? moneyMicros((price.total_cost || 0) * context.rate_multiplier)
          : null
      const now = NOW()
      if (actual != null && !context.subscription_id && !context.balance_exempt) {
        const balance = this.changeWallet({ userId: context.user_id, domainId: context.wallet_domain_id }, -actual, now)
        this.db
          .prepare(
            "INSERT INTO wallet_ledger(id,user_id,kind,amount_micros,balance_after_micros,request_id,idempotency_key,actor,reason,metadata_json,created_at,wallet_domain_id) VALUES(?,?,'usage',?,?,?,?,'gateway','API 使用扣费',?,?,?)",
          )
          .run(
            crypto.randomUUID(),
            context.user_id,
            -actual,
            balance,
            context.request_id,
            'usage:' + context.request_id,
            JSON.stringify({ group_id: context.group_id, rate: context.rate_multiplier, model }),
            now,
            context.wallet_domain_id,
          )
      }
      recordKeyUsage?.(
        context.rate_multiplier,
        actual == null ? undefined : actual / 1e6,
        price.known ? price.total_cost : undefined,
      )
      this.db
        .prepare(
          'INSERT INTO billing_charges(request_id,user_id,api_key_id,group_id,subscription_id,rate_multiplier,actual_micros,model,usage_json,quote_json,created_at,wallet_domain_id,balance_exempt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          context.request_id,
          context.user_id,
          context.api_key_id,
          context.group_id,
          context.subscription_id,
          context.rate_multiplier,
          actual,
          model,
          JSON.stringify(usageForStorage(usage)),
          context.quote_json,
          now,
          context.wallet_domain_id,
          context.balance_exempt ? 1 : 0,
        )
      return {
        ...this.db.prepare('SELECT * FROM billing_charges WHERE request_id=?').get(context.request_id),
        status: actual == null ? 'unmetered' : 'settled',
      }
    })
  }
}
