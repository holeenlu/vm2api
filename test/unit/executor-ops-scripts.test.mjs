import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { loadRuntimeSecretsReadOnly } from '../../src/lib/core/runtime-secrets.mjs'
import { openScriptDatabase, pendingMigrations } from '../../src/lib/executor/repos/script-db-repo.mjs'
import { GatewayWorkerRepo } from '../../src/lib/gateway-worker/gateway-repo.mjs'
import { sealCredentialBundle } from '../../src/lib/executor/custody.mjs'
import { createCredentialVault, loadKeyring } from '../../src/lib/executor/vault.mjs'
import { migrateWorkerCredentials } from '../../scripts/migrate-worker-credentials.mjs'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..')
const tempDir = (t, prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

// 审计 U2：脚本从 runtime-secrets.json 只读取得托管部署自动生成的两把密钥，显式环境变量优先，文件不被改写
test('scripts read the managed runtime secrets without generating or rewriting them', (t) => {
  const dir = tempDir(t, 'secrets-')
  const file = path.join(dir, 'runtime-secrets.json')
  const saved = {
    KIN_CODEX_GATEWAY_INTERNAL_TOKEN: 'saved-token',
    KIN_CODEX_GATEWAY_CREDENTIAL_BUNDLE_KEY: 'saved-bundle',
  }
  fs.writeFileSync(file, JSON.stringify(saved), { mode: 0o600 })
  const before = fs.statSync(file).mtimeMs
  const env = { KIN_DATA_DIR: dir, KIN_CODEX_GATEWAY_INTERNAL_TOKEN: 'explicit' }
  const filled = loadRuntimeSecretsReadOnly({ env, root: dir })
  assert.deepEqual(filled, ['KIN_CODEX_GATEWAY_CREDENTIAL_BUNDLE_KEY'])
  assert.equal(env.KIN_CODEX_GATEWAY_INTERNAL_TOKEN, 'explicit')
  assert.equal(env.KIN_CODEX_GATEWAY_CREDENTIAL_BUNDLE_KEY, 'saved-bundle')
  assert.equal(fs.statSync(file).mtimeMs, before)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), saved)
  // 没有任何来源时什么都不补，也不创建文件
  const empty = tempDir(t, 'secrets-empty-')
  assert.deepEqual(loadRuntimeSecretsReadOnly({ env: { KIN_DATA_DIR: empty }, root: empty }), [])
  assert.equal(fs.existsSync(path.join(empty, 'runtime-secrets.json')), false)
})

// 审计 U3：脚本不执行迁移；库结构落后时报 schema_outdated 且库不变，只读打开不能写
test('script database opens never migrate and refuse an outdated schema', (t) => {
  const dir = tempDir(t, 'script-db-')
  const migrations = path.join(root, 'src', 'lib', 'db', 'migrations')
  const partial = tempDir(t, 'script-db-migrations-')
  const files = fs
    .readdirSync(migrations)
    .filter((file) => /^\d+.*\.sql$/.test(file))
    .sort()
  for (const file of files.slice(0, 10)) fs.copyFileSync(path.join(migrations, file), path.join(partial, file))
  createDatabase({ dataDir: dir, migrationsDir: partial }).close()
  assert.throws(() => openScriptDatabase({ dataDir: dir, readOnly: true }), { code: 'schema_outdated' })
  assert.throws(() => openScriptDatabase({ dataDir: dir }), { code: 'schema_outdated' })
  const db = createDatabase({ dataDir: dir, migrationsDir: partial })
  assert.equal(pendingMigrations(db).length, files.length - 10, 'the failed opens must not apply migrations')
  db.close()
  createDatabase({ dataDir: dir }).close()
  const readOnly = openScriptDatabase({ dataDir: dir, readOnly: true })
  t.after(() => readOnly.close())
  assert.throws(() => readOnly.exec("INSERT INTO settings(key,value) VALUES('x','y')"))
  assert.throws(() => openScriptDatabase({ dataDir: path.join(dir, 'missing') }), { code: 'database_missing' })
})

// 审计 U2：演练解开凭据包（密钥不匹配即报错）；导出失败保留各实例的状态码与错误码；报告给出主密钥文件
test('a dry-run migration unwraps bundles and keeps export failure details', async (t) => {
  const dir = tempDir(t, 'migrate-dry-')
  const db = createDatabase({ dataDir: dir })
  t.after(() => db.close())
  db.exec('PRAGMA foreign_keys=OFF')
  const repo = new GatewayWorkerRepo(db)
  await repo.upsertInstance({ id: 'gw-1', base_url: 'http://127.0.0.1:1', health_state: 'healthy' })
  const config = JSON.stringify({ platform: 'codex', execution_kind: 'gateway_worker' })
  for (const id of ['acct_ok', 'acct_bad']) {
    db.prepare(
      "INSERT INTO vendor_resources(id,vendor_id,resource_type,name,status,config_json,created_by,created_at,updated_at) VALUES(?,'v','account',?,'active',?,'t','x','x')",
    ).run(id, id, config)
    db.prepare(
      "INSERT INTO gateway_worker_account_bindings(account_resource_id,gateway_instance_id,runtime_account_id,credential_revision,projection_status,created_at,updated_at) VALUES(?,'gw-1',?,3,'synced','x','x')",
    ).run(id, `rt_${id}`)
  }
  const exported = (runtimeId, key) => ({
    account: { id: runtimeId, credential_revision: 3, bps: { revision: 2, token_generation: 4 } },
    credential_bundle: sealCredentialBundle(key, runtimeId, {
      access_token: 'a',
      refresh_token: 'r',
      bps_access_token: 'ba',
      bps_refresh_token: 'br',
    }),
  })
  const client = {
    async exportAccount(instanceId, runtimeId) {
      if (runtimeId === 'rt_acct_bad')
        return { ok: false, status: 401, data: { error: { code: 'gateway_auth_failed' } } }
      return { ok: true, data: exported(runtimeId, 'bundle-key') }
    },
  }
  const env = {
    KIN_CREDENTIAL_MASTER_KEY_FILE: path.join(dir, 'keys.json'),
    KIN_CODEX_GATEWAY_CREDENTIAL_BUNDLE_KEY: 'bundle-key',
  }
  const report = await migrateWorkerCredentials({ db, env, client, log: { warn() {} } })
  const item = (id) => report.items.find((entry) => entry.account_resource_id === id)
  assert.equal(report.master_key_file, env.KIN_CREDENTIAL_MASTER_KEY_FILE)
  assert.equal(report.master_key_file_exists, false)
  assert.deepEqual(
    { native: item('acct_ok').native, bps: item('acct_ok').bps },
    { native: 'would_store', bps: 'would_store' },
  )
  assert.deepEqual(item('acct_bad').export_failures, [
    { instance_id: 'gw-1', status: 401, code: 'gateway_auth_failed' },
  ])
  // 凭据包密钥不匹配：演练就报错，不等到 --apply
  const wrong = await migrateWorkerCredentials({
    db,
    env: { ...env, KIN_CODEX_GATEWAY_CREDENTIAL_BUNDLE_KEY: 'other-key' },
    client,
    log: { warn() {} },
  })
  assert.ok(wrong.items.find((entry) => entry.account_resource_id === 'acct_ok').error)
  assert.equal(fs.existsSync(env.KIN_CREDENTIAL_MASTER_KEY_FILE), false)
  // 审计复核 V3：代次跳变过大时演练与 --apply 一样报 revision_jump
  const vault = createCredentialVault({ db, keyring: loadKeyring({ file: env.KIN_CREDENTIAL_MASTER_KEY_FILE }) })
  await vault.put({
    accountResourceId: 'acct_ok',
    grant: 'native',
    revision: 1,
    secrets: { access_token: 'x' },
    source: 'test',
  })
  const jumping = {
    async exportAccount(instanceId, runtimeId) {
      const data = exported(runtimeId, 'bundle-key')
      return { ok: true, data: { ...data, account: { ...data.account, credential_revision: 5000 } } }
    },
  }
  const jump = await migrateWorkerCredentials({ db, env, client: jumping, log: { warn() {} } })
  assert.equal(jump.items.find((entry) => entry.account_resource_id === 'acct_ok').error, 'revision_jump')
})

// 审计 U3：轮换脚本不带动作参数只打印用法，不轮换
test('the master key rotation script requires an explicit action', (t) => {
  const dir = tempDir(t, 'rotate-')
  createDatabase({ dataDir: dir }).close()
  const keyFile = path.join(dir, 'credential-master-keys.json')
  const run = spawnSync(process.execPath, ['scripts/rotate-credential-master-key.mjs', '--data-dir', dir], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, KIN_CREDENTIAL_MASTER_KEY_FILE: keyFile },
  })
  assert.equal(run.status, 2, run.stderr)
  assert.match(run.stderr, /--rotate \| --retire \| --status/)
  assert.equal(fs.existsSync(keyFile), false)
})
