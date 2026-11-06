import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { createCredentialVault, loadKeyring } from '../../src/lib/executor/vault.mjs'
import { gatewayFactsPreflight } from '../../scripts/gateway-facts-preflight.mjs'

// Gateway 事实直读 G2（设计第 19 节）：迁移 124 的触发器、读取契约视图与上线前检查

function withDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-facts-'))
  const db = createDatabase({ dataDir: dir })
  db.exec('PRAGMA foreign_keys=OFF')
  return Promise.resolve(fn(db, dir)).finally(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
}

const config = (extra = {}) =>
  JSON.stringify({
    platform: 'openai',
    execution_kind: 'gateway_worker',
    max_concurrency: 3,
    weight: 2,
    model_access: { mode: 'allowlist', models: ['gpt-5'] },
    proxy_id: 'px-1',
    group_ids: [7],
    runtime_account_id: 'gwacct_gw-01',
    ...extra,
  })

function seed(db) {
  db.prepare(
    "INSERT INTO proxies(id,host,port,max_websocket_connections,request_location_mode,location_country,location_timezone) VALUES('px-1','127.0.0.1',1080,4,'manual','US','America/New_York')",
  ).run()
  db.prepare(
    "INSERT INTO vendor_resources(id,vendor_id,resource_type,name,status,config_json,secret_json,created_by,created_at,updated_at) VALUES('gw-01',NULL,'account','A','active',?,?, 't','x','x')",
  ).run(config(), JSON.stringify({ proxy_url: 'socks5h://127.0.0.1:1080' }))
  db.prepare(
    "INSERT INTO group_resources(group_id,resource_kind,resource_id,priority) VALUES(7,'gateway_worker_account','gw-01',50)",
  ).run()
}

const revision = (db, id = 'gw-01') =>
  db.prepare('SELECT revision FROM gateway_account_fact_revisions WHERE account_resource_id=?').get(id)?.revision ?? 0

test('fact revisions advance only for writes the Worker reads', () =>
  withDb(async (db, dir) => {
    seed(db)
    let last = revision(db)
    assert.ok(last > 0, 'insert and group membership advance the revision')
    const bumped = (label, write) => {
      write()
      const next = revision(db)
      assert.ok(next > last, `${label} advances the revision`)
      last = next
    }
    const unchanged = (label, write) => {
      write()
      assert.equal(revision(db), last, `${label} leaves the revision`)
    }
    const setConfig = (key, value) =>
      db
        .prepare("UPDATE vendor_resources SET config_json=json_set(config_json,?,json(?)) WHERE id='gw-01'")
        .run(`$.${key}`, JSON.stringify(value))
    bumped('max_concurrency', () => setConfig('max_concurrency', 5))
    bumped('model access', () => setConfig('model_access', { mode: 'all', models: [] }))
    bumped('bps settings', () => setConfig('bps', { enabled: true, models: ['gpt-5'] }))
    bumped('installation id', () => setConfig('installation_id', '6f1c0e1e-5b7a-4a51-9d0e-6f6f1b3c2a10'))
    bumped('status', () => db.prepare("UPDATE vendor_resources SET status='paused' WHERE id='gw-01'").run())
    bumped('proxy secret', () => db.prepare("UPDATE vendor_resources SET secret_json='{}' WHERE id='gw-01'").run())
    unchanged('subscription', () => setConfig('subscription', { expires_at: '2027-01-01' }))
    unchanged('notes', () => setConfig('notes', 'hello'))
    unchanged('updated_at', () => db.prepare("UPDATE vendor_resources SET updated_at='y' WHERE id='gw-01'").run())
    bumped('group removed', () =>
      db
        .prepare("DELETE FROM group_resources WHERE resource_kind='gateway_worker_account' AND resource_id='gw-01'")
        .run(),
    )
    bumped('group added', () =>
      db
        .prepare(
          "INSERT INTO group_resources(group_id,resource_kind,resource_id) VALUES(9,'gateway_worker_account','gw-01')",
        )
        .run(),
    )
    unchanged('vm membership', () =>
      db.prepare("INSERT INTO group_resources(group_id,resource_kind,resource_id) VALUES(9,'vm','vm-1')").run(),
    )
    bumped('proxy ws limit', () => db.prepare("UPDATE proxies SET max_websocket_connections=8 WHERE id='px-1'").run())
    unchanged('proxy probe', () =>
      db.prepare("UPDATE proxies SET latency_ms=42,last_probe_at='z',status='ok' WHERE id='px-1'").run(),
    )
    const vault = createCredentialVault({ db, keyring: loadKeyring({ file: path.join(dir, 'keys.json') }) })
    await vault.put({
      accountResourceId: 'gw-01',
      grant: 'native',
      revision: 1,
      secrets: { refresh_token: 'rt' },
      source: 't',
    })
    assert.ok(revision(db) > last, 'storing a credential advances the revision')
    last = revision(db)
    await vault.put({
      accountResourceId: 'gw-01',
      grant: 'native',
      revision: 2,
      expectedRevision: 1,
      secrets: { refresh_token: 'rt2' },
      source: 't',
    })
    assert.ok(revision(db) > last, 'credential rotation advances the revision')
    last = revision(db)
    bumped('tombstone', () =>
      db.prepare("UPDATE vendor_resources SET deleted_at='t',status='archived' WHERE id='gw-01'").run(),
    )
    // 非 Gateway 账号的写入不推进
    db.prepare(
      "INSERT INTO vendor_resources(id,vendor_id,resource_type,name,status,config_json,created_by,created_at,updated_at) VALUES('vm-acct','v','account','B','active','{\"execution_kind\":\"vm\"}','t','x','x')",
    ).run()
    assert.equal(revision(db, 'vm-acct'), 0)
  }))

test('the facts view exposes one row per Gateway account with credentials, proxy and groups', () =>
  withDb(async (db, dir) => {
    seed(db)
    const vault = createCredentialVault({ db, keyring: loadKeyring({ file: path.join(dir, 'keys.json') }) })
    await vault.put({
      accountResourceId: 'gw-01',
      grant: 'native',
      revision: 3,
      secrets: { refresh_token: 'rt' },
      source: 't',
    })
    const row = db.prepare("SELECT * FROM gateway_account_facts_v1 WHERE account_resource_id='gw-01'").get()
    assert.equal(row.runtime_account_id, 'gwacct_gw-01')
    assert.equal(row.max_concurrency, 3)
    assert.equal(row.weight, 2)
    assert.deepEqual(JSON.parse(row.model_access_json), { mode: 'allowlist', models: ['gpt-5'] })
    assert.equal(row.native_revision, 3)
    assert.ok(row.native_ciphertext && !String(row.native_ciphertext).includes('rt'))
    assert.equal(row.bps_revision, null)
    assert.equal(row.proxy_max_websocket_connections, 4)
    assert.equal(row.proxy_request_location_mode, 'manual')
    assert.deepEqual(JSON.parse(row.group_ids_json), [7])
    assert.equal(row.fact_revision, revision(db))
    assert.equal(db.prepare('SELECT version FROM gateway_fact_contract').get().version, 1)
  }))

test('preflight reports missing facts and aligns config.group_ids with group membership on apply', () =>
  withDb(async (db, dir) => {
    seed(db)
    db.prepare(
      "INSERT INTO group_resources(group_id,resource_kind,resource_id) VALUES(8,'gateway_worker_account','gw-01')",
    ).run()
    db.prepare(
      "INSERT INTO gateway_worker_account_bindings(account_resource_id,gateway_instance_id,runtime_account_id,credential_revision,projection_status,created_at,updated_at) VALUES('gw-01','gw-1','gwacct_gw-01',4,'synced','x','x')",
    ).run()
    const env = { KIN_CREDENTIAL_MASTER_KEY_FILE: path.join(dir, 'keys.json') }
    const credentials = async () => ({ summary: {} })
    const dry = await gatewayFactsPreflight({ db, env, credentials, log: { warn() {} } })
    const [item] = dry.items
    assert.deepEqual(item.issues.sort(), ['group_ids_differ', 'installation_id_missing', 'native_credential_missing'])
    assert.deepEqual(item.groups, { config: [7], members: [7, 8] })
    // 凭据库落后于绑定记录的代次
    const vault = createCredentialVault({ db, keyring: loadKeyring({ file: env.KIN_CREDENTIAL_MASTER_KEY_FILE }) })
    await vault.put({
      accountResourceId: 'gw-01',
      grant: 'native',
      revision: 3,
      secrets: { refresh_token: 'rt' },
      source: 't',
    })
    db.prepare(
      "UPDATE vendor_resources SET config_json=json_set(config_json,'$.installation_id','6f1c0e1e-5b7a-4a51-9d0e-6f6f1b3c2a10') WHERE id='gw-01'",
    ).run()
    const applied = await gatewayFactsPreflight({ db, env, credentials, apply: true, log: { warn() {} } })
    assert.deepEqual(applied.items[0].issues, ['native_credential_behind'])
    assert.equal(applied.items[0].groups.fixed, true)
    assert.deepEqual(
      JSON.parse(db.prepare("SELECT config_json FROM vendor_resources WHERE id='gw-01'").get().config_json).group_ids,
      [7, 8],
    )
    assert.equal(applied.summary.group_ids_fixed, 1)
    assert.ok(db.prepare("SELECT 1 FROM operation_audit WHERE action='gateway.facts.preflight'").get())
  }))

// 跨语言夹具（Worker facts_test.go 共用）：Node 侧也要能解开，夹具才可信
test('the shared facts fixture decrypts with the control-plane vault and field cipher', async () => {
  const { decryptString } = await import('../../src/lib/db/secure.mjs')
  const fixture = JSON.parse(
    fs.readFileSync(new URL('../fixtures/executor-contract/facts.json', import.meta.url), 'utf8'),
  )
  assert.deepEqual(JSON.parse(decryptString(fixture.secret_json, fixture.db_secret)), fixture.secret_plain)
  await withDb(async (db, dir) => {
    const file = path.join(dir, 'keys.json')
    fs.writeFileSync(file, JSON.stringify(fixture.keyring), { mode: 0o600 })
    const vault = createCredentialVault({ db, keyring: loadKeyring({ file }) })
    for (const record of fixture.credentials)
      db.prepare(
        "INSERT INTO executor_credentials(account_resource_id,grant_kind,revision,master_key_id,wrapped_key,ciphertext,token_fingerprint,source,updated_at) VALUES(?,?,?,?,?,?,?,'fixture','x')",
      ).run(
        record.account_resource_id,
        record.grant_kind,
        record.revision,
        record.master_key_id,
        record.wrapped_key,
        record.ciphertext,
        record.token_fingerprint,
      )
    for (const grant of ['native', 'bps'])
      assert.deepEqual((await vault.get('gw-01', grant)).secrets, fixture.plain[grant])
  })
})

test('heartbeat facts are stored trimmed and the supervised Worker gets the database and key paths', async () => {
  const { GatewayWorkerRepo } = await import('../../src/lib/gateway-worker/gateway-repo.mjs')
  const { supervisedWorkerEnv } = await import('../../src/lib/gateway-worker/worker-supervisor.mjs')
  await withDb(async (db, dir) => {
    const repo = new GatewayWorkerRepo(db)
    await repo.upsertInstance({ id: 'gw-1', base_url: 'http://127.0.0.1:1', health_state: 'healthy' })
    await repo.recordFacts('gw-1', {
      mode: 'primary',
      status: { contract: 1, seq: 9, accounts: 2, with_errors: 1, secret: 'x' },
      fact_errors: [{ account: 'gw-01', fields: ['native_master_key_missing'], extra: 'dropped' }],
    })
    const [instance] = await repo.listInstances()
    assert.equal(instance.facts.seq, 9)
    assert.equal(instance.facts.secret, undefined)
    assert.equal(instance.facts.mode, 'primary')
    assert.deepEqual(instance.facts.fact_errors, [{ account: 'gw-01', fields: ['native_master_key_missing'] }])
    await repo.recordFacts('gw-1', null)
    assert.equal((await repo.listInstances())[0].facts, null)
    const env = supervisedWorkerEnv({ env: {}, root: dir, dataDir: dir })
    assert.equal(env.KIN_CODEX_GATEWAY_FACTS_DB, path.join(dir, 'kin.db'))
    assert.equal(env.KIN_CREDENTIAL_MASTER_KEY_FILE, path.join(dir, 'credential-master-keys.json'))
    // 显式配置的主密钥文件位置优先（与控制面一致）
    assert.equal(
      supervisedWorkerEnv({ env: { KIN_CREDENTIAL_MASTER_KEY_FILE: '/keys/k.json' }, root: dir, dataDir: dir })
        .KIN_CREDENTIAL_MASTER_KEY_FILE,
      '/keys/k.json',
    )
  })
})
