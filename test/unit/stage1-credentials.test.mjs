import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runSlotOauthEnsured } from '../../src/lib/transport/go-worker-client.mjs'
import { readCodexAccounts, refreshCodexSlotAccess, writeCodexAccounts } from '../../src/lib/vm/codex-slot.mjs'
import { closeDatabase, createDatabase } from '../../src/lib/db/database.mjs'
import {
  claudeSlotVaultId,
  mirrorClaudeSlotCredential,
  readClaudeSlotVaultCopy,
} from '../../src/lib/oauth/claude-slot-vault.mjs'

const needsRefresh = { ok: false, status: 401, body: { error: { code: 'needs_refresh' } } }

test('slot oauth reads ensure through the locked refresh path once, then retry (audit P1-C3)', async () => {
  const calls = []
  const run = async (_exec, op) => {
    calls.push(op)
    return calls.length === 1 ? needsRefresh : { ok: true, status: 200, body: { op } }
  }
  let ensures = 0
  const result = await runSlotOauthEnsured(
    {},
    'usage',
    {},
    { run, ensure: async () => ({ ok: true, refreshed: ++ensures > 0 }) },
  )
  assert.equal(result.ok, true)
  assert.deepEqual(calls, ['usage', 'usage'])
  assert.equal(ensures, 1)

  // ensure 失败（登录保护窗、授权失效）时不重试，原样返回 needs_refresh
  calls.length = 0
  const blocked = await runSlotOauthEnsured({}, 'models', {}, { run, ensure: async () => ({ ok: false }) })
  assert.equal(blocked.body.error.code, 'needs_refresh')
  assert.deepEqual(calls, ['models'])

  // 其他结果不触发 ensure
  let touched = false
  const plain = await runSlotOauthEnsured(
    {},
    'profile',
    {},
    {
      run: async () => ({ ok: false, status: 403, body: { error: { code: 'forbidden' } } }),
      ensure: async () => {
        touched = true
        return { ok: true }
      },
    },
  )
  assert.equal(plain.status, 403)
  assert.equal(touched, false)
})

function codexRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-refresh-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'vms', 'gpt-a'), { recursive: true })
  writeCodexAccounts(root, 'gpt-a', [{ id: 'a', access_token: 'at-1', refresh_token: 'rt-1' }])
  return root
}

test('control-plane Codex refreshes share one flight per slot and adopt a rotation the kernel wrote (audit P1-C4)', async (t) => {
  const root = codexRoot(t)
  const used = []
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const refresh = async (rt) => {
    used.push(rt)
    await gate
    return { ok: true, access_token: 'at-2', refresh_token: 'rt-2' }
  }
  const first = refreshCodexSlotAccess(root, 'gpt-a', { usedAccess: 'at-1', refresh })
  const second = refreshCodexSlotAccess(root, 'gpt-a', { usedAccess: 'at-1', refresh })
  release()
  const [a, b] = await Promise.all([first, second])
  assert.deepEqual(used, ['rt-1'], 'concurrent callers refresh once')
  assert.equal(a.access_token, 'at-2')
  assert.equal(b.access_token, 'at-2')
  assert.equal(readCodexAccounts(root, 'gpt-a')[0].refresh_token, 'rt-2')

  // 调用方用的是旧 access，文件里已有新令牌：直接采用，不再换票
  const adopted = await refreshCodexSlotAccess(root, 'gpt-a', {
    usedAccess: 'at-1',
    refresh: async () => assert.fail('must not refresh a token the file already rotated'),
  })
  assert.equal(adopted.adopted, true)
  assert.equal(adopted.access_token, 'at-2')
})

test('Claude slot credentials are mirrored into the vault and readable for restore (audit P1-C9)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-slot-vault-'))
  const previousKeyFile = process.env.KIN_CREDENTIAL_MASTER_KEY_FILE
  process.env.KIN_CREDENTIAL_MASTER_KEY_FILE = path.join(dir, 'master-keys.json')
  const db = createDatabase({ dataDir: dir })
  t.after(async () => {
    db.close()
    await closeDatabase()
    if (previousKeyFile == null) delete process.env.KIN_CREDENTIAL_MASTER_KEY_FILE
    else process.env.KIN_CREDENTIAL_MASTER_KEY_FILE = previousKeyFile
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const homeDir = path.join(dir, 'cli-home')
  const file = path.join(homeDir, '.claude', 'credentials.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const write = (generation, refreshToken) =>
    fs.writeFileSync(
      file,
      JSON.stringify({
        type: 'oauth',
        kinGeneration: generation,
        claudeAiOauth: { accessToken: `at-${generation}`, refreshToken, expiresAt: Date.now() + 3600_000 },
      }),
    )
  write(1000, 'rt-a')
  const first = await mirrorClaudeSlotCredential('vm-7', homeDir, { db })
  assert.equal(first.ok, true)
  assert.equal(first.revision, 1000)

  // 代次没变不重复写（凭据库按同代次同指纹判重）；更新的代次覆盖
  assert.equal((await mirrorClaudeSlotCredential('vm-7', homeDir, { db })).duplicate, true)
  write(2000, 'rt-b')
  assert.equal((await mirrorClaudeSlotCredential('vm-7', homeDir, { db })).revision, 2000)

  const copy = await readClaudeSlotVaultCopy('vm-7', { db })
  assert.equal(copy.revision, 2000)
  assert.equal(copy.document.claudeAiOauth.refreshToken, 'rt-b')
  // 库里只有密文
  const row = db
    .prepare('SELECT * FROM executor_credentials WHERE account_resource_id = ?')
    .get(claudeSlotVaultId('vm-7'))
  assert.equal(row.grant_kind, 'claude_slot')
  assert.ok(!String(row.ciphertext).includes('rt-b'))
})
