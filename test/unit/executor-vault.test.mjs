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
  tokenFingerprint,
  vaultHasRecords,
} from '../../src/lib/executor/vault.mjs'
import { keyStatus, retireUnusedKeys, rotateMasterKey } from '../../scripts/rotate-credential-master-key.mjs'

function withVault(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'))
  const db = createDatabase({ dataDir: dir })
  const file = path.join(dir, 'credential-master-keys.json')
  try {
    return fn({ db, file, dir, vault: createCredentialVault({ db, keyring: loadKeyring({ file }) }) })
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const native = { access_token: 'at_1', refresh_token: 'rt_1', id_token: 'id_1' }

test('credentials are enveloped: no plaintext in the database, CAS by revision, key file is private', () =>
  withVault(({ db, file, vault }) => {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    const saved = vault.put({ accountResourceId: 'acct_1', grant: 'native', revision: 1, secrets: native })
    assert.equal(saved.revision, 1)
    assert.equal(saved.token_fingerprint, tokenFingerprint('rt_1'))
    const raw = JSON.stringify(db.prepare('SELECT * FROM executor_credentials').all())
    for (const secret of Object.values(native)) assert.ok(!raw.includes(secret), `plaintext ${secret} leaked`)
    assert.deepEqual(vault.get('acct_1', 'native').secrets, native)
    assert.equal(vault.get('acct_1', 'bps'), null)
    // 重复写入同代次同令牌：幂等
    assert.equal(
      vault.put({ accountResourceId: 'acct_1', grant: 'native', revision: 1, secrets: native }).duplicate,
      true,
    )
    // CAS：期望代次不符、或新代次不大于当前代次都被拒绝
    assert.throws(
      () =>
        vault.put({ accountResourceId: 'acct_1', grant: 'native', revision: 3, expectedRevision: 0, secrets: native }),
      { code: 'stale_revision' },
    )
    assert.throws(
      () => vault.put({ accountResourceId: 'acct_1', grant: 'native', revision: 1, secrets: { refresh_token: 'x' } }),
      { code: 'stale_revision' },
    )
    const next = { ...native, refresh_token: 'rt_2' }
    vault.put({ accountResourceId: 'acct_1', grant: 'native', revision: 2, expectedRevision: 1, secrets: next })
    assert.equal(vault.get('acct_1', 'native').secrets.refresh_token, 'rt_2')
    assert.throws(() => vault.put({ accountResourceId: 'acct_1', grant: 'other', revision: 1, secrets: {} }), {
      code: 'invalid_grant_kind',
    })
  }))

test('tampered or transplanted records fail authentication', () =>
  withVault(({ db, vault }) => {
    vault.put({ accountResourceId: 'acct_1', grant: 'native', revision: 1, secrets: native })
    vault.put({ accountResourceId: 'acct_2', grant: 'native', revision: 1, secrets: { refresh_token: 'other' } })
    // 把 acct_2 的密文挪到 acct_1：附加认证数据不符
    db.exec(`UPDATE executor_credentials SET ciphertext=(SELECT ciphertext FROM executor_credentials WHERE account_resource_id='acct_2'),
               wrapped_key=(SELECT wrapped_key FROM executor_credentials WHERE account_resource_id='acct_2')
             WHERE account_resource_id='acct_1'`)
    assert.throws(() => vault.get('acct_1', 'native'), { code: 'credential_tampered' })
    // 改代次同样无法解密
    db.exec("UPDATE executor_credentials SET revision=5 WHERE account_resource_id='acct_2'")
    assert.throws(() => vault.get('acct_2', 'native'), { code: 'credential_tampered' })
  }))

test('master key rotation rewraps every record and retires the old key only when unused', () =>
  withVault(({ db, file, vault }) => {
    vault.put({ accountResourceId: 'acct_1', grant: 'native', revision: 1, secrets: native })
    vault.put({ accountResourceId: 'acct_1', grant: 'bps', revision: 1, secrets: { refresh_token: 'bps_rt' } })
    const before = keyStatus({ db, file })
    assert.equal(before.keys.length, 1)
    const rotated = rotateMasterKey({ db, file })
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
    assert.deepEqual(retireUnusedKeys({ db, file }).retired, [before.active])
    const reloaded = createCredentialVault({ db, keyring: loadKeyring({ file, create: false }) })
    assert.deepEqual(reloaded.get('acct_1', 'native').secrets, native)
    assert.equal(reloaded.get('acct_1', 'bps').secrets.refresh_token, 'bps_rt')
    // 引用中的主密钥丢失：明确报错，不返回错误的明文
    fs.writeFileSync(
      file,
      JSON.stringify({ active: 'mk_other', keys: { mk_other: Buffer.alloc(32, 1).toString('base64') } }),
    )
    const wrongKeys = createCredentialVault({ db, keyring: loadKeyring({ file, create: false }) })
    assert.throws(() => wrongKeys.get('acct_1', 'native'), { code: 'master_key_missing' })
  }))

test('a missing master key file is an error once records exist; a running vault picks up a rotated key (R3 P1-3)', () =>
  withVault(({ db, file, vault }) => {
    vault.put({ accountResourceId: 'acct_1', grant: 'native', revision: 1, secrets: native })
    // 在线轮换：运行中的凭据库读到新主密钥 ID 时重读主密钥文件
    rotateMasterKey({ db, file })
    assert.deepEqual(vault.get('acct_1', 'native').secrets, native)
    assert.ok(fs.readdirSync(path.dirname(file)).some((name) => name.startsWith('credential-master-keys.json.bak-')))
    // 主密钥文件丢失：不能静默生成新密钥
    fs.rmSync(file)
    assert.throws(() => createCredentialVault({ db, keyring: null }), { code: 'master_key_file_missing' })
    assert.throws(() => loadKeyring({ file, create: !vaultHasRecords(db) }), { code: 'master_key_file_missing' })
  }))

test('a running vault writes with the new active master key as soon as the key file changes (R3 re-review N4)', () =>
  withVault(({ db, file, vault }) => {
    vault.put({ accountResourceId: 'acct_1', grant: 'native', revision: 1, secrets: native })
    const keyOf = (id) =>
      db
        .prepare("SELECT master_key_id FROM executor_credentials WHERE account_resource_id=? AND grant_kind='native'")
        .get(id).master_key_id
    const before = keyOf('acct_1')
    // 另一个进程（轮换脚本）新增主密钥；把 mtime 推后，避免与上一次加载落在同一时刻
    const added = addMasterKey(file)
    const later = new Date(Date.now() + 5000)
    fs.utimesSync(file, later, later)
    vault.put({ accountResourceId: 'acct_2', grant: 'native', revision: 1, secrets: native })
    assert.notEqual(keyOf('acct_2'), before)
    assert.equal(keyOf('acct_2'), added)
    assert.deepEqual(vault.get('acct_1', 'native').secrets, native)
  }))
