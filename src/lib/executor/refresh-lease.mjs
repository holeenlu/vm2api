/**
 * 凭据刷新租约（docs/control-plane/DEVELOPMENT_PLAN.md P3.1、设计第 6 节）。
 *
 * KIN_REFRESH_LEASE=on 时，Worker 刷新原生或 BPS 授权前先申请租约：同一账号、同一授权类别同一时刻只有一个持有者，
 * 刷新令牌只被使用一次。持有者刷新后调用 rotate 报告结果；成功时控制面把新凭据从持有者投影到其他实例。
 * 租约 60 秒过期：过期后可重新申请（持有者若已在上游轮换却没来得及报告，其他副本的刷新会被上游拒绝并标记失效，
 * 与没有租约时的结果相同，不会更糟）。
 *
 * 过时判断（P3.2）：原生授权比较凭据代次；BPS 授权刷新不改代次，改为比较刷新令牌指纹（迁移 105）——
 * 最近一次轮换记下新令牌的指纹与代次，其他实例以不高于该代次、指纹不同的令牌申请时拒绝（stale_token），
 * 并返回 resync（轮换后的持有者），由调用方把新凭据投影过去。重新授权会提高代次，不受旧指纹限制。
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

export function refreshLeaseDenials() {
  return { since: leaseDenials.since, counts: { ...leaseDenials.counts }, recent: [...leaseDenials.recent].reverse() }
}

export function refreshLeaseEnabled(env = process.env) {
  return (
    String(env.KIN_REFRESH_LEASE || '')
      .trim()
      .toLowerCase() === 'on'
  )
}

/**
 * 预刷新指派（P3.3，设计 6.2）：每个账号只由一个在线实例做定时预刷新，其余实例跳过定时刷新、等投影送来新凭据。
 * 选在线实例中该账号凭据代次最高者，同代次按实例 ID 排序取第一个（结果稳定，实例离线后下一次心跳即改派）。
 * 请求内 401 与手动刷新不受指派限制，仍按租约互斥。返回指派给 instanceId 的运行账号 ID（排序）。
 */
export function designatedRefreshAccounts(bindings = [], online = [], instanceId = '') {
  const live = new Set(online)
  const best = new Map()
  for (const binding of bindings) {
    if (!live.has(binding.gateway_instance_id)) continue
    const current = best.get(binding.account_resource_id)
    const revision = Number(binding.credential_revision || 0)
    if (
      !current ||
      revision > current.revision ||
      (revision === current.revision && binding.gateway_instance_id < current.binding.gateway_instance_id)
    )
      best.set(binding.account_resource_id, { binding, revision })
  }
  return [...best.values()]
    .filter((item) => item.binding.gateway_instance_id === instanceId)
    .map((item) => String(item.binding.runtime_account_id))
    .sort()
}

export function createRefreshLeases({ db, repo, now = () => Date.now(), ttlMs = REFRESH_LEASE_TTL_MS }) {
  const leases = refreshLeaseRepo(db)
  const client = dbClient(db)
  const stamp = (ms = now()) => new Date(ms).toISOString()

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
    // 租约冲突计入进程内统计，「Gateway Worker」页可见（审计 U8）
    if (result && !result.granted && result.reason)
      recordLeaseDenial({
        reason: result.reason,
        account_resource_id: result.account_resource_id || null,
        grant: input?.grant || null,
        instance_id: input?.instanceId || null,
        holder: result.holder || result.resync?.holder || null,
        at: stamp(now()),
      })
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
