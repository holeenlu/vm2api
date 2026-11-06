/**
 * 凭据刷新租约（docs/control-plane/DEVELOPMENT_PLAN.md P3.1、设计第 6 节）。
 *
 * Worker 刷新原生或 BPS 授权前先申请租约（2026-11-06 起恒开，原 KIN_REFRESH_LEASE 开关已移除）：同一账号、同一授权类别
 * 同一时刻只有一个持有者，刷新令牌只被使用一次。持有者刷新后调用 release 报告结果；rotated 时在释放租约的同一事务里
 * 按代次 CAS 写入凭据库（onRotated），成功后控制面把新凭据从持有者投影到其他实例。
 * 租约 60 秒过期：过期后可重新申请（持有者若已在上游轮换却没来得及报告，其他副本的刷新会被上游拒绝并标记失效，
 * 与没有租约时的结果相同，不会更糟）。
 *
 * 过时判断（P3.2）：原生授权先比较凭据代次（低于各实例已知的最高代次即 stale_revision）。两类授权都再比较刷新令牌指纹
 * （迁移 105）：最近一次轮换记下新令牌的指纹与代次，其他实例以不高于该代次、指纹不同的令牌申请时拒绝（stale_token），
 * 并返回 resync（轮换后的持有者），由调用方把新凭据投影过去。BPS 的代次是 Worker 令牌代次 token_generation（每次授权、
 * 导入、刷新递增）；重新授权会提高代次，不受旧指纹限制。指纹只用于这里的申请判断，轮换写回凭据库按代次 CAS（credential-custody.mjs）。
 *
 * 数据访问经 DbClient 异步进行（R6 B3）。acquire / release 的“读当前持有者 → 判断 → 写租约”在同一个 db.tx 里（竞态 R15）：
 * SQLite 单连接上事务不跨事件循环（事务内只等数据库操作），读与写之间不会插入其他申请；
 * 迁 PostgreSQL 时在 DbClient 层对租约行加行锁（SELECT … FOR UPDATE），或改为按过期条件的条件写并按影响行数判定。
 */
import crypto from 'node:crypto'
import { dbClient } from '../db/db-client.mjs'
import { insertOperationAudit } from '../admin/repos/relay-repo.mjs'
import { refreshLeaseRepo } from './repos/refresh-lease-repo.mjs'

export const REFRESH_LEASE_TTL_MS = 60_000
// 结果不明（换票请求已发出却没拿到响应）：上游可能已轮换刷新令牌，这段时间内不向任何实例发放租约（R3 审查 P1-4）
export const AMBIGUOUS_HOLD_MS = 10 * 60_000
// 一次报告允许的最大代次增幅：防止异常或恶意上报把代次推到极大值后永久锁死（R3 审查 P2-6）
export const MAX_REVISION_STEP = 1000
export const GRANT_KINDS = Object.freeze(['native', 'bps'])

const fingerprintOf = (value) => (/^[0-9a-f]{16}$/.test(String(value || '')) ? String(value) : null)

// 本进程启动以来的租约冲突（申请被拒）统计：按原因计数，保留最近 20 条（审计 U8）。进程重启清零
const leaseDenials = { since: new Date().toISOString(), counts: {}, recent: [] }

function recordLeaseDenial(entry) {
  leaseDenials.counts[entry.reason] = (leaseDenials.counts[entry.reason] || 0) + 1
  leaseDenials.recent.push(entry)
  if (leaseDenials.recent.length > 20) leaseDenials.recent.shift()
}

// 租约冲突写审计（审计 F10）：lease_held、stale_revision、stale_token、outcome_unknown 四种拒绝。
// 多 Worker 争用同一账号时拒绝很密集，按（账号、授权类别、原因）每 DENIAL_AUDIT_WINDOW_MS 最多写一条，
// 期间被压下的次数累计到下一条的 suppressed。限频状态在进程内（重启后重新计），进程内计数（上面的 leaseDenials）照常
export const DENIAL_AUDIT_WINDOW_MS = 10 * 60_000
export const AUDITED_DENIAL_REASONS = Object.freeze(['lease_held', 'stale_revision', 'stale_token', 'outcome_unknown'])
// 限频表的上限：超过时先清掉窗口已过的条目（账号数 × 2 类授权 × 4 种原因，正常远低于此）
const DENIAL_AUDIT_MAX_KEYS = 10_000

export function refreshLeaseDenials() {
  return { since: leaseDenials.since, counts: { ...leaseDenials.counts }, recent: [...leaseDenials.recent].reverse() }
}

export function createRefreshLeases({ db, repo, now = () => Date.now(), ttlMs = REFRESH_LEASE_TTL_MS }) {
  const leases = refreshLeaseRepo(db)
  const client = dbClient(db)
  const stamp = (ms = now()) => new Date(ms).toISOString()
  // 租约冲突审计的限频状态：key → { lastAt（上一次写入成功的时刻）, suppressed（之后被压下的次数）}
  const denialAudit = new Map()

  /** 按限频写一条租约冲突审计；写入失败只告警，不影响租约响应（被压下的次数留到下一条）。 */
  async function auditDenial(entry, result) {
    if (!AUDITED_DENIAL_REASONS.includes(entry.reason) || !entry.account_resource_id) return
    const key = `${entry.account_resource_id}\u0000${entry.grant}\u0000${entry.reason}`
    const at = now()
    const state = denialAudit.get(key)
    if (state && at - state.lastAt < DENIAL_AUDIT_WINDOW_MS) {
      state.suppressed++
      return
    }
    if (!state && denialAudit.size >= DENIAL_AUDIT_MAX_KEYS)
      for (const [name, item] of denialAudit) if (at - item.lastAt >= DENIAL_AUDIT_WINDOW_MS) denialAudit.delete(name)
    const suppressed = state?.suppressed || 0
    // 写入前先占住本窗口：同一键的并发拒绝在 await 期间看到已占用，计入压下次数而不是各写一条
    const claimed = { lastAt: at, suppressed: 0 }
    denialAudit.set(key, claimed)
    try {
      await insertOperationAudit(
        db,
        `gateway:${entry.instance_id}`,
        'gateway.refresh_lease.denied',
        entry.account_resource_id,
        null,
        JSON.stringify({
          grant: entry.grant,
          reason: entry.reason,
          holder: entry.holder,
          ...(result.expires_at ? { expires_at: result.expires_at } : {}),
          suppressed,
          window_minutes: DENIAL_AUDIT_WINDOW_MS / 60_000,
        }),
        '',
        stamp(at),
      )
    } catch (error) {
      // 本条没写进去：退回占用前的窗口，计入压下的次数（含占用期间并发压下的），下一次拒绝时再写
      denialAudit.set(key, {
        lastAt: state?.lastAt ?? Number.NEGATIVE_INFINITY,
        suppressed: suppressed + 1 + claimed.suppressed,
      })
      console.warn(
        `refresh lease: writing the denial audit for ${entry.account_resource_id}/${entry.grant} failed: ${error?.message || error}`,
      )
    }
  }

  async function resolve(instanceId, runtimeAccountId, grant) {
    if (!GRANT_KINDS.includes(grant)) return { error: { status: 400, code: 'invalid_grant_kind' } }
    const binding = await repo.findAccountByRuntime(instanceId, String(runtimeAccountId || ''))
    if (!binding) return { error: { status: 404, code: 'account_binding_not_found' } }
    return { binding }
  }

  // 本账号所有实例中已知的最新凭据代次（原生授权；BPS 授权的代次由 Worker 自行管理，不在此比较）
  async function latestRevision(accountResourceId) {
    return Number((await leases.latestBindingRevision(accountResourceId)) || 0)
  }

  /** 申请租约；返回 { granted, lease_token, expires_at } 或 { granted:false, reason, holder, expires_at }。 */
  async function acquire(input) {
    const result = await acquireOnce(input)
    // 租约冲突计入进程内统计，「Gateway Worker」页可见（审计 U8）；并按限频写审计（审计 F10）
    if (result && !result.granted && result.reason) {
      const entry = {
        reason: result.reason,
        account_resource_id: result.account_resource_id || null,
        grant: input?.grant || null,
        instance_id: input?.instanceId || null,
        holder: result.holder || result.resync?.holder || null,
        at: stamp(now()),
      }
      recordLeaseDenial(entry)
      await auditDenial(entry, result)
    }
    return result
  }

  async function acquireOnce({ instanceId, runtimeAccountId, grant, credentialRevision = 0, tokenFingerprint = null }) {
    const { binding, error } = await resolve(instanceId, runtimeAccountId, grant)
    if (error) return { granted: false, ...error }
    return client.tx(async () => {
      const at = now()
      if (grant === 'native' && Number(credentialRevision) < (await latestRevision(binding.account_resource_id)))
        // 其他实例已刷新：等投影把新凭据送达，不要用旧的刷新令牌
        return {
          granted: false,
          status: 409,
          reason: 'stale_revision',
          account_resource_id: binding.account_resource_id,
        }
      const current = await leases.get(binding.account_resource_id, grant)
      const fingerprint = fingerprintOf(tokenFingerprint)
      if (
        fingerprint &&
        current?.token_fingerprint &&
        current.token_fingerprint !== fingerprint &&
        current.holder_instance_id !== instanceId &&
        Number(credentialRevision) <= Number(current.credential_revision)
      )
        // 手里的刷新令牌已被其他实例轮换：不要再用，等投影送来新令牌
        return {
          granted: false,
          status: 409,
          reason: 'stale_token',
          account_resource_id: binding.account_resource_id,
          resync: { holder: current.holder_instance_id, runtime_account_id: current.runtime_account_id },
        }
      if (current?.state === 'ambiguous' && Date.parse(current.expires_at) > at)
        return {
          granted: false,
          status: 409,
          reason: 'outcome_unknown',
          account_resource_id: binding.account_resource_id,
          holder: current.holder_instance_id,
          expires_at: current.expires_at,
        }
      // 同一实例也不能在租约有效期内重复申请（会覆盖自己仍在使用的租约令牌，R3 审查 P2-3）
      if (current?.state === 'held' && Date.parse(current.expires_at) > at)
        return {
          granted: false,
          status: 409,
          reason: 'lease_held',
          account_resource_id: binding.account_resource_id,
          holder: current.holder_instance_id,
          expires_at: current.expires_at,
        }
      const token = crypto.randomBytes(18).toString('base64url')
      const expiresAt = stamp(at + ttlMs)
      await leases.hold({
        accountResourceId: binding.account_resource_id,
        grant,
        instanceId,
        runtimeAccountId: String(runtimeAccountId),
        token,
        credentialRevision: Number(credentialRevision) || 0,
        expiresAt,
        at: stamp(at),
      })
      return {
        granted: true,
        lease_token: token,
        expires_at: expiresAt,
        account_resource_id: binding.account_resource_id,
      }
    })
  }

  /**
   * 持有者报告刷新结果：outcome 为 rotated（成功，附新代次）/ failed（可重试）/ terminal（刷新令牌被拒）/
   * ambiguous（请求已发出却没拿到响应，上游可能已轮换：租约改为 ambiguous 并保持 AMBIGUOUS_HOLD_MS）。
   * rotated 时先在同一事务里调用 onRotated（按代次 CAS 写凭据库）：它抛 credential_superseded 时释放租约（outcome
   * superseded）并回复 409；抛其他错误时整个事务回滚、租约仍由持有者持有，调用方回复 5xx 让持有者重试报告。
   * 返回 { ok, account_resource_id, propagate }；propagate 为真时调用方把新凭据从持有者投影到其他实例。
   */
  async function release({
    instanceId,
    runtimeAccountId,
    grant,
    leaseToken,
    outcome,
    credentialRevision = null,
    tokenFingerprint = null,
    onRotated = null,
  }) {
    const { binding, error } = await resolve(instanceId, runtimeAccountId, grant)
    if (error) return { ok: false, ...error }
    if (!['rotated', 'failed', 'terminal', 'ambiguous'].includes(outcome))
      return { ok: false, status: 400, code: 'invalid_outcome' }
    return client.tx(async () => {
      const current = await leases.get(binding.account_resource_id, grant)
      if (!current || current.lease_token !== leaseToken || current.holder_instance_id !== instanceId)
        return { ok: false, status: 409, code: 'lease_not_held' }
      if (
        outcome === 'rotated' &&
        credentialRevision != null &&
        Number(credentialRevision) > Number(current.credential_revision || 0) + MAX_REVISION_STEP
      )
        return { ok: false, status: 409, code: 'revision_jump' }
      if (outcome === 'ambiguous') {
        // 不释放：保持到 AMBIGUOUS_HOLD_MS 之后，期间任何实例都拿不到租约；之后的第一次刷新会得到明确结果。
        // 写审计并告警，排障时能看到账号为什么暂时不刷新（R3 复审 N7）
        console.warn(
          `refresh lease: ${binding.account_resource_id}/${grant} outcome unknown on ${instanceId}; held until ${stamp(now() + AMBIGUOUS_HOLD_MS)}`,
        )
        await insertOperationAudit(
          db,
          `gateway:${instanceId}`,
          'gateway.refresh_lease.ambiguous',
          binding.account_resource_id,
          null,
          JSON.stringify({ grant, held_until: stamp(now() + AMBIGUOUS_HOLD_MS) }),
          '',
          stamp(),
        )
        await leases.markAmbiguous(binding.account_resource_id, grant, stamp(now() + AMBIGUOUS_HOLD_MS), stamp())
        return {
          ok: true,
          account_resource_id: binding.account_resource_id,
          propagate: false,
          held_until: stamp(now() + AMBIGUOUS_HOLD_MS),
        }
      }
      if (outcome === 'rotated' && onRotated) {
        try {
          await onRotated({ accountResourceId: binding.account_resource_id })
        } catch (error) {
          if (error?.code !== 'credential_superseded') throw error
          await leases.release({
            accountResourceId: binding.account_resource_id,
            grant,
            outcome: 'superseded',
            credentialRevision: null,
            tokenFingerprint: null,
            updatedAt: stamp(),
          })
          return {
            ok: false,
            status: 409,
            code: 'credential_superseded',
            account_resource_id: binding.account_resource_id,
            current_revision: error.current_revision ?? null,
          }
        }
      }
      await leases.release({
        accountResourceId: binding.account_resource_id,
        grant,
        outcome,
        credentialRevision: credentialRevision == null ? null : Number(credentialRevision),
        tokenFingerprint: fingerprintOf(tokenFingerprint),
        updatedAt: stamp(),
      })
      if (outcome === 'rotated' && grant === 'native' && credentialRevision != null)
        await leases.raiseBindingRevision(instanceId, String(runtimeAccountId), Number(credentialRevision))
      return {
        ok: true,
        account_resource_id: binding.account_resource_id,
        propagate: outcome === 'rotated',
      }
    })
  }

  async function list(accountResourceId) {
    return (await leases.list(accountResourceId)).map((row) => ({ ...row }))
  }

  return { acquire, release, list }
}
