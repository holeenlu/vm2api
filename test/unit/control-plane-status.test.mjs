import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase, openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import {
  controlPlaneStatus,
  controlPlaneSwitches,
  logControlPlaneSwitches,
} from '../../src/lib/executor/control-plane-status.mjs'
import { createRefreshLeases, refreshLeaseDenials } from '../../src/lib/executor/refresh-lease.mjs'
import { GatewayWorkerRepo } from '../../src/lib/gateway-worker/gateway-repo.mjs'
import { createGatewayWorkerRoutes } from '../../src/lib/gateway-worker/gateway-routes.mjs'

// 最终审计 U8：开关生效值与拼错的值、Redis 地址不外露
test('switches report effective values, flag invalid ones and never expose the Redis URL', () => {
  const switches = controlPlaneSwitches({
    KIN_EXECUTOR_EVENTS: 'Primary',
    KIN_REFRESH_LEASE: 'yes',
    KIN_CREDENTIAL_CUSTODY: 'controll',
    KIN_REDIS_URL: 'redis://:secret@127.0.0.1:6379/0',
  })
  const by = Object.fromEntries(switches.map((item) => [item.name, item]))
  assert.deepEqual([by.KIN_EXECUTOR_EVENTS.value, by.KIN_EXECUTOR_EVENTS.valid], ['primary', true])
  assert.deepEqual(
    [by.KIN_REFRESH_LEASE.value, by.KIN_REFRESH_LEASE.valid, by.KIN_REFRESH_LEASE.given],
    ['off', false, 'yes'],
  )
  assert.deepEqual([by.KIN_CREDENTIAL_CUSTODY.value, by.KIN_CREDENTIAL_CUSTODY.valid], ['worker', false])
  assert.equal(by.KIN_REDIS_URL.value, 'configured')
  assert.equal(by.KIN_REDIS_URL.scope, 'control_plane_env')
  // 疑似地址或密码的原值只保留前 4 个字符（复核 O7）
  const leaked = controlPlaneSwitches({ KIN_CREDENTIAL_CUSTODY: 'redis://:hunter2@host' })[2]
  assert.equal(leaked.given, 'redi…(21)')
  assert.equal(JSON.stringify(switches).includes('secret'), false)
  const defaults = controlPlaneSwitches({})
  assert.ok(defaults.every((item) => item.valid))
  assert.deepEqual(
    defaults.map((item) => item.value),
    ['off', 'off', 'worker', 'unset'],
  )
})

test('effective switches are logged once at startup and invalid values are warned about', () => {
  const lines = { info: [], warn: [] }
  const log = { info: (m) => lines.info.push(m), warn: (m) => lines.warn.push(m) }
  logControlPlaneSwitches({ env: { KIN_EXECUTOR_EVENTS: 'primry' }, log, once: false })
  logControlPlaneSwitches({ env: { KIN_EXECUTOR_EVENTS: 'primry' }, log })
  assert.equal(lines.info.length, 1)
  assert.match(lines.info[0], /KIN_EXECUTOR_EVENTS=off/)
  assert.equal(lines.warn.length, 1)
  assert.match(lines.warn[0], /"primry" is not one of off\/shadow\/primary; running as off/)
})

test('status summarises the event inbox, refresh leases and lease conflicts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'control-plane-status-'))
  const db = createDatabase({ dataDir: dir })
  try {
    db.exec('PRAGMA foreign_keys=OFF')
    db.exec(`INSERT INTO gateway_worker_account_bindings(account_resource_id,gateway_instance_id,runtime_account_id,credential_revision,projection_status,created_at,updated_at)
             VALUES('acct_1','gw-1','rt_1',3,'synced','x','x'),('acct_1','gw-2','rt_1',3,'synced','x','x')`)
    const now = new Date().toISOString()
    const insert = db.prepare(
      "INSERT INTO executor_event_inbox(event_id,instance_id,stream_id,seq,type,occurred_at,mode,status,payload_json,received_at,checked_at) VALUES(?,?,?,?,'request.finalized',?,'shadow',?,'{}',?,?)",
    )
    insert.run('evt_s_1', 'gw-1', 's', 1, now, 'matched', now, now)
    insert.run('evt_s_2', 'gw-1', 's', 2, now, 'diff', now, now)
    insert.run('evt_s_3', 'gw-1', 's', 3, now, 'pending', now, now)
    const repo = new GatewayWorkerRepo(db)
    const leases = createRefreshLeases({
      db,
      repo: { findAccountByRuntime: () => ({ account_resource_id: 'acct_1', credential_revision: 3 }) },
    })
    const before = refreshLeaseDenials().counts.lease_held || 0
    assert.equal(
      (await leases.acquire({ instanceId: 'gw-1', runtimeAccountId: 'rt_1', grant: 'native', credentialRevision: 3 }))
        .granted,
      true,
    )
    const denied = await leases.acquire({
      instanceId: 'gw-2',
      runtimeAccountId: 'rt_1',
      grant: 'native',
      credentialRevision: 3,
    })
    assert.equal(denied.reason, 'lease_held')
    // 申请时找不到绑定（没有 reason）不计入冲突；代次落后与结果不明期间计入并带账号（复核 O8）
    const unknownBefore = refreshLeaseDenials().counts.outcome_unknown || 0
    const lookupFailing = createRefreshLeases({ db, repo: { findAccountByRuntime: () => null } })
    assert.equal(
      (await lookupFailing.acquire({ instanceId: 'gw-1', runtimeAccountId: 'x', grant: 'native' })).granted,
      false,
    )
    const stale = await leases.acquire({
      instanceId: 'gw-2',
      runtimeAccountId: 'rt_1',
      grant: 'native',
      credentialRevision: 1,
    })
    assert.equal(stale.reason, 'stale_revision')
    const status = await controlPlaneStatus({ db, repo, env: {}, cache: false })
    assert.deepEqual(
      [status.events.by_status.matched, status.events.by_status.diff, status.events.by_status.pending],
      [1, 1, 1],
    )
    assert.equal(status.refresh_leases.by_state.held, 1)
    assert.equal(status.refresh_leases.denials.counts.lease_held, before + 1)
    assert.equal(Object.values(status.refresh_leases.denials.counts).includes(undefined), false)
    const [latest, held] = status.refresh_leases.denials.recent
    assert.deepEqual(
      [latest.reason, latest.account_resource_id, latest.instance_id],
      ['stale_revision', 'acct_1', 'gw-2'],
    )
    assert.deepEqual([held.reason, held.holder], ['lease_held', 'gw-1'])
    // 结果不明的租约单独列出；结果不明期间的申请计入冲突
    db.prepare("UPDATE credential_refresh_leases SET state='ambiguous'").run()
    const ambiguous = await controlPlaneStatus({ db, repo, env: {}, cache: false })
    assert.equal(ambiguous.refresh_leases.ambiguous[0].account_resource_id, 'acct_1')
    assert.equal(
      (await leases.acquire({ instanceId: 'gw-2', runtimeAccountId: 'rt_1', grant: 'native', credentialRevision: 3 }))
        .reason,
      'outcome_unknown',
    )
    assert.equal(refreshLeaseDenials().counts.outcome_unknown, unknownBefore + 1)
    // 到期的租约不再算持有中或结果不明，单独计为 expired（复核 O3）
    db.prepare("UPDATE credential_refresh_leases SET expires_at='2000-01-01T00:00:00.000Z'").run()
    const expired = await controlPlaneStatus({ db, repo, env: {}, cache: false })
    assert.deepEqual(expired.refresh_leases.by_state, { expired: 1 })
    assert.deepEqual(expired.refresh_leases.ambiguous, [])
    // 汇总缓存 60 秒（复核 O1）：缓存期内不再查库，开关仍实时
    const t0 = Date.now()
    const first = await controlPlaneStatus({ db, repo, env: {}, now: t0 })
    db.prepare("UPDATE credential_refresh_leases SET expires_at='2999-01-01T00:00:00.000Z'").run()
    const cachedStatus = await controlPlaneStatus({ db, repo, env: { KIN_REFRESH_LEASE: 'on' }, now: t0 + 30_000 })
    assert.deepEqual(cachedStatus.refresh_leases.by_state, first.refresh_leases.by_state)
    assert.equal(cachedStatus.switches.find((item) => item.name === 'KIN_REFRESH_LEASE').value, 'on')
    const refreshed = await controlPlaneStatus({ db, repo, env: {}, now: t0 + 70_000 })
    assert.notDeepEqual(refreshed.refresh_leases.by_state, first.refresh_leases.by_state)
    // 一部分读取失败不影响其他部分
    db.exec('ALTER TABLE executor_event_inbox RENAME TO inbox_hidden')
    const partial = await controlPlaneStatus({ db, repo, env: {}, cache: false })
    assert.equal(partial.events, null)
    assert.ok(partial.refresh_leases)
    assert.equal(partial.switches.length, 4)
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the Gateway Worker list carries the control-plane status for super admins', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'control-plane-route-'))
  openDatabase({ dataDir: dir })
  try {
    let reply
    const handler = createGatewayWorkerRoutes({
      json: (_res, status, body) => {
        reply = { status, body }
      },
      readBody: async () => ({}),
    })
    await handler({ method: 'GET', panelRole: 'super_admin' }, {}, { pathname: '/api/panel/gateway-workers' })
    assert.equal(reply.status, 200)
    assert.equal(reply.body.control_plane.switches.length, 4)
    assert.ok(reply.body.control_plane.events)
    assert.ok(reply.body.control_plane.refresh_leases)
    await handler({ method: 'GET', panelRole: 'admin' }, {}, { pathname: '/api/panel/gateway-workers' })
    assert.equal(reply.status, 403)
  } finally {
    closeDatabase()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
