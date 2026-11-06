import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase, openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { maybeEncrypt } from '../../src/lib/db/secure.mjs'
import { GroupsRepo } from '../../src/lib/db/repos/groups-repo.mjs'
import { GatewayWorkerRepo } from '../../src/lib/gateway-worker/gateway-repo.mjs'
import { GatewayAccountManagement } from '../../src/lib/gateway-worker/account-management.mjs'
import { GatewayWorkerService } from '../../src/lib/gateway-worker/gateway-execution.mjs'
import { createGatewayWorkerRoutes } from '../../src/lib/gateway-worker/gateway-routes.mjs'
import { createCredentialCustody } from '../../src/lib/executor/credential-custody.mjs'
import { createCredentialVault, loadKeyring } from '../../src/lib/executor/vault.mjs'

const ID = 'gw-01'
const RUNTIME = 'gwacct_gw-01'

/** 一个已投影到两个实例的平台 Codex 账号，凭据库、刷新租约、分组与 OAuth 会话齐全。 */
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-delete-'))
  const db = createDatabase({ dataDir: dir })
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  db.prepare(
    "INSERT INTO groups(name,platform,status,models_json,created_at,updated_at) VALUES('Codex A','openai','active','[]',datetime('now'),datetime('now'))",
  ).run()
  const groupId = db.prepare("SELECT id FROM groups WHERE name='Codex A'").get().id
  const repo = new GatewayWorkerRepo(db)
  for (const id of ['gw-one', 'gw-two'])
    await repo.upsertInstance({
      id,
      base_url: 'http://127.0.0.1:8790',
      health_state: 'healthy',
      drain_state: 'accepting',
      boot_id: `boot-${id}`,
      protocol_version: 1,
    })
  const at = new Date().toISOString()
  db.prepare(
    "INSERT INTO vendor_resources(id,vendor_id,resource_type,name,external_id,status,config_json,secret_json,created_by,created_at,updated_at) VALUES(?,NULL,'account','Delete me','platform-gateway:key','active',?,?,'operator',?,?)",
  ).run(
    ID,
    JSON.stringify({
      platform: 'openai',
      execution_kind: 'gateway_worker',
      group_ids: [groupId],
      proxy_endpoint: 'socks5h://proxy.example.test:1080',
      runtime_account_id: RUNTIME,
      projection_revision: 3,
      bps_grant: { revision: 1 },
    }),
    maybeEncrypt(JSON.stringify({ proxy_url: 'socks5h://user:proxy-secret@proxy.example.test:1080' })),
    at,
    at,
  )
  const groups = new GroupsRepo(db)
  await groups.assignResource('gateway_worker_account', ID, [groupId], 0, 'operator')
  for (const instanceId of ['gw-one', 'gw-two'])
    await repo.recordProjection({
      accountResourceId: ID,
      instanceId,
      runtimeAccountId: RUNTIME,
      projectionRevision: 3,
      credentialRevision: 2,
      status: 'synced',
    })
  const vault = createCredentialVault({ db, keyring: loadKeyring({ file: path.join(dir, 'keys.json') }) })
  await vault.put({
    accountResourceId: ID,
    grant: 'native',
    revision: 2,
    secrets: { access_token: 'at', refresh_token: 'rt' },
  })
  await vault.put({
    accountResourceId: ID,
    grant: 'bps',
    revision: 2,
    secrets: { access_token: 'bat', refresh_token: 'brt' },
  })
  for (const grant of ['native', 'bps'])
    db.prepare(
      "INSERT INTO credential_refresh_leases(account_resource_id,grant_kind,holder_instance_id,runtime_account_id,lease_token,credential_revision,state,expires_at,acquired_at,updated_at) VALUES(?,?,'gw-one',?,'lease',2,'released',?,?,?)",
    ).run(ID, grant, RUNTIME, at, at, at)
  db.prepare(
    "INSERT INTO gateway_worker_oauth_sessions(session_id,account_resource_id,actor_user_id,gateway_instance_id,state_hash,status,idempotency_key,expires_at,created_at,updated_at,session_json) VALUES('sess-1',?,'operator','gw-one','hash','pending','idem',?,?,?,'pkce-verifier')",
  ).run(ID, at, at, at)
  // Worker 替身：按实例给出删除结果；未设置的实例删除成功
  const outcomes = new Map()
  const calls = []
  const client = {
    async deleteAccount(instanceId, runtimeId) {
      calls.push(['delete', instanceId, runtimeId])
      const outcome = outcomes.get(instanceId)
      if (outcome === 'throw') throw new Error('connect ECONNREFUSED')
      return outcome || { ok: true, status: 200, data: { ok: true, deleted: runtimeId } }
    },
    async patchAccount(instanceId, runtimeId, patch) {
      calls.push(['patch', instanceId, runtimeId, patch])
      return { ok: true, status: 200, data: { account: {} } }
    },
  }
  const custody = createCredentialCustody({ db, vault })
  const manager = new GatewayAccountManagement({ repo, service: { client, custody } })
  return { db, repo, manager, client, outcomes, calls, groupId, vault }
}

const row = (db) => db.prepare('SELECT * FROM vendor_resources WHERE id=?').get(ID)
const count = (db, sql) => db.prepare(sql).get(ID).n

test('permanent delete removes the account from every Worker, drops credentials and leaves a tombstone', async (t) => {
  const f = await fixture(t)
  const result = await f.manager.remove('operator', ID)
  assert.deepEqual(result, { deleted: ID, projection_pending: false, pending_instances: [] })
  assert.deepEqual(
    // 绑定按 updated_at 排序，同一毫秒写入时顺序不定
    f.calls.map((c) => c.slice(0, 3)).sort((a, b) => a[1].localeCompare(b[1])),
    [
      ['delete', 'gw-one', RUNTIME],
      ['delete', 'gw-two', RUNTIME],
    ],
  )
  const tomb = row(f.db)
  assert.ok(tomb.deleted_at)
  assert.equal(tomb.status, 'archived')
  assert.ok(tomb.archived_at)
  assert.equal(tomb.secret_json, null)
  assert.equal(tomb.external_id, null)
  assert.equal(tomb.name, 'Delete me', 'history keeps resolving the name')
  const config = JSON.parse(tomb.config_json)
  assert.equal(config.proxy_endpoint, undefined)
  assert.equal(config.bps_grant, undefined)
  assert.equal(config.runtime_account_id, RUNTIME)
  assert.equal(config.projection_revision, 4)
  assert.equal(count(f.db, 'SELECT COUNT(*) AS n FROM gateway_worker_account_bindings WHERE account_resource_id=?'), 0)
  assert.equal(count(f.db, 'SELECT COUNT(*) AS n FROM executor_credentials WHERE account_resource_id=?'), 0)
  assert.equal(count(f.db, 'SELECT COUNT(*) AS n FROM credential_refresh_leases WHERE account_resource_id=?'), 0)
  assert.equal(
    count(
      f.db,
      "SELECT COUNT(*) AS n FROM group_resources WHERE resource_kind='gateway_worker_account' AND resource_id=?",
    ),
    0,
  )
  const session = f.db
    .prepare("SELECT status,session_json FROM gateway_worker_oauth_sessions WHERE session_id='sess-1'")
    .get()
  assert.deepEqual({ ...session }, { status: 'cancelled', session_json: null })
  assert.equal(
    count(f.db, "SELECT COUNT(*) AS n FROM operation_audit WHERE action='gateway.account.deleted' AND target=?"),
    1,
  )
  // 墓碑不出现在任何列表与查找中（含「显示归档」）；投影列表也不再带它
  assert.deepEqual(await f.repo.listCodexAccounts({ includeArchived: true }), [])
  await assert.rejects(f.manager.account(ID), { code: 'account_not_found' })
  await assert.rejects(f.manager.remove('operator', ID), { code: 'account_not_found' })
  await assert.rejects(f.manager.update('operator', ID, { name: 'back' }), { code: 'account_not_found' })
  assert.deepEqual(await f.repo.listProjectableAccounts(), [])
})

test('an unreachable Worker keeps a pending delete that heartbeat reconciliation finishes', async (t) => {
  const f = await fixture(t)
  f.outcomes.set('gw-two', 'throw')
  const result = await f.manager.remove('operator', ID)
  assert.equal(result.projection_pending, true)
  assert.deepEqual(result.pending_instances, ['gw-two'])
  // 凭据与墓碑照常完成；只留下不可达实例上的绑定，按 drifted 排除，不再接单
  assert.ok(row(f.db).deleted_at)
  assert.equal(count(f.db, 'SELECT COUNT(*) AS n FROM executor_credentials WHERE account_resource_id=?'), 0)
  const pending = await f.repo.getAccountBinding(ID, 'gw-two')
  assert.equal(pending.projection_status, 'drifted')
  assert.equal(pending.projection_error, 'pending_delete')
  assert.equal(await f.repo.getAccountBinding(ID, 'gw-one'), null)
  assert.deepEqual(await f.repo.unsyncedRuntimeAccounts('gw-two'), [RUNTIME])
  assert.deepEqual(
    (await f.repo.listProjectableAccounts()).map((a) => [a.id, !!a.deleted_at]),
    [[ID, true]],
  )
  assert.deepEqual(await f.repo.listCodexAccounts({ includeArchived: true }), [])
  // 心跳：仍不可达时保持待删除；实例回来后删除并去掉绑定，之后不再出现在投影列表
  const service = new GatewayWorkerService({ repo: f.repo })
  service.client = f.client
  assert.equal((await service.projectAllAccountsTo('gw-one')).ok, true)
  assert.equal((await service.projectAllAccountsTo('gw-two')).ok, false)
  assert.equal((await f.repo.getAccountBinding(ID, 'gw-two')).projection_error, 'pending_delete')
  f.outcomes.delete('gw-two')
  f.calls.length = 0
  assert.equal((await service.projectAllAccountsTo('gw-two')).ok, true)
  assert.deepEqual(
    f.calls.map((c) => c.slice(0, 2)),
    [['delete', 'gw-two']],
  )
  assert.equal(await f.repo.getAccountBinding(ID, 'gw-two'), null)
  assert.deepEqual(await f.repo.listProjectableAccounts(), [])
})

test('heartbeat drops a pending delete without calling the Worker when it no longer reports the account', async (t) => {
  const f = await fixture(t)
  f.outcomes.set('gw-two', { ok: false, status: 503, data: { error: { code: 'unavailable' } } })
  await f.manager.remove('operator', ID)
  const service = new GatewayWorkerService({ repo: f.repo })
  service.client = f.client
  f.calls.length = 0
  assert.equal((await service.projectAllAccountsTo('gw-two', { revisions: [] })).ok, true)
  assert.deepEqual(f.calls, [])
  assert.equal(await f.repo.getAccountBinding(ID, 'gw-two'), null)
})

test('a 404 only counts as deleted when the Worker says account_not_found; an old Worker is disabled and stays pending', async (t) => {
  const f = await fixture(t)
  f.outcomes.set('gw-one', { ok: false, status: 404, data: { error: { code: 'account_not_found' } } })
  f.outcomes.set('gw-two', { ok: false, status: 405, data: { error: { code: 'method_not_allowed' } } })
  const result = await f.manager.remove('operator', ID)
  assert.deepEqual(result.pending_instances, ['gw-two'])
  assert.equal(await f.repo.getAccountBinding(ID, 'gw-one'), null)
  const patch = f.calls.find((c) => c[0] === 'patch')
  assert.equal(patch[1], 'gw-two')
  assert.deepEqual(
    { groups: patch[3].groups, enabled: patch[3].enabled, paused: patch[3].paused, proxy_url: patch[3].proxy_url },
    { groups: [], enabled: false, paused: true, proxy_url: '' },
  )
  assert.equal((await f.repo.getAccountBinding(ID, 'gw-two')).projection_error, 'pending_delete')
})

test('a deleted account can be imported again: the external id is released and its number is not reused', async (t) => {
  const f = await fixture(t)
  await f.manager.remove('operator', ID)
  assert.equal(
    f.db.prepare("SELECT COUNT(*) AS n FROM vendor_resources WHERE external_id='platform-gateway:key'").get().n,
    0,
  )
  const { nextGatewayAccountId } = await import('../../src/lib/gateway-worker/account-ids.mjs')
  assert.equal(await nextGatewayAccountId(f.db), 'gw-02')
})

test('DELETE /api/panel/codex-accounts/:id needs resource manage before touching the account', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-delete-rbac-'))
  openDatabase({ dataDir: dir })
  try {
    let reply
    const handler = createGatewayWorkerRoutes({
      json: (_res, status, body) => {
        reply = { status, body }
      },
      readBody: async () => ({}),
    })
    for (const [panelRole, permissions] of [
      ['admin', ['resources.edit']],
      ['user', []],
      ['vendor', []],
    ]) {
      reply = null
      await handler(
        { method: 'DELETE', panelRole, panelResourcePermissions: permissions },
        {},
        { pathname: `/api/panel/codex-accounts/${ID}` },
      )
      assert.equal(reply.status, 403, panelRole)
    }
    reply = null
    await handler({ method: 'DELETE', panelRole: 'super_admin' }, {}, { pathname: `/api/panel/codex-accounts/${ID}` })
    assert.deepEqual([reply.status, reply.body.error.code], [404, 'account_not_found'])
  } finally {
    closeDatabase()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
