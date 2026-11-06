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
import { createGatewayWorkerRoutes } from '../../src/lib/gateway-worker/gateway-routes.mjs'
import { createCredentialCustody } from '../../src/lib/executor/credential-custody.mjs'
import { createCredentialVault, loadKeyring } from '../../src/lib/executor/vault.mjs'

const ID = 'gw-01'
const RUNTIME = 'gwacct_gw-01'

/** 一个已被两个实例加载的平台 Codex 账号，凭据库、刷新租约、分组与 OAuth 会话齐全。 */
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
      bps_grant: { revision: 1 },
    }),
    maybeEncrypt(JSON.stringify({ proxy_url: 'socks5h://user:proxy-secret@proxy.example.test:1080' })),
    at,
    at,
  )
  const groups = new GroupsRepo(db)
  await groups.assignResource('gateway_worker_account', ID, [groupId], 0, 'operator')
  // 每个账号一行（迁移 128）：绑定指向当前承接它的 gw-one
  await repo.recordAccountBinding({
    accountResourceId: ID,
    instanceId: 'gw-one',
    runtimeAccountId: RUNTIME,
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
  // Worker 替身：删除不再调用 Worker（Worker 读到墓碑后自己删除），任何调用都记下来
  const calls = []
  const client = new Proxy(
    {},
    {
      get:
        (_target, name) =>
        async (...args) => {
          calls.push([name, ...args])
          return { ok: true, status: 200, data: {} }
        },
    },
  )
  const custody = createCredentialCustody({ db, vault })
  const manager = new GatewayAccountManagement({ repo, service: { client, custody } })
  return { db, repo, manager, calls, groupId, vault }
}

const row = (db) => db.prepare('SELECT * FROM vendor_resources WHERE id=?').get(ID)
const count = (db, sql) => db.prepare(sql).get(ID).n

test('permanent delete drops credentials and leaves a tombstone without calling any Worker', async (t) => {
  const f = await fixture(t)
  const result = await f.manager.remove('operator', ID)
  assert.deepEqual(result, { deleted: ID })
  assert.deepEqual(f.calls, [])
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
  assert.equal(config.group_ids, undefined, 'groups live only in group_resources')
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
  // 墓碑不出现在任何列表与查找中（含「显示归档」）
  assert.deepEqual(await f.repo.listCodexAccounts({ includeArchived: true }), [])
  await assert.rejects(f.manager.account(ID), { code: 'account_not_found' })
  await assert.rejects(f.manager.remove('operator', ID), { code: 'account_not_found' })
  await assert.rejects(f.manager.update('operator', ID, { name: 'back' }), { code: 'account_not_found' })
  assert.deepEqual(await f.repo.listGatewayAccountRows(), [])
})

test("the heartbeat drops a tombstone's bindings once the Worker caught up with the facts", async (t) => {
  const f = await fixture(t)
  await f.manager.remove('operator', ID)
  const bindings = () =>
    count(f.db, 'SELECT COUNT(*) AS n FROM gateway_worker_account_bindings WHERE account_resource_id=?')
  // 绑定留到承接它的实例心跳确认读到墓碑为止；没有承接它的实例不动它
  assert.equal(bindings(), 1)
  const seq = f.db.prepare('SELECT value FROM gateway_fact_seq').get().value
  f.db.prepare("UPDATE gateway_worker_instances SET drain_state='draining' WHERE id='gw-two'").run()
  await f.repo.markFactsSynced('gw-two', { status: { seq } })
  assert.equal(bindings(), 1)
  await f.repo.markFactsSynced('gw-one', { status: { seq } })
  assert.equal(bindings(), 0)
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
