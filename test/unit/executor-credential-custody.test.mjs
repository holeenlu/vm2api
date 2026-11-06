import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { createCredentialVault, loadKeyring, tokenFingerprint } from '../../src/lib/executor/vault.mjs'
import { openCredentialBundle, sealCredentialBundle } from '../../src/lib/executor/custody.mjs'
import { createCredentialCustody } from '../../src/lib/executor/credential-custody.mjs'

const fixture = JSON.parse(
  fs.readFileSync(new URL('../fixtures/executor-contract/credential-bundle.json', import.meta.url), 'utf8'),
)
const KEY = 'custody-test-key'

async function withCustody(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'custody-'))
  const db = createDatabase({ dataDir: dir })
  const vault = createCredentialVault({ db, keyring: loadKeyring({ file: path.join(dir, 'keys.json') }) })
  const warnings = []
  const env = { KIN_CODEX_GATEWAY_CREDENTIAL_BUNDLE_KEY: KEY }
  const custody = createCredentialCustody({ db, env, vault, log: { warn: (m) => warnings.push(m) } })
  try {
    return await fn({ db, vault, custody, warnings })
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const exportedFor = (runtimeId, bundle, account = {}) => ({
  account: { id: runtimeId, chatgpt_account_id: 'cg-1', email: 'a@example.test', ...account },
  credential_bundle: sealCredentialBundle(KEY, runtimeId, bundle),
})

test('the credential bundle format matches the Worker (shared fixture) in both directions', () => {
  assert.deepEqual(
    openCredentialBundle(fixture.bundle_key, fixture.account_id, fixture.credential_bundle),
    fixture.bundle,
  )
  const sealed = sealCredentialBundle(fixture.bundle_key, 'acct_y', { refresh_token: 'r' })
  assert.deepEqual(openCredentialBundle(fixture.bundle_key, 'acct_y', sealed), { refresh_token: 'r' })
  assert.throws(() => openCredentialBundle(fixture.bundle_key, 'acct_other', sealed))
})

test('control custody captures by revision and records rotations by CAS', () =>
  withCustody(async ({ custody, vault }) => {
    const v1 = exportedFor(
      'rt_1',
      { access_token: 'at1', refresh_token: 'rt1', bps_access_token: 'bat1', bps_refresh_token: 'brt1' },
      { credential_revision: 1, bps: { revision: 1, token_generation: 0 } },
    )
    assert.deepEqual(await custody.capture({ accountResourceId: 'acct_1', runtimeAccountId: 'rt_1', exported: v1 }), {
      native: 'stored',
      bps: 'stored',
    })
    // 旧副本（代次不更高）不会覆盖凭据库
    const stale = exportedFor('rt_1', { access_token: 'old', refresh_token: 'old' }, { credential_revision: 1 })
    assert.deepEqual(
      await custody.capture({ accountResourceId: 'acct_1', runtimeAccountId: 'rt_1', exported: stale }),
      {
        native: 'current',
        bps: 'skipped',
      },
    )
    // 原生轮换：按代次 CAS
    const rotated = sealCredentialBundle(KEY, 'rt_1', { access_token: 'at2', refresh_token: 'rt2' })
    const rotateNative = (previousRevision) =>
      custody.recordRotation({
        accountResourceId: 'acct_1',
        runtimeAccountId: 'rt_1',
        grant: 'native',
        credentialBundle: rotated,
        revision: 2,
        previousRevision,
      })
    // 凭据库已超过轮换前的代次（期间重新授权）：这次轮换作废
    await assert.rejects(rotateNative(0), { code: 'credential_superseded', current_revision: 1 })
    assert.deepEqual(await rotateNative(1), { ok: true, revision: 2 })
    assert.equal((await vault.get('acct_1', 'native')).revision, 2)
    // BPS 轮换：按令牌代次 CAS（凭据库代次 = 令牌代次 + 1）
    const bpsRotated = sealCredentialBundle(KEY, 'rt_1', { bps_access_token: 'bat2', bps_refresh_token: 'brt2' })
    const rotateBps = (revision, previousRevision) =>
      custody.recordRotation({
        accountResourceId: 'acct_1',
        runtimeAccountId: 'rt_1',
        grant: 'bps',
        credentialBundle: bpsRotated,
        revision,
        previousRevision,
      })
    assert.deepEqual(await rotateBps(1, 0), { ok: true, revision: 2 })
    await assert.rejects(rotateBps(1, 0), { code: 'credential_superseded' })
    assert.equal((await vault.get('acct_1', 'bps')).revision, 2)
    // 轮换报告丢失：下一次从持有者导出时按更高的令牌代次收录，凭据库仍能追上（R3 审查 P1-2）
    const v3 = exportedFor(
      'rt_1',
      { access_token: 'at2', refresh_token: 'rt2', bps_access_token: 'bat3', bps_refresh_token: 'brt3' },
      { credential_revision: 2, bps: { revision: 1, token_generation: 2 } },
    )
    assert.deepEqual(await custody.capture({ accountResourceId: 'acct_1', runtimeAccountId: 'rt_1', exported: v3 }), {
      native: 'current',
      bps: 'stored',
    })
    assert.equal((await vault.get('acct_1', 'bps')).secrets.refresh_token, 'brt3')
    const stale2 = exportedFor('rt_1', { access_token: 'old', refresh_token: 'old' }, { credential_revision: 1 })
    // 导出读凭据库；撤销 BPS 后凭据库里的 BPS 记录一并删除
    const out = await custody.exportSecrets({ accountResourceId: 'acct_1', runtimeAccountId: 'rt_1', exported: stale2 })
    assert.equal(out.credentials.refresh_token, 'rt2')
    assert.equal(out.bps_credentials.refresh_token, 'brt3')
    assert.equal(await custody.forget('acct_1', 'bps'), 1)
    assert.equal(await vault.get('acct_1', 'bps'), null)
    // 代次增幅过大的上报被拒（R3 审查 P2-6）
    const jump = exportedFor('rt_1', { access_token: 'x', refresh_token: 'x' }, { credential_revision: 5000 })
    await assert.rejects(
      () => custody.capture({ accountResourceId: 'acct_1', runtimeAccountId: 'rt_1', exported: jump }),
      {
        code: 'revision_jump',
      },
    )
    // R6 B5 删除了临时同步出口 forgetSync / vault.removeSync：BPS 撤销的事务已改为 db.tx，改调 forget
    assert.equal(custody.forgetSync, undefined)
    assert.equal((await custody.vault()).removeSync, undefined)
    assert.equal(await custody.forget('acct_1', 'bps'), 0)
    assert.equal(await custody.forget('acct_1', 'native'), 1)
    assert.equal(await vault.get('acct_1', 'native'), null)
  }))

// G1：轮换报告在释放租约的事务里写凭据库，失败即抛错；凭据库落后（此前报告丢失）时以本次轮换为准
test('a rotation report catches up a vault that fell behind and refuses a missing bundle', () =>
  withCustody(async ({ custody, vault }) => {
    await custody.capture({
      accountResourceId: 'acct_1',
      runtimeAccountId: 'rt_1',
      exported: exportedFor('rt_1', { access_token: 'at1', refresh_token: 'rt1' }, { credential_revision: 1 }),
    })
    const report = (credentialBundle) =>
      custody.recordRotation({
        accountResourceId: 'acct_1',
        runtimeAccountId: 'rt_1',
        grant: 'native',
        credentialBundle,
        revision: 5,
        previousRevision: 4,
      })
    await assert.rejects(report(undefined), { code: 'credential_bundle_missing' })
    assert.deepEqual(await report(sealCredentialBundle(KEY, 'rt_1', { access_token: 'at5', refresh_token: 'rt5' })), {
      ok: true,
      revision: 5,
    })
    const stored = await vault.get('acct_1', 'native')
    assert.equal(stored.revision, 5)
    assert.equal(stored.secrets.refresh_token, 'rt5')
    await assert.rejects(
      custody.recordRotation({
        accountResourceId: 'acct_1',
        runtimeAccountId: 'rt_1',
        grant: 'bps',
        credentialBundle: sealCredentialBundle(KEY, 'rt_1', { access_token: 'at6' }),
        revision: 1,
        previousRevision: 0,
      }),
      { code: 'bps_credentials_missing' },
    )
  }))

// 终审 B4、B5：代理地址不进凭据库（Worker 从账号配置直读）；导出账号文件时先收录，凭据库仍旧时用 Worker 副本
test('control custody never stores the proxy and never exports a stale vault copy', () =>
  withCustody(async ({ custody, vault }) => {
    const v1 = exportedFor(
      'rt_1',
      { access_token: 'at1', refresh_token: 'rt1', proxy_url: 'socks5h://old:1' },
      { credential_revision: 1 },
    )
    await custody.capture({ accountResourceId: 'acct_1', runtimeAccountId: 'rt_1', exported: v1 })
    assert.equal(
      (await vault.get('acct_1', 'native')).secrets.proxy_url,
      undefined,
      'the proxy is not stored in the vault',
    )
    // Worker 副本更新（代次 3），导出时先收录，导出的是新令牌
    const v3 = exportedFor('rt_1', { access_token: 'at3', refresh_token: 'rt3' }, { credential_revision: 3 })
    assert.equal(
      (await custody.exportSecrets({ accountResourceId: 'acct_1', runtimeAccountId: 'rt_1', exported: v3 })).credentials
        .refresh_token,
      'rt3',
    )
    assert.equal((await vault.get('acct_1', 'native')).revision, 3)
  }))
