// 审计 U7：主密钥丢失诊断与重置工具 scripts/credential-master-key-doctor.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createDatabase, vacuumInto } from '../../src/lib/db/database.mjs'
import { createCredentialVault, loadKeyring } from '../../src/lib/executor/vault.mjs'
import { openScriptDatabase } from '../../src/lib/executor/repos/script-db-repo.mjs'
import { retireUnusedKeys, rotateMasterKey } from '../../scripts/rotate-credential-master-key.mjs'
import { diagnoseMasterKey, resetMasterKey } from '../../scripts/credential-master-key-doctor.mjs'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..')
const native = { access_token: 'at_secret_1', refresh_token: 'rt_secret_1', id_token: 'id_secret_1' }
const bps = { access_token: 'bps_at_secret', refresh_token: 'bps_rt_secret' }

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-doctor-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const db = createDatabase({ dataDir: dir })
  t.after(() => {
    try {
      db.close()
    } catch {}
  })
  const file = path.join(dir, 'credential-master-keys.json')
  const vault = createCredentialVault({ db, keyring: loadKeyring({ file }) })
  return { dir, db, file, vault }
}

// 报告里不能出现令牌明文、令牌指纹或主密钥
function assertNoSecrets(report, file) {
  const text = JSON.stringify(report)
  for (const secret of [...Object.values(native), ...Object.values(bps)]) assert.ok(!text.includes(secret), secret)
  assert.ok(!text.includes('token_fingerprint'))
  if (fs.existsSync(file))
    for (const key of Object.values(JSON.parse(fs.readFileSync(file, 'utf8')).keys)) assert.ok(!text.includes(key))
}

test('the doctor reports key file state and which records each key opens, without secrets', async (t) => {
  const { db, file, vault } = setup(t)
  await vault.put({ accountResourceId: 'acct_1', grant: 'native', revision: 1, secrets: native })
  await vault.put({ accountResourceId: 'acct_1', grant: 'bps', revision: 2, secrets: bps })
  const healthy = await diagnoseMasterKey({ db, file })
  assert.equal(healthy.status, 'ok')
  assert.deepEqual(
    [healthy.master_key_file.exists, healthy.master_key_file.readable, healthy.master_key_file.valid],
    [true, true, true],
  )
  assert.equal(healthy.master_key_file.mode, '0600')
  assert.deepEqual(healthy.summary.by_master_key, { [healthy.master_key_file.active]: 2 })
  assert.deepEqual(
    healthy.records.map((record) => [record.account_resource_id, record.grant, record.status]),
    [
      ['acct_1', 'bps', 'ok'],
      ['acct_1', 'native', 'ok'],
    ],
  )
  assertNoSecrets(healthy, file)
  // 格式不合法：按丢失处理
  const original = fs.readFileSync(file, 'utf8')
  fs.writeFileSync(file, '{not json')
  const broken = await diagnoseMasterKey({ db, file })
  assert.deepEqual([broken.status, broken.master_key_file.error], ['master_key_lost', 'invalid_json'])
  fs.writeFileSync(file, JSON.stringify({ active: 'mk_x', keys: { mk_x: 'short' } }))
  assert.equal((await diagnoseMasterKey({ db, file })).master_key_file.error, 'invalid_format')
  fs.writeFileSync(file, original, { mode: 0o600 })
  // 存在但读不出（非 root 时）：不当作丢失
  if (process.getuid?.() !== 0) {
    fs.chmodSync(file, 0o000)
    const unreadable = await diagnoseMasterKey({ db, file })
    const refused = await resetMasterKey({ db, file, dataDir: path.dirname(file), confirm: true })
    fs.chmodSync(file, 0o600)
    assert.equal(unreadable.status, 'key_file_unreadable')
    assert.equal(unreadable.master_key_file.error, 'EACCES')
    assert.equal(refused.refused, 'key_file_unreadable')
  }
})

test('records wrapped by a retired key are recoverable from the archive and block the reset', async (t) => {
  const { dir, db, file, vault } = setup(t)
  await vault.put({ accountResourceId: 'acct_1', grant: 'native', revision: 1, secrets: native })
  // 轮换前的数据库快照（相当于面板备份），之后轮换并退役旧主密钥
  const snapshot = path.join(dir, 'before-rotation', 'kin.db')
  vacuumInto(db, snapshot)
  const rotated = await rotateMasterKey({ db, file })
  const retired = await retireUnusedKeys({ db, file })
  // 恢复轮换前的快照：记录由已退役的旧主密钥包裹
  const old = openScriptDatabase({ dataDir: path.dirname(snapshot) })
  t.after(() => old.close())
  const diagnosis = await diagnoseMasterKey({ db: old, file })
  assert.equal(diagnosis.status, 'recoverable_from_archive')
  assert.deepEqual(diagnosis.summary.missing_master_keys, retired.retired)
  assert.equal(diagnosis.records[0].status, 'master_key_missing')
  assert.equal(diagnosis.records[0].recoverable_from, retired.archive)
  assert.deepEqual(diagnosis.archive.files, [{ file: retired.archive, key_ids: retired.retired }])
  assertNoSecrets(diagnosis, file)
  const refused = await resetMasterKey({ db: old, file, dataDir: dir, confirm: true })
  assert.deepEqual(
    [refused.reset, refused.refused, refused.archives],
    [false, 'recoverable_from_archive', [retired.archive]],
  )
  assert.equal(
    (await createCredentialVault({ db: old, keyring: loadKeyring({ file, create: false }) }).list()).length,
    1,
  )
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).active, rotated.active, 'the key file is untouched')
})

test('reset backs up, deletes only the unreadable records and generates a new master key when the file is lost', async (t) => {
  const { dir, db, file, vault } = setup(t)
  await vault.put({ accountResourceId: 'acct_1', grant: 'native', revision: 1, secrets: native })
  await vault.put({ accountResourceId: 'acct_2', grant: 'bps', revision: 3, secrets: bps })
  // 健康时拒绝
  assert.equal((await resetMasterKey({ db, file, dataDir: dir, confirm: true })).refused, 'nothing_to_reset')
  const lostKey = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.rmSync(file)
  const lost = await diagnoseMasterKey({ db, file })
  // 路径上没有文件：先判为“文件不在这里”，不直接判丢失（M5 复审 P1-2）
  assert.equal(lost.status, 'master_key_file_missing')
  assert.equal(lost.master_key_file.exists, false)
  assert.equal(lost.summary.unreadable, 2)
  // 没有用 --key-file 明确指定路径时拒绝重置，什么都不删
  const unconfirmed = await resetMasterKey({ db, file, dataDir: dir, confirm: true })
  assert.equal(unconfirmed.refused, 'key_file_missing_unconfirmed')
  assert.equal((await vault.list()).length, 2)
  // 不带 --confirm 只预览
  const preview = await resetMasterKey({ db, file, dataDir: dir, keyFileExplicit: true })
  assert.deepEqual(
    [preview.reset, preview.preview, preview.would_delete, preview.new_master_key],
    [false, true, 2, true],
  )
  assert.equal(fs.existsSync(file), false)
  assert.equal(fs.existsSync(path.join(dir, 'backups')), false)
  const now = Date.parse('2026-11-06T01:02:03.004Z')
  const reset = await resetMasterKey({ db, file, dataDir: dir, confirm: true, keyFileExplicit: true, now })
  assert.deepEqual([reset.reset, reset.deleted, reset.new_master_key], [true, 2, true])
  assert.equal(reset.backup_dir, path.join(dir, 'backups', 'credential-master-key-reset-2026-11-06T01-02-03-004Z'))
  assert.equal(fs.statSync(reset.backup_dir).mode & 0o777, 0o700)
  const backupDb = path.join(reset.backup_dir, 'kin.db')
  assert.equal(fs.statSync(backupDb).mode & 0o777, 0o600)
  // 备份里仍是重置前的记录
  const backup = openScriptDatabase({ dbPath: backupDb, readOnly: true })
  t.after(() => backup.close())
  assert.equal(backup.prepare('SELECT COUNT(*) AS n FROM executor_credentials').get().n, 2)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM executor_credentials').get().n, 0)
  // 新主密钥文件 0600，与丢失的不同
  const fresh = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.equal(fresh.active, reset.active_master_key)
  assert.notEqual(fresh.active, lostKey.active)
  const audit = db
    .prepare("SELECT actor,after_json FROM operation_audit WHERE action='gateway.credentials.master_key_reset'")
    .get()
  assert.equal(audit.actor, 'system:credential-master-key-doctor')
  assert.equal(JSON.parse(audit.after_json).deleted, 2)
  assert.ok(reset.next_steps.some((step) => step.includes('migrate-worker-credentials.mjs')))
  assertNoSecrets(reset, file)
  assert.equal((await diagnoseMasterKey({ db, file })).status, 'no_records')
})

test('with a valid key file only the records that cannot be opened are removed and the file is kept', async (t) => {
  const { dir, db, file, vault } = setup(t)
  await vault.put({ accountResourceId: 'acct_1', grant: 'native', revision: 1, secrets: native })
  await vault.put({ accountResourceId: 'acct_2', grant: 'native', revision: 1, secrets: { refresh_token: 'rt_2' } })
  // 一条记录引用的旧主密钥不在文件里、也没有归档
  db.prepare("UPDATE executor_credentials SET master_key_id='mk_gone' WHERE account_resource_id='acct_2'").run()
  const keyBefore = fs.readFileSync(file, 'utf8')
  const diagnosis = await diagnoseMasterKey({ db, file })
  assert.equal(diagnosis.status, 'master_key_lost')
  assert.deepEqual(diagnosis.summary.missing_master_keys, ['mk_gone'])
  const reset = await resetMasterKey({ db, file, dataDir: dir, confirm: true })
  assert.deepEqual([reset.deleted, reset.new_master_key], [1, false])
  assert.deepEqual(reset.records, [{ account_resource_id: 'acct_2', grant: 'native' }])
  assert.equal(fs.readFileSync(file, 'utf8'), keyBefore, 'a valid key file is kept')
  assert.ok(fs.existsSync(path.join(reset.backup_dir, 'credential-master-keys.json')))
  assert.deepEqual((await vault.get('acct_1', 'native')).secrets, native)
})

test('the doctor CLI is read-only by default and refuses --confirm without --reset', (t) => {
  const { dir, db, file, vault } = setup(t)
  return (async () => {
    await vault.put({ accountResourceId: 'acct_1', grant: 'native', revision: 1, secrets: native })
    db.close()
    fs.rmSync(file)
    const env = { ...process.env, KIN_CREDENTIAL_MASTER_KEY_FILE: '' }
    const run = (...args) =>
      spawnSync(process.execPath, ['scripts/credential-master-key-doctor.mjs', '--data-dir', dir, ...args], {
        cwd: root,
        encoding: 'utf8',
        env,
      })
    const diagnose = run()
    assert.equal(diagnose.status, 1, diagnose.stderr)
    assert.equal(JSON.parse(diagnose.stdout).status, 'master_key_file_missing')
    assert.equal(JSON.parse(diagnose.stdout).master_key_file_source, 'default')
    assert.equal(fs.existsSync(file), false, 'diagnosis does not create a key file')
    assertNoSecrets(diagnose.stdout, file)
    assert.equal(run('--confirm').status, 2)
    // 没有 --key-file：拒绝重置
    const refused = run('--reset', '--confirm')
    assert.equal(refused.status, 1, refused.stderr)
    assert.equal(JSON.parse(refused.stdout).refused, 'key_file_missing_unconfirmed')
    const reset = run('--reset', '--confirm', '--key-file', file)
    assert.equal(reset.status, 0, reset.stderr)
    assert.equal(JSON.parse(reset.stdout).deleted, 1)
    assert.ok(fs.existsSync(file))
    assert.equal(JSON.parse(run().stdout).status, 'no_records')
  })()
})
