import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import {
  addMasterKey,
  createCredentialVault,
  loadKeyring,
  openCredentialVault,
  readRetiredKeys,
  tokenFingerprint,
  vaultHasRecords,
} from '../../src/lib/executor/vault.mjs'
import { keyStatus, retireUnusedKeys, rotateMasterKey } from '../../scripts/rotate-credential-master-key.mjs'

async function withVault(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'))
  const db = createDatabase({ dataDir: dir })
  const file = path.join(dir, 'credential-master-keys.json')
  try {
    return await fn({ db, file, dir, vault: createCredentialVault({ db, keyring: loadKeyring({ file }) }) })
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const native = { access_token: 'at_1', refresh_token: 'rt_1', id_token: 'id_1' }

test('credentials are enveloped: no plaintext in the database, CAS by revision, key file is private', () =>
  withVault(async ({ db, file, vault }) => {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    const saved = await vault.put({ accountResourceId: 'acct_1', grant: 'native', revision: 1, secrets: native })
    assert.equal(saved.revision, 1)
    assert.equal(saved.token_fingerprint, tokenFingerprint('rt_1'))
    const raw = JSON.stringify(db.prepare('SELECT * FROM executor_credentials').all())
    for (const secret of Object.values(native)) assert.ok(!raw.includes(secret), `plaintext ${secret} leaked`)
    assert.deepEqual((await vault.get('acct_1', 'native')).secrets, native)
    assert.equal(await vault.get('acct_1', 'claude_slot'), null)
    // 重复写入同代次同令牌：幂等
    assert.equal(
      (await vault.put({ accountResourceId: 'acct_1', grant: 'native', revision: 1, secrets: native })).duplicate,
      true,
    )
    // CAS：期望代次不符、或新代次不大于当前代次都被拒绝
    await assert.rejects(
      () =>
        vault.put({ accountResourceId: 'acct_1', grant: 'native', revision: 3, expectedRevision: 0, secrets: native }),
      { code: 'stale_revision' },
    )
    await assert.rejects(
      () => vault.put({ accountResourceId: 'acct_1', grant: 'native', revision: 1, secrets: { refresh_token: 'x' } }),
      { code: 'stale_revision' },
    )
    const next = { ...native, refresh_token: 'rt_2' }
    await vault.put({ accountResourceId: 'acct_1', grant: 'native', revision: 2, expectedRevision: 1, secrets: next })
    assert.equal((await vault.get('acct_1', 'native')).secrets.refresh_token, 'rt_2')
    await assert.rejects(() => vault.put({ accountResourceId: 'acct_1', grant: 'other', revision: 1, secrets: {} }), {
      code: 'invalid_grant_kind',
    })
  }))

test('tampered or transplanted records fail authentication', () =>
  withVault(async ({ db, vault }) => {
    await vault.put({ accountResourceId: 'acct_1', grant: 'native', revision: 1, secrets: native })
    await vault.put({ accountResourceId: 'acct_2', grant: 'native', revision: 1, secrets: { refresh_token: 'other' } })
    // 把 acct_2 的密文挪到 acct_1：附加认证数据不符
    db.exec(`UPDATE executor_credentials SET ciphertext=(SELECT ciphertext FROM executor_credentials WHERE account_resource_id='acct_2'),
               wrapped_key=(SELECT wrapped_key FROM executor_credentials WHERE account_resource_id='acct_2')
             WHERE account_resource_id='acct_1'`)
    await assert.rejects(() => vault.get('acct_1', 'native'), { code: 'credential_tampered' })
    // 改代次同样无法解密
    db.exec("UPDATE executor_credentials SET revision=5 WHERE account_resource_id='acct_2'")
    await assert.rejects(() => vault.get('acct_2', 'native'), { code: 'credential_tampered' })
  }))

test('master key rotation rewraps every record and retires the old key only when unused', () =>
  withVault(async ({ db, file, vault }) => {
    await vault.put({ accountResourceId: 'acct_1', grant: 'native', revision: 1, secrets: native })
    await vault.put({
      accountResourceId: 'acct_2',
      grant: 'native',
      revision: 1,
      secrets: { refresh_token: 'rt_acct_2' },
    })
    const before = keyStatus({ db, file })
    assert.equal(before.keys.length, 1)
    const rotated = await rotateMasterKey({ db, file })
    assert.equal(rotated.rewrapped, 2)
    const after = keyStatus({ db, file })
    assert.equal(after.active, rotated.active)
    assert.deepEqual(
      after.keys.map((key) => [key.id === rotated.active, key.records]),
      [
        [false, 0],
        [true, 2],
      ],
    )
    const oldKey = JSON.parse(fs.readFileSync(file, 'utf8')).keys[before.active]
    const retired = await retireUnusedKeys({ db, file })
    assert.deepEqual(retired.retired, [before.active])
    // 审计 U6：退役的主密钥归档（目录 0700、文件 0600），不删除；主密钥文件只剩 active
    assert.equal(path.dirname(retired.archive), path.join(path.dirname(file), 'credential-master-keys.retired'))
    assert.equal(fs.statSync(path.dirname(retired.archive)).mode & 0o777, 0o700)
    assert.equal(fs.statSync(retired.archive).mode & 0o777, 0o600)
    const archived = JSON.parse(fs.readFileSync(retired.archive, 'utf8'))
    assert.deepEqual(archived.keys, { [before.active]: oldKey })
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).keys), [rotated.active])
    assert.deepEqual(
      readRetiredKeys(file).map((item) => [item.id, item.key.toString('base64')]),
      [[before.active, oldKey]],
    )
    // 没有可退役的密钥时不写归档
    assert.deepEqual(await retireUnusedKeys({ db, file }), { retired: [], archive: null })
    assert.equal(fs.readdirSync(path.dirname(retired.archive)).length, 1)
    const reloaded = createCredentialVault({ db, keyring: loadKeyring({ file, create: false }) })
    assert.deepEqual((await reloaded.get('acct_1', 'native')).secrets, native)
    assert.equal((await reloaded.get('acct_2', 'native')).secrets.refresh_token, 'rt_acct_2')
    // 引用中的主密钥丢失：明确报错，不返回错误的明文
    fs.writeFileSync(
      file,
      JSON.stringify({ active: 'mk_other', keys: { mk_other: Buffer.alloc(32, 1).toString('base64') } }),
    )
    const wrongKeys = createCredentialVault({ db, keyring: loadKeyring({ file, create: false }) })
    await assert.rejects(() => wrongKeys.get('acct_1', 'native'), { code: 'master_key_missing' })
  }))

test('a missing master key file is an error once records exist; a running vault picks up a rotated key (R3 P1-3)', () =>
  withVault(async ({ db, file, vault }) => {
    await vault.put({ accountResourceId: 'acct_1', grant: 'native', revision: 1, secrets: native })
    // 在线轮换：运行中的凭据库读到新主密钥 ID 时重读主密钥文件
    await rotateMasterKey({ db, file })
    assert.deepEqual((await vault.get('acct_1', 'native')).secrets, native)
    assert.ok(fs.readdirSync(path.dirname(file)).some((name) => name.startsWith('credential-master-keys.json.bak-')))
    // 主密钥文件丢失：不能静默生成新密钥
    fs.rmSync(file)
    // R6 B8：按库内记录决定主密钥能否生成改为 async 工厂 openCredentialVault；同步构造必须传入已加载的主密钥
    await assert.rejects(openCredentialVault({ db, env: { KIN_CREDENTIAL_MASTER_KEY_FILE: file } }), {
      code: 'master_key_file_missing',
    })
    assert.throws(() => createCredentialVault({ db, keyring: null }), TypeError)
    const hasRecords = await vaultHasRecords(db)
    assert.equal(hasRecords, true)
    assert.throws(() => loadKeyring({ file, create: !hasRecords }), { code: 'master_key_file_missing' })
  }))

test('a running vault writes with the new active master key as soon as the key file changes (R3 re-review N4)', () =>
  withVault(async ({ db, file, vault }) => {
    await vault.put({ accountResourceId: 'acct_1', grant: 'native', revision: 1, secrets: native })
    const keyOf = (id) =>
      db
        .prepare("SELECT master_key_id FROM executor_credentials WHERE account_resource_id=? AND grant_kind='native'")
        .get(id).master_key_id
    const before = keyOf('acct_1')
    // 另一个进程（轮换脚本）新增主密钥；把 mtime 推后，避免与上一次加载落在同一时刻
    const added = addMasterKey(file)
    const later = new Date(Date.now() + 5000)
    fs.utimesSync(file, later, later)
    await vault.put({ accountResourceId: 'acct_2', grant: 'native', revision: 1, secrets: native })
    assert.notEqual(keyOf('acct_2'), before)
    assert.equal(keyOf('acct_2'), added)
    assert.deepEqual((await vault.get('acct_1', 'native')).secrets, native)
  }))

// 终审 B7：只读演练不创建主密钥文件；首次创建不覆盖已存在的文件
test('the read-only facts check creates no master key file and first creation never overwrites one', async () => {
  const { gatewayFactsPreflight } = await import('../../scripts/gateway-facts-preflight.mjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-dry-'))
  const db = createDatabase({ dataDir: dir })
  try {
    const file = path.join(dir, 'credential-master-keys.json')
    const env = { KIN_CREDENTIAL_MASTER_KEY_FILE: file }
    const report = await gatewayFactsPreflight({ db, env, log: { warn() {} } })
    assert.deepEqual(report.summary, { accounts: 0, with_issues: 0 })
    assert.equal(fs.existsSync(file), false, 'the read-only check must not create a key file')
    const first = loadKeyring({ file })
    const second = loadKeyring({ file })
    assert.equal(second.active, first.active)
    assert.deepEqual(second.keys.get(second.active), first.keys.get(first.active))
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
