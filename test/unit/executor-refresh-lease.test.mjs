import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import {
  AMBIGUOUS_HOLD_MS,
  MAX_REVISION_STEP,
  createRefreshLeases,
  designatedRefreshAccounts,
  refreshLeaseEnabled,
} from '../../src/lib/executor/refresh-lease.mjs'

function withDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-lease-'))
  const db = createDatabase({ dataDir: dir })
  try {
    return fn(db)
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// 两个实例持有同一账号（运行 ID 相同）的副本
function setup(db) {
  const bindings = new Map([
    ['gw-1', { account_resource_id: 'acct_1', credential_revision: 3 }],
    ['gw-2', { account_resource_id: 'acct_1', credential_revision: 3 }],
  ])
  db.exec('PRAGMA foreign_keys=OFF')
  db.exec(`INSERT INTO gateway_worker_account_bindings(account_resource_id,gateway_instance_id,runtime_account_id,credential_revision,projection_status,created_at,updated_at)
           VALUES('acct_1','gw-1','rt_1',3,'synced','2026-01-01','2026-01-01'),('acct_1','gw-2','rt_1',3,'synced','2026-01-01','2026-01-01')`)
  return {
    findAccountByRuntime: (instance, runtime) => (runtime === 'rt_1' ? bindings.get(instance) || null : null),
  }
}

test('only one instance holds a refresh lease; expiry, release and stale revisions are handled', () =>
  withDb((db) => {
    let clock = 1_900_000_000_000
    const leases = createRefreshLeases({ db, repo: setup(db), now: () => clock })
    const first = leases.acquire({
      instanceId: 'gw-1',
      runtimeAccountId: 'rt_1',
      grant: 'native',
      credentialRevision: 3,
    })
    assert.equal(first.granted, true)
    const second = leases.acquire({
      instanceId: 'gw-2',
      runtimeAccountId: 'rt_1',
      grant: 'native',
      credentialRevision: 3,
    })
    assert.deepEqual([second.granted, second.reason, second.holder], [false, 'lease_held', 'gw-1'])
    // BPS 与原生授权互不影响
    assert.equal(leases.acquire({ instanceId: 'gw-2', runtimeAccountId: 'rt_1', grant: 'bps' }).granted, true)
    // 持有者报告轮换成功：释放租约、推进代次并要求投影
    assert.deepEqual(
      leases.release({
        instanceId: 'gw-2',
        runtimeAccountId: 'rt_1',
        grant: 'native',
        leaseToken: first.lease_token,
        outcome: 'rotated',
      }),
      { ok: false, status: 409, code: 'lease_not_held' },
    )
    const released = leases.release({
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
    const stale = leases.acquire({
      instanceId: 'gw-2',
      runtimeAccountId: 'rt_1',
      grant: 'native',
      credentialRevision: 3,
    })
    assert.deepEqual([stale.granted, stale.reason], [false, 'stale_revision'])
    assert.equal(
      leases.acquire({ instanceId: 'gw-2', runtimeAccountId: 'rt_1', grant: 'native', credentialRevision: 4 }).granted,
      true,
    )
    // 持有者失联：过期后可被其他实例重新申请
    assert.equal(
      leases.acquire({ instanceId: 'gw-1', runtimeAccountId: 'rt_1', grant: 'native', credentialRevision: 4 }).granted,
      false,
    )
    clock += 61_000
    assert.equal(
      leases.acquire({ instanceId: 'gw-1', runtimeAccountId: 'rt_1', grant: 'native', credentialRevision: 4 }).granted,
      true,
    )
    assert.equal(leases.list('acct_1').length, 2)
    // 输入校验
    assert.equal(
      leases.acquire({ instanceId: 'gw-1', runtimeAccountId: 'nope', grant: 'native' }).code,
      'account_binding_not_found',
    )
    assert.equal(
      leases.acquire({ instanceId: 'gw-1', runtimeAccountId: 'rt_1', grant: 'x' }).code,
      'invalid_grant_kind',
    )
    const failed = leases.acquire({ instanceId: 'gw-1', runtimeAccountId: 'rt_1', grant: 'bps' })
    clock += 61_000
    const again = leases.acquire({ instanceId: 'gw-1', runtimeAccountId: 'rt_1', grant: 'bps' })
    assert.equal(again.granted, true)
    assert.equal(
      leases.release({
        instanceId: 'gw-1',
        runtimeAccountId: 'rt_1',
        grant: 'bps',
        leaseToken: failed.lease_token,
        outcome: 'failed',
      }).code,
      'lease_not_held',
      'an expired and re-acquired lease cannot be released with the old token',
    )
    assert.equal(
      leases.release({
        instanceId: 'gw-1',
        runtimeAccountId: 'rt_1',
        grant: 'bps',
        leaseToken: again.lease_token,
        outcome: 'nope',
      }).code,
      'invalid_outcome',
    )
  }))

test('refresh lease switch is off by default', () => {
  assert.equal(refreshLeaseEnabled({}), false)
  assert.equal(refreshLeaseEnabled({ KIN_REFRESH_LEASE: 'ON' }), true)
})

test('BPS refresh tokens rotated elsewhere are refused by fingerprint and resynced; re-authorization is not blocked', () =>
  withDb((db) => {
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
    const first = bps('gw-1', 1, 'aaaaaaaaaaaaaaaa')
    assert.equal(first.granted, true)
    leases.release({
      instanceId: 'gw-1',
      runtimeAccountId: 'rt_1',
      grant: 'bps',
      leaseToken: first.lease_token,
      outcome: 'rotated',
      credentialRevision: 1,
      tokenFingerprint: 'bbbbbbbbbbbbbbbb',
    })
    // gw-2 仍拿着轮换前的令牌（BPS 代次不变）：拒绝并要求从 gw-1 投影
    const stale = bps('gw-2', 1, 'aaaaaaaaaaaaaaaa')
    assert.deepEqual(
      [stale.granted, stale.reason, stale.resync],
      [false, 'stale_token', { holder: 'gw-1', runtime_account_id: 'rt_1' }],
    )
    // 投影送达后指纹一致，可以刷新；失败的刷新不改变记录的指纹
    const fresh = bps('gw-2', 1, 'bbbbbbbbbbbbbbbb')
    assert.equal(fresh.granted, true)
    leases.release({
      instanceId: 'gw-2',
      runtimeAccountId: 'rt_1',
      grant: 'bps',
      leaseToken: fresh.lease_token,
      outcome: 'failed',
    })
    assert.equal(leases.list('acct_1').find((row) => row.grant_kind === 'bps').token_fingerprint, 'bbbbbbbbbbbbbbbb')
    assert.equal(bps('gw-1', 1, 'aaaaaaaaaaaaaaaa').reason, 'stale_token')
    // 重新授权提高代次：旧指纹不再约束
    assert.equal(bps('gw-1', 2, 'cccccccccccccccc').granted, true)
    // 不带指纹（旧版 Worker）按原规则
    clock += 61_000
    assert.equal(bps('gw-2', 1, null).granted, true)
  }))

test('scheduled pre-refresh is designated to one online instance per account', () => {
  const bindings = [
    { account_resource_id: 'acct_1', gateway_instance_id: 'gw-2', runtime_account_id: 'rt_1', credential_revision: 4 },
    { account_resource_id: 'acct_1', gateway_instance_id: 'gw-1', runtime_account_id: 'rt_1', credential_revision: 3 },
    { account_resource_id: 'acct_2', gateway_instance_id: 'gw-2', runtime_account_id: 'rt_2', credential_revision: 1 },
    { account_resource_id: 'acct_2', gateway_instance_id: 'gw-1', runtime_account_id: 'rt_2', credential_revision: 1 },
    { account_resource_id: 'acct_3', gateway_instance_id: 'gw-3', runtime_account_id: 'rt_3', credential_revision: 9 },
  ]
  const online = ['gw-1', 'gw-2']
  // 代次最高者优先；同代次按实例 ID；离线实例不参与
  assert.deepEqual(designatedRefreshAccounts(bindings, online, 'gw-1'), ['rt_2'])
  assert.deepEqual(designatedRefreshAccounts(bindings, online, 'gw-2'), ['rt_1'])
  assert.deepEqual(designatedRefreshAccounts(bindings, online, 'gw-3'), [])
  // gw-2 离线：下一次心跳改派给 gw-1
  assert.deepEqual(designatedRefreshAccounts(bindings, ['gw-1'], 'gw-1'), ['rt_1', 'rt_2'])
})

test('a held lease is not re-granted to its own holder; ambiguous outcomes hold the lease; huge revision jumps are rejected', () =>
  withDb((db) => {
    let clock = 1_900_000_000_000
    const leases = createRefreshLeases({ db, repo: setup(db), now: () => clock })
    const acquire = (instanceId) =>
      leases.acquire({ instanceId, runtimeAccountId: 'rt_1', grant: 'native', credentialRevision: 3 })
    const first = acquire('gw-1')
    assert.equal(first.granted, true)
    assert.equal(acquire('gw-1').reason, 'lease_held', 'the holder cannot overwrite its own live lease')
    const ambiguous = leases.release({
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
    assert.equal(acquire('gw-2').reason, 'outcome_unknown', 'still held after the normal TTL')
    clock += AMBIGUOUS_HOLD_MS
    const next = acquire('gw-2')
    assert.equal(next.granted, true)
    assert.deepEqual(
      leases.release({
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
