import { ownerPred } from '../db/repos/usage-log-preds.mjs'
import { resolvePrice } from './price-catalog.mjs'
import crypto from 'node:crypto'
import { getDb, withTransaction } from '../db/database.mjs'
import { GroupsRepo } from '../db/repos/groups-repo.mjs'
import { UsersRepo } from '../db/repos/users-repo.mjs'
import { audit, moneyMicros, relayError } from './relay-common.mjs'
import { calculateCost } from './pricing.mjs'

const NOW = () => new Date().toISOString()
const PENDING = "('pending','pending_pricing','pending_usage')"
export class RelayBilling {
  constructor(db = getDb()) {
    this.db = db
    this.groups = new GroupsRepo(db)
    this.users = new UsersRepo(db)
  }
  balance(userId) {
    const user = this.users.getById(userId)
    if (!user) throw relayError('user_not_found', '用户不存在', 404)
    const held = this.db
      .prepare(
        'SELECT COALESCE(SUM(reserved_micros),0) n FROM billing_reservations WHERE user_id=? AND subscription_id IS NULL AND status IN ' +
          PENDING,
      )
      .get(userId).n
    return {
      user_id: userId,
      balance: user.balance_micros / 1e6,
      reserved: held / 1e6,
      available: (user.balance_micros - held) / 1e6,
    }
  }
  adjust(userId, { amount, operation = 'add', reason, idempotency_key }, actor, kind = 'adjustment') {
    if (!['add', 'subtract'].includes(operation)) throw relayError('invalid_operation', '请选择充值或扣款')
    const value = moneyMicros(amount)
    if (!value || typeof reason !== 'string' || !reason.trim())
      throw relayError('invalid_adjustment', '金额必须大于零并填写原因')
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
      if (!Number.isSafeInteger(this.users.getById(userId).balance_micros + delta))
        throw relayError('invalid_amount', '余额超出安全范围')
      const now = NOW()
      this.db
        .prepare(
          'UPDATE users SET balance_micros=balance_micros+?,balance=(balance_micros+?)/1000000.0,updated_at=? WHERE id=?',
        )
        .run(delta, delta, now, userId)
      const current = this.users.getById(userId)
      const id = crypto.randomUUID()
      this.db
        .prepare(
          'INSERT INTO wallet_ledger(id,user_id,kind,amount_micros,balance_after_micros,idempotency_key,actor,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
        )
        .run(id, userId, kind, delta, current.balance_micros, idempotency_key, actor, reason.trim().slice(0, 1000), now)
      audit(this.db, actor, 'wallet.' + operation, userId, before.balance, current.balance_micros / 1e6, reason)
      return {
        ...this.balance(userId),
        transaction: this.db.prepare('SELECT * FROM wallet_ledger WHERE id=?').get(id),
        duplicate: false,
      }
    })
  }
  transfer(fromUserId, toUserId, { amount, reason, idempotency_key }, actor) {
    const value = moneyMicros(amount)
    if (!value || typeof reason !== 'string' || !reason.trim())
      throw relayError('invalid_transfer', '金额必须大于零并填写原因')
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
      const source = this.users.getById(fromUserId)
      const target = this.users.getById(toUserId)
      if (!Number.isSafeInteger(source.balance_micros - value) || !Number.isSafeInteger(target.balance_micros + value))
        throw relayError('invalid_amount', '余额超出安全范围')
      const now = NOW()
      this.db
        .prepare(
          'UPDATE users SET balance_micros=balance_micros-?,balance=(balance_micros-?)/1000000.0,updated_at=? WHERE id=?',
        )
        .run(value, value, now, fromUserId)
      this.db
        .prepare(
          'UPDATE users SET balance_micros=balance_micros+?,balance=(balance_micros+?)/1000000.0,updated_at=? WHERE id=?',
        )
        .run(value, value, now, toUserId)
      const sourceAfter = this.users.getById(fromUserId)
      const targetAfter = this.users.getById(toUserId)
      const metadata = JSON.stringify({ transfer_id: transferKey, from_user_id: fromUserId, to_user_id: toUserId })
      const sourceId = crypto.randomUUID()
      const targetId = crypto.randomUUID()
      const insert = this.db.prepare(
        'INSERT INTO wallet_ledger(id,user_id,kind,amount_micros,balance_after_micros,idempotency_key,actor,reason,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      )
      const note = reason.trim().slice(0, 1000)
      insert.run(
        sourceId,
        fromUserId,
        'transfer',
        -value,
        sourceAfter.balance_micros,
        debitKey,
        actor,
        note,
        metadata,
        now,
      )
      insert.run(
        targetId,
        toUserId,
        'transfer',
        value,
        targetAfter.balance_micros,
        creditKey,
        actor,
        note,
        metadata,
        now,
      )
      audit(this.db, actor, 'wallet.transfer', toUserId, targetBefore.balance, targetAfter.balance, reason)
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
      if (!original || !original.amount_micros || original.kind === 'reversal')
        throw relayError('invalid_reversal', '该流水不可冲正', 409)
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
      const own = ownerPred(userId)
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
          "SELECT COALESCE(SUM(CASE WHEN status='settled' THEN actual_micros ELSE reserved_micros END),0) used FROM billing_reservations WHERE subscription_id=? AND created_at>? AND status!='released'",
        )
        .get(id, since)
      return { period: key, limit: group[key + '_limit_micros'] / 1e6, used: row.used / 1e6, window: 'rolling', since }
    })
  }
  recover() {
    // A single control plane owns this SQLite database. After a restart, old holds are never guessed free.
    return this.db
      .prepare("UPDATE billing_reservations SET status='pending_usage',updated_at=? WHERE status='pending'")
      .run(NOW()).changes
  }
  reserve(record, requestId, model, body, { protocol = 'anthropic.messages' } = {}) {
    if (!record?.user_id) return null
    const user = this.users.getById(record.user_id)
    if (!['user', 'admin', 'super_admin'].includes(user?.role)) return null
    const { group, subscription, rate } = this.groups.access(user, record.group_id)
    const output = body?.max_tokens ?? body?.max_output_tokens ?? body?.max_completion_tokens ?? 1024
    if (!Number.isSafeInteger(output) || output <= 0 || output > 200000)
      throw relayError('invalid_max_tokens', '输出上限必须是 1–200000 的整数')
    if (
      protocol !== 'openai.images' &&
      body.max_tokens == null &&
      body.max_output_tokens == null &&
      body.max_completion_tokens == null
    )
      body[
        protocol === 'openai.responses'
          ? 'max_output_tokens'
          : protocol === 'openai.chat'
            ? 'max_completion_tokens'
            : 'max_tokens'
      ] = output
    const quote = resolvePrice(model)
    const imageTool = body?.tools?.find?.((tool) => tool?.type === 'image_generation')
    if (quote && imageTool) quote.image_price = resolvePrice(imageTool.model || 'gpt-image-2.5-flare')
    const price = calculateCost(
      {
        input_tokens: Buffer.byteLength(JSON.stringify(body || {})),
        output_tokens: body?.max_tokens || body?.max_output_tokens || body?.max_completion_tokens || 1024,
        requested_speed: body?.speed,
        service_tier: body?.service_tier,
      },
      model,
    )
    if (!price.known && rate !== 0) throw relayError('model_unpriced', '该模型尚未定价，不能发起付费请求', 403)
    const amount = moneyMicros((price.total_cost || 0) * rate)
    return withTransaction(this.db, () => {
      if (this.db.prepare('SELECT request_id FROM billing_reservations WHERE request_id=?').get(requestId))
        throw relayError('request_id_conflict', '请求标识已使用', 409)
      if (group.subscription_type === 'subscription') {
        for (const window of this.subscriptionWindows(subscription.id, group))
          if (window.limit > 0 && moneyMicros(window.used) + amount > moneyMicros(window.limit))
            throw relayError('subscription_quota_exceeded', '套餐剩余额度不足', 429)
      } else if (
        (amount > 0 || rate > 0) &&
        moneyMicros(this.balance(user.id).available, { negative: true }) < Math.max(1, amount)
      )
        throw relayError('insufficient_balance', '可用余额不足', 402)
      const now = NOW()
      this.db
        .prepare(
          "INSERT INTO billing_reservations(request_id,user_id,api_key_id,group_id,subscription_id,rate_multiplier,group_version,reserved_micros,status,model,quote_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'pending',?,?,?,?)",
        )
        .run(
          requestId,
          user.id,
          record.id,
          group.id,
          group.subscription_type === 'subscription' ? subscription.id : null,
          rate,
          group.version,
          amount,
          model,
          JSON.stringify(quote),
          now,
          now,
        )
      return this.db.prepare('SELECT * FROM billing_reservations WHERE request_id=?').get(requestId)
    })
  }
  settle(requestId, usage, model, _officialCost, recordKeyUsage) {
    return withTransaction(this.db, () => {
      const ticket = this.db.prepare('SELECT * FROM billing_reservations WHERE request_id=?').get(requestId)
      if (!ticket) return null
      if (ticket.status === 'settled' || ticket.status === 'released') return ticket
      const price = ticket.quote_json
        ? calculateCost(usage, model, { resolvedPrice: JSON.parse(ticket.quote_json) })
        : calculateCost(usage, model)
      if (!price.known && ticket.rate_multiplier !== 0) {
        this.db
          .prepare(
            "UPDATE billing_reservations SET status='pending_pricing',usage_json=?,updated_at=? WHERE request_id=?",
          )
          .run(JSON.stringify(usage), NOW(), requestId)
        return { ...ticket, status: 'pending_pricing' }
      }
      const actual = moneyMicros((price.total_cost || 0) * ticket.rate_multiplier)
      const now = NOW()
      if (!ticket.subscription_id) {
        // A real usage overrun is recorded as debt; future reservations fail. Never erase consumed usage.
        this.db
          .prepare(
            'UPDATE users SET balance_micros=balance_micros-?,balance=(balance_micros-?)/1000000.0,updated_at=? WHERE id=?',
          )
          .run(actual, actual, now, ticket.user_id)
        const balance = this.db
          .prepare('SELECT balance_micros FROM users WHERE id=?')
          .get(ticket.user_id).balance_micros
        this.db
          .prepare(
            "INSERT INTO wallet_ledger(id,user_id,kind,amount_micros,balance_after_micros,request_id,idempotency_key,actor,reason,metadata_json,created_at) VALUES(?,?,'usage',?,?,?,?,'gateway','API 使用扣费',?,?)",
          )
          .run(
            crypto.randomUUID(),
            ticket.user_id,
            -actual,
            balance,
            requestId,
            'usage:' + requestId,
            JSON.stringify({ group_id: ticket.group_id, rate: ticket.rate_multiplier, model }),
            now,
          )
      }
      recordKeyUsage?.(ticket.rate_multiplier, actual / 1e6, price.total_cost)
      this.db
        .prepare(
          "UPDATE billing_reservations SET status='settled',actual_micros=?,usage_json=?,model=?,updated_at=? WHERE request_id=?",
        )
        .run(actual, JSON.stringify(usage), model, now, requestId)
      this.db
        .prepare(
          "UPDATE usage_logs SET billing_status='settled',actual_cost=?,rate_multiplier=?,billing_group_id=?,subscription_id=? WHERE request_id=?",
        )
        .run(actual / 1e6, ticket.rate_multiplier, ticket.group_id, ticket.subscription_id, requestId)
      return this.db.prepare('SELECT * FROM billing_reservations WHERE request_id=?').get(requestId)
    })
  }
  finish(requestId, { dispatched = false } = {}) {
    if (!requestId) return
    this.db
      .prepare("UPDATE billing_reservations SET status=?,updated_at=? WHERE request_id=? AND status='pending'")
      .run(dispatched ? 'pending_usage' : 'released', NOW(), requestId)
  }
  resolve(requestId, { action, reason }, actor, recordKeyUsage) {
    if (!reason?.trim()) throw relayError('reason_required', '请输入处理原因')
    return withTransaction(this.db, () => {
      const ticket = this.db.prepare('SELECT * FROM billing_reservations WHERE request_id=?').get(requestId)
      if (!ticket || !['pending_pricing', 'pending_usage'].includes(ticket.status))
        throw relayError('billing_not_pending', '该请求不在待对账状态', 409)
      if (action === 'release')
        this.db
          .prepare("UPDATE billing_reservations SET status='released',updated_at=? WHERE request_id=?")
          .run(NOW(), requestId)
      else if (action === 'reprice' && ticket.usage_json) {
        if (
          !calculateCost(JSON.parse(ticket.usage_json), ticket.model, {
            resolvedPrice: JSON.parse(ticket.quote_json || 'null'),
          }).known
        )
          this.db
            .prepare('UPDATE billing_reservations SET quote_json=? WHERE request_id=?')
            .run(JSON.stringify(resolvePrice(ticket.model)), requestId)
        this.settle(requestId, JSON.parse(ticket.usage_json), ticket.model, null, recordKeyUsage)
      } else throw relayError('invalid_billing_action', '请选择释放预留或按已有真实用量重新计价')
      const next = this.db.prepare('SELECT * FROM billing_reservations WHERE request_id=?').get(requestId)
      if (next.status === 'released')
        this.db
          .prepare("UPDATE usage_logs SET billing_status='released',actual_cost=NULL WHERE request_id=?")
          .run(requestId)
      audit(this.db, actor, 'billing.resolve', requestId, ticket.status, next.status, reason)
      return next
    })
  }
}
