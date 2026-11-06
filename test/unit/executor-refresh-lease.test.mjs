import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import {
  AMBIGUOUS_HOLD_MS,
  DENIAL_AUDIT_WINDOW_MS,
  MAX_REVISION_STEP,
  REFRESH_LEASE_TTL_MS,
  createRefreshLeases,
} from '../../src/lib/executor/refresh-lease.mjs'

async function withDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-lease-'))
  const db = createDatabase({ dataDir: dir })
  try {
    return await fn(db)
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// 两个实例持有同一账号（运行 ID 相同）的副本（替换实例的接替窗口）；绑定每个账号一行（迁移 128），指向 gw-1
function setup(db) {
  const bindings = new Map([
    ['gw-1', { account_resource_id: 'acct_1', credential_revision: 3 }],
    ['gw-2', { account_resource_id: 'acct_1', credential_revision: 3 }],
  ])
  db.exec('PRAGMA foreign_keys=OFF')
  db.exec(`INSERT INTO gateway_worker_account_bindings(account_resource_id,gateway_instance_id,runtime_account_id,credential_revision,projection_status,created_at,updated_at)
           VALUES('acct_1','gw-1','rt_1',3,'synced','2026-01-01','2026-01-01')`)
  return {
    findAccountByRuntime: (instance, runtime) => (runtime === 'rt_1' ? bindings.get(instance) || null : null),
  }
}

test('only one instance holds a refresh lease; expiry, release and stale revisions are handled', () =>
  withDb(async (db) => {
    let clock = 1_900_000_000_000
    const leases = createRefreshLeases({ db, repo: setup(db), now: () => clock })
    const first = await leases.acquire({
      instanceId: 'gw-1',
      runtimeAccountId: 'rt_1',
      grant: 'native',
      credentialRevision: 3,
    })
    assert.equal(first.granted, true)
    const second = await leases.acquire({
      instanceId: 'gw-2',
      runtimeAccountId: 'rt_1',
      grant: 'native',
      credentialRevision: 3,
    })
    assert.deepEqual([second.granted, second.reason, second.holder], [false, 'lease_held', 'gw-1'])
    // BPS 与原生授权互不影响
    assert.equal((await leases.acquire({ instanceId: 'gw-2', runtimeAccountId: 'rt_1', grant: 'bps' })).granted, true)
    // 持有者报告轮换成功：释放租约、推进代次并要求投影
    assert.deepEqual(
      await leases.release({
        instanceId: 'gw-2',
        runtimeAccountId: 'rt_1',
        grant: 'native',
        leaseToken: first.lease_token,
        outcome: 'rotated',
      }),
      { ok: false, status: 409, code: 'lease_not_held' },
    )
    const released = await leases.release({
      instanceId: 'gw-1',
      runtimeAccountId: 'rt_1',
      grant: 'native',
      leaseToken: first.lease_token,
      outcome: 'rotated',
      credentialRevision: 4,
    })
    assert.deepEqual(released, { ok: true, account_resource_id: 'acct_1', propagate: true })
    assert.equal(
      db
        .prepare("SELECT credential_revision FROM gateway_worker_account_bindings WHERE gateway_instance_id='gw-1'")
        .get().credential_revision,
      4,
    )
    // 另一实例仍拿着旧代次：不能刷新，等投影
    const stale = await leases.acquire({
      instanceId: 'gw-2',
      runtimeAccountId: 'rt_1',
      grant: 'native',
      credentialRevision: 3,
    })
    assert.deepEqual([stale.granted, stale.reason], [false, 'stale_revision'])
    assert.equal(
      (await leases.acquire({ instanceId: 'gw-2', runtimeAccountId: 'rt_1', grant: 'native', credentialRevision: 4 }))
        .granted,
      true,
    )
    // 持有者失联：过期后可被其他实例重新申请
    assert.equal(
      (await leases.acquire({ instanceId: 'gw-1', runtimeAccountId: 'rt_1', grant: 'native', credentialRevision: 4 }))
        .granted,
      false,
    )
    clock += 61_000
    assert.equal(
      (await leases.acquire({ instanceId: 'gw-1', runtimeAccountId: 'rt_1', grant: 'native', credentialRevision: 4 }))
        .granted,
      true,
    )
    assert.equal((await leases.list('acct_1')).length, 2)
    // 输入校验
    assert.equal(
      (await leases.acquire({ instanceId: 'gw-1', runtimeAccountId: 'nope', grant: 'native' })).code,
      'account_binding_not_found',
    )
    assert.equal(
      (await leases.acquire({ instanceId: 'gw-1', runtimeAccountId: 'rt_1', grant: 'x' })).code,
      'invalid_grant_kind',
    )
    const failed = await leases.acquire({ instanceId: 'gw-1', runtimeAccountId: 'rt_1', grant: 'bps' })
    clock += 61_000
    const again = await leases.acquire({ instanceId: 'gw-1', runtimeAccountId: 'rt_1', grant: 'bps' })
    assert.equal(again.granted, true)
    assert.equal(
      (
        await leases.release({
          instanceId: 'gw-1',
          runtimeAccountId: 'rt_1',
          grant: 'bps',
          leaseToken: failed.lease_token,
          outcome: 'failed',
        })
      ).code,
      'lease_not_held',
      'an expired and re-acquired lease cannot be released with the old token',
    )
    assert.equal(
      (
        await leases.release({
          instanceId: 'gw-1',
          runtimeAccountId: 'rt_1',
          grant: 'bps',
          leaseToken: again.lease_token,
          outcome: 'nope',
        })
      ).code,
      'invalid_outcome',
    )
  }))

// G1：rotated 在释放租约的同一事务里写凭据库（onRotated）。被重新授权取代时释放租约并回复 409；
// 其他写入失败时事务回滚、租约仍在持有者手里（Worker 重试报告），代次不推进
test('a rotated release writes the vault in the same transaction and keeps the lease when it fails', () =>
  withDb(async (db) => {
    const leases = createRefreshLeases({ db, repo: setup(db) })
    const revisionOf = () =>
      db
        .prepare("SELECT credential_revision FROM gateway_worker_account_bindings WHERE gateway_instance_id='gw-1'")
        .get().credential_revision
    const lease = await leases.acquire({
      instanceId: 'gw-1',
      runtimeAccountId: 'rt_1',
      grant: 'native',
      credentialRevision: 3,
    })
    const rotate = (onRotated) =>
      leases.release({
        instanceId: 'gw-1',
        runtimeAccountId: 'rt_1',
        grant: 'native',
        leaseToken: lease.lease_token,
        outcome: 'rotated',
        credentialRevision: 4,
        onRotated,
      })
    await assert.rejects(
      rotate(async () => {
        throw Object.assign(new Error('bundle key missing'), { code: 'bundle_key_missing' })
      }),
      { code: 'bundle_key_missing' },
    )
    assert.equal(db.prepare('SELECT state FROM credential_refresh_leases').get().state, 'held')
    assert.equal(revisionOf(), 3)
    const seen = []
    assert.deepEqual(
      await rotate(async ({ accountResourceId }) => {
        seen.push(accountResourceId)
        throw Object.assign(new Error('superseded'), { code: 'credential_superseded', current_revision: 7 })
      }),
      { ok: false, status: 409, code: 'credential_superseded', account_resource_id: 'acct_1', current_revision: 7 },
    )
    assert.deepEqual(seen, ['acct_1'])
    assert.deepEqual(
      { ...db.prepare('SELECT state,outcome,credential_revision FROM credential_refresh_leases').get() },
      { state: 'released', outcome: 'superseded', credential_revision: 3 },
    )
    assert.equal(revisionOf(), 3)
    // 成功写入：释放租约并推进代次
    const next = await leases.acquire({
      instanceId: 'gw-1',
      runtimeAccountId: 'rt_1',
      grant: 'native',
      credentialRevision: 3,
    })
    assert.deepEqual(
      await leases.release({
        instanceId: 'gw-1',
        runtimeAccountId: 'rt_1',
        grant: 'native',
        leaseToken: next.lease_token,
        outcome: 'rotated',
        credentialRevision: 4,
        onRotated: async () => {},
      }),
      { ok: true, account_resource_id: 'acct_1', propagate: true },
    )
    assert.equal(revisionOf(), 4)
  }))

test('BPS refresh tokens rotated elsewhere are refused by fingerprint and resynced; re-authorization is not blocked', () =>
  withDb(async (db) => {
    let clock = 1_900_000_000_000
    const leases = createRefreshLeases({ db, repo: setup(db), now: () => clock })
    const bps = (instanceId, revision, fingerprint) =>
      leases.acquire({
        instanceId,
        runtimeAccountId: 'rt_1',
        grant: 'bps',
        credentialRevision: revision,
        tokenFingerprint: fingerprint,
      })
    const first = await bps('gw-1', 1, 'aaaaaaaaaaaaaaaa')
    assert.equal(first.granted, true)
    await leases.release({
      instanceId: 'gw-1',
      runtimeAccountId: 'rt_1',
      grant: 'bps',
      leaseToken: first.lease_token,
      outcome: 'rotated',
      credentialRevision: 1,
      tokenFingerprint: 'bbbbbbbbbbbbbbbb',
    })
    // gw-2 仍拿着轮换前的令牌（BPS 代次不变）：拒绝并要求从 gw-1 投影
    const stale = await bps('gw-2', 1, 'aaaaaaaaaaaaaaaa')
    assert.deepEqual(
      [stale.granted, stale.reason, stale.resync],
      [false, 'stale_token', { holder: 'gw-1', runtime_account_id: 'rt_1' }],
    )
    // 投影送达后指纹一致，可以刷新；失败的刷新不改变记录的指纹
    const fresh = await bps('gw-2', 1, 'bbbbbbbbbbbbbbbb')
    assert.equal(fresh.granted, true)
    await leases.release({
      instanceId: 'gw-2',
      runtimeAccountId: 'rt_1',
      grant: 'bps',
      leaseToken: fresh.lease_token,
      outcome: 'failed',
    })
    assert.equal(
      (await leases.list('acct_1')).find((row) => row.grant_kind === 'bps').token_fingerprint,
      'bbbbbbbbbbbbbbbb',
    )
    assert.equal((await bps('gw-1', 1, 'aaaaaaaaaaaaaaaa')).reason, 'stale_token')
    // 重新授权提高代次：旧指纹不再约束
    assert.equal((await bps('gw-1', 2, 'cccccccccccccccc')).granted, true)
    // 不带指纹（旧版 Worker）按原规则
    clock += 61_000
    assert.equal((await bps('gw-2', 1, null)).granted, true)
  }))

test('a held lease is not re-granted to its own holder; ambiguous outcomes hold the lease; huge revision jumps are rejected', () =>
  withDb(async (db) => {
    let clock = 1_900_000_000_000
    const leases = createRefreshLeases({ db, repo: setup(db), now: () => clock })
    const acquire = (instanceId) =>
      leases.acquire({ instanceId, runtimeAccountId: 'rt_1', grant: 'native', credentialRevision: 3 })
    const first = await acquire('gw-1')
    assert.equal(first.granted, true)
    assert.equal((await acquire('gw-1')).reason, 'lease_held', 'the holder cannot overwrite its own live lease')
    const ambiguous = await leases.release({
      instanceId: 'gw-1',
      runtimeAccountId: 'rt_1',
      grant: 'native',
      leaseToken: first.lease_token,
      outcome: 'ambiguous',
    })
    assert.equal(ambiguous.propagate, false)
    // 结果不明写审计（R3 复审 N7）
    assert.ok(db.prepare("SELECT 1 FROM operation_audit WHERE action='gateway.refresh_lease.ambiguous'").get())
    clock += 61_000
    assert.equal((await acquire('gw-2')).reason, 'outcome_unknown', 'still held after the normal TTL')
    clock += AMBIGUOUS_HOLD_MS
    const next = await acquire('gw-2')
    assert.equal(next.granted, true)
    assert.deepEqual(
      await leases.release({
        instanceId: 'gw-2',
        runtimeAccountId: 'rt_1',
        grant: 'native',
        leaseToken: next.lease_token,
        outcome: 'rotated',
        credentialRevision: 3 + MAX_REVISION_STEP + 1,
      }),
      { ok: false, status: 409, code: 'revision_jump' },
    )
  }))

// 审计 F10：四种租约冲突按（账号、授权类别、原因）每 10 分钟最多写一条审计，压下的次数累计到下一条；
// 审计写入失败不影响租约响应
test('lease denials are audited at most once per account, grant and reason every ten minutes', () =>
  withDb(async (db) => {
    const start = 1_900_000_000_000
    let clock = start
    const leases = createRefreshLeases({ db, repo: setup(db), now: () => clock })
    const audits = () =>
      db
        .prepare(
          "SELECT actor,target,after_json,created_at FROM operation_audit WHERE action='gateway.refresh_lease.denied' ORDER BY id",
        )
        .all()
        .map((row) => ({ ...row, after: JSON.parse(row.after_json) }))
    const ask = (instanceId, grant = 'native', credentialRevision = 3) =>
      leases.acquire({ instanceId, runtimeAccountId: 'rt_1', grant, credentialRevision })
    assert.equal((await ask('gw-1')).granted, true)
    for (let i = 0; i < 3; i++) assert.equal((await ask('gw-2')).reason, 'lease_held')
    assert.equal(audits().length, 1, 'repeated denials inside the window write one audit')
    assert.deepEqual(
      [
        audits()[0].actor,
        audits()[0].target,
        audits()[0].after.reason,
        audits()[0].after.holder,
        audits()[0].after.suppressed,
      ],
      ['gateway:gw-2', 'acct_1', 'lease_held', 'gw-1', 0],
    )
    // 另一种原因、另一类授权各自计
    assert.equal((await ask('gw-2', 'native', 2)).reason, 'stale_revision')
    assert.equal((await ask('gw-1', 'bps')).granted, true)
    assert.equal((await ask('gw-2', 'bps')).reason, 'lease_held')
    assert.deepEqual(
      audits().map((row) => [row.after.grant, row.after.reason]),
      [
        ['native', 'lease_held'],
        ['native', 'stale_revision'],
        ['bps', 'lease_held'],
      ],
    )
    // 租约过期后重新被持有，仍在 10 分钟窗口内：继续压下
    clock = start + REFRESH_LEASE_TTL_MS + 1
    assert.equal((await ask('gw-1')).granted, true)
    assert.equal((await ask('gw-2')).reason, 'lease_held')
    assert.equal(audits().length, 3)
    // 窗口过后的下一条带上期间压下的次数（2 + 1）
    clock = start + DENIAL_AUDIT_WINDOW_MS
    assert.equal((await ask('gw-1')).granted, true)
    assert.equal((await ask('gw-2')).reason, 'lease_held')
    const latest = audits().at(-1)
    assert.deepEqual([latest.after.reason, latest.after.suppressed, latest.after.window_minutes], ['lease_held', 3, 10])
    assert.equal(latest.created_at, new Date(clock).toISOString())

    // 写入失败：租约响应照常返回，这一次计入压下的次数，下一次拒绝时补写
    clock = start + 3 * DENIAL_AUDIT_WINDOW_MS
    assert.equal((await ask('gw-1', 'bps')).granted, true)
    db.exec('ALTER TABLE operation_audit RENAME TO operation_audit_hidden')
    const warn = console.warn
    const warnings = []
    console.warn = (message) => warnings.push(String(message))
    try {
      const denied = await ask('gw-2', 'bps')
      assert.deepEqual(
        [denied.granted, denied.status, denied.reason, denied.holder],
        [false, 409, 'lease_held', 'gw-1'],
      )
    } finally {
      console.warn = warn
      db.exec('ALTER TABLE operation_audit_hidden RENAME TO operation_audit')
    }
    assert.ok(warnings.some((message) => message.includes('writing the denial audit')))
    assert.equal((await ask('gw-2', 'bps')).reason, 'lease_held')
    const retried = audits().at(-1)
    assert.deepEqual([retried.after.grant, retried.after.suppressed], ['bps', 1])
  }))
