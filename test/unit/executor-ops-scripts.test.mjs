import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { loadRuntimeSecretsReadOnly } from '../../src/lib/core/runtime-secrets.mjs'
import { openScriptDatabase, pendingMigrations } from '../../src/lib/executor/repos/script-db-repo.mjs'

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
