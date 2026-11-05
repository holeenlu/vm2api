import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { createCredentialVault, loadKeyring, tokenFingerprint } from '../../src/lib/executor/vault.mjs'
import {
  openCredentialBundle,
  openCustodyBundle,
  sealCredentialBundle,
  sealCustodyBundle,
} from '../../src/lib/executor/custody.mjs'
import { createCredentialCustody, credentialCustodyMode } from '../../src/lib/executor/credential-custody.mjs'

const fixture = JSON.parse(
  fs.readFileSync(new URL('../fixtures/executor-contract/custody.json', import.meta.url), 'utf8'),
)
const KEY = 'custody-test-key'

async function withCustody(mode, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'custody-'))
  const db = createDatabase({ dataDir: dir })
  const vault = createCredentialVault({ db, keyring: loadKeyring({ file: path.join(dir, 'keys.json') }) })
  const warnings = []
  const env = { KIN_CREDENTIAL_CUSTODY: mode, KIN_CODEX_GATEWAY_CREDENTIAL_BUNDLE_KEY: KEY }
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

test('bundle formats match the Worker (shared fixture) in both directions', () => {
  const revisions = {
    credentialRevision: fixture.revisions.credential_revision,
    bpsGeneration: fixture.revisions.bps_generation,
  }
  assert.deepEqual(
    openCustodyBundle(fixture.private_key, fixture.instance_id, fixture.account_id, fixture.custody_bundle, revisions),
    fixture.bundle,
  )
  assert.throws(() =>
    openCustodyBundle(fixture.private_key, fixture.instance_id, fixture.account_id, fixture.custody_bundle),
  )
  assert.deepEqual(
    openCredentialBundle(fixture.bundle_key, fixture.account_id, fixture.credential_bundle),
    fixture.bundle,
  )
  const sealed = sealCustodyBundle(fixture.public_key, 'gw-x', 'acct_y', { refresh_token: 'r' })
  assert.deepEqual(openCustodyBundle(fixture.private_key, 'gw-x', 'acct_y', sealed), { refresh_token: 'r' })
  assert.throws(() => openCustodyBundle(fixture.private_key, 'gw-x', 'acct_other', sealed))
  assert.equal(credentialCustodyMode({}), 'worker')
  assert.equal(credentialCustodyMode({ KIN_CREDENTIAL_CUSTODY: 'CONTROL' }), 'control')
})

test('worker custody passes the shared bundle through and never touches the vault', () =>
  withCustody('worker', async ({ custody, vault }) => {
    const exported = exportedFor('rt_1', { access_token: 'at', refresh_token: 'rt' }, { credential_revision: 1 })
    const fields = await custody.projectionFields({
      instance: { id: 'gw-2', custody_public_key: fixture.public_key },
      runtimeAccountId: 'rt_1',
      accountResourceId: 'acct_1',
      exported,
    })
    assert.deepEqual(fields, { credential_bundle: exported.credential_bundle })
    assert.deepEqual(await vault.list(), [])
    assert.equal((await custody.recordRotation({ grant: 'native' })).skipped, true)
    // 导出账号文件：解开凭据包，字段与旧明文接口一致
    const out = await custody.exportSecrets({ accountResourceId: 'acct_1', runtimeAccountId: 'rt_1', exported })
    assert.deepEqual(out.credentials, {
      access_token: 'at',
      refresh_token: 'rt',
      id_token: '',
      chatgpt_account_id: 'cg-1',
      email: 'a@example.test',
    })
  }))

test('control custody captures by revision, seals per instance and records rotations by CAS', () =>
  withCustody('control', async ({ custody, vault, warnings }) => {
    const instance = {
      id: fixture.instance_id,
      custody_public_key: fixture.public_key,
      capabilities: { custody: true },
    }
    const v1 = exportedFor(
      'rt_1',
      { access_token: 'at1', refresh_token: 'rt1', bps_access_token: 'bat1', bps_refresh_token: 'brt1' },
      { credential_revision: 1, bps: { revision: 1, token_generation: 0 } },
    )
    const fields = await custody.projectionFields({
      instance,
      runtimeAccountId: 'rt_1',
      accountResourceId: 'acct_1',
      exported: v1,
    })
    assert.equal(fields.credential_revision, 1)
    assert.equal(fields.bps.token_generation, 0)
    assert.deepEqual(
      openCustodyBundle(fixture.private_key, fixture.instance_id, 'rt_1', fields.custody_bundle, {
        credentialRevision: 1,
        bpsGeneration: 0,
      }),
      { access_token: 'at1', refresh_token: 'rt1', bps_access_token: 'bat1', bps_refresh_token: 'brt1' },
    )
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
    assert.equal((await rotateNative(0)).code, 'stale_revision')
    assert.deepEqual(await rotateNative(1), { ok: true })
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
    assert.equal((await rotateBps(1, 5)).code, 'stale_revision')
    assert.deepEqual(await rotateBps(1, 0), { ok: true })
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
    // 收录失败、凭据库比来源旧：回退到来源副本，绝不下发“旧令牌 + 新代次”（R3 审查 P1-1）
    const newer = {
      account: { id: 'rt_1', credential_revision: 9, bps: { revision: 1, token_generation: 2 } },
      credential_bundle: sealCredentialBundle('another-key', 'rt_1', { access_token: 'at9', refresh_token: 'rt9' }),
    }
    assert.deepEqual(
      await custody.projectionFields({
        instance,
        runtimeAccountId: 'rt_1',
        accountResourceId: 'acct_1',
        exported: newer,
      }),
      { credential_bundle: newer.credential_bundle },
    )
    // 来源已撤销 BPS：不带凭据库里的 BPS 令牌
    const noBps = exportedFor('rt_1', { access_token: 'at2', refresh_token: 'rt2' }, { credential_revision: 2 })
    const withoutBps = await custody.projectionFields({
      instance,
      runtimeAccountId: 'rt_1',
      accountResourceId: 'acct_1',
      exported: noBps,
    })
    assert.equal(withoutBps.bps, undefined)
    assert.deepEqual(
      openCustodyBundle(fixture.private_key, fixture.instance_id, 'rt_1', withoutBps.custody_bundle, {
        credentialRevision: 2,
      }),
      { access_token: 'at2', refresh_token: 'rt2' },
    )
    // 旧版 Worker（没有 custody 能力）与公钥待确认的实例：回退到共享凭据包并告警
    for (const target of [
      { id: 'gw-old', custody_public_key: fixture.public_key },
      { ...instance, id: 'gw-pending', custody_key_pending: 'x'.repeat(43) },
    ])
      assert.deepEqual(
        Object.keys(
          await custody.projectionFields({
            instance: target,
            runtimeAccountId: 'rt_1',
            accountResourceId: 'acct_1',
            exported: noBps,
          }),
        ),
        ['credential_bundle'],
      )
    assert.ok(warnings.some((line) => line.includes('gw-old')))
    // 导出读凭据库；撤销 BPS 后凭据库里的 BPS 记录一并删除
    const out = await custody.exportSecrets({ accountResourceId: 'acct_1', runtimeAccountId: 'rt_1', exported: stale })
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
    assert.equal(custody.vault().removeSync, undefined)
    assert.equal(await custody.forget('acct_1', 'bps'), 0)
    assert.equal(await custody.forget('acct_1', 'native'), 1)
    assert.equal(await vault.get('acct_1', 'native'), null)
  }))

// 终审 B2：新实例 ID 的首个托管公钥也要管理员确认；只有控制面自己拉起的同机 Worker（公钥从本机数据目录读出）直接固定
test('a new instance custody key waits for confirmation unless it is the supervised local Worker', async () => {
  const { GatewayWorkerRepo } = await import('../../src/lib/gateway-worker/gateway-repo.mjs')
  const { localCustodyIdentity } = await import('../../src/lib/gateway-worker/worker-supervisor.mjs')
  const crypto = await import('node:crypto')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'custody-tofu-'))
  const db = createDatabase({ dataDir: dir })
  try {
    const repo = new GatewayWorkerRepo(db)
    const keyPair = () => {
      const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519')
      return { d: privateKey.export({ format: 'jwk' }).d, x: publicKey.export({ format: 'jwk' }).x }
    }
    const row = (id) =>
      db.prepare('SELECT custody_public_key,custody_key_pending FROM gateway_worker_instances WHERE id=?').get(id)
    await repo.upsertInstance({ id: 'gw-new', base_url: 'http://127.0.0.1:1', health_state: 'healthy' })
    const stranger = keyPair()
    await repo.recordCustodyKey('gw-new', stranger.x)
    assert.deepEqual({ ...row('gw-new') }, { custody_public_key: null, custody_key_pending: stranger.x })
    // 同机托管的 Worker：公钥由控制面从本机数据目录读出
    const local = keyPair()
    const workerDir = path.join(dir, 'codex-gateway')
    fs.mkdirSync(workerDir, { recursive: true })
    fs.writeFileSync(path.join(workerDir, 'custody-key.json'), JSON.stringify({ private_key: local.d }))
    const identity = localCustodyIdentity({ env: { KIN_CODEX_GATEWAY_INSTANCE_ID: 'gw-01' }, root: dir, dataDir: dir })
    assert.deepEqual(identity, { instanceId: 'gw-01', publicKey: local.x })
    await repo.upsertInstance({ id: 'gw-01', base_url: 'http://127.0.0.1:2', health_state: 'healthy' })
    await repo.recordCustodyKey('gw-01', local.x, { trusted: true })
    assert.deepEqual({ ...row('gw-01') }, { custody_public_key: local.x, custody_key_pending: null })
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// 终审 B4、B5：代理地址不进凭据库，投影时取来源当前的代理；control 导出账号文件时先收录，凭据库仍旧时用 Worker 副本
test('control custody takes the proxy from the source and never exports a stale vault copy', () =>
  withCustody('control', async ({ custody, vault }) => {
    const instance = {
      id: fixture.instance_id,
      custody_public_key: fixture.public_key,
      capabilities: { custody: true },
    }
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
    // 改了代理（不提升代次）：投影带来源当前的代理
    const moved = exportedFor(
      'rt_1',
      { access_token: 'at1', refresh_token: 'rt1', proxy_url: 'socks5h://new:2' },
      { credential_revision: 1 },
    )
    const fields = await custody.projectionFields({
      instance,
      runtimeAccountId: 'rt_1',
      accountResourceId: 'acct_1',
      exported: moved,
    })
    assert.equal(
      openCustodyBundle(fixture.private_key, fixture.instance_id, 'rt_1', fields.custody_bundle, {
        credentialRevision: 1,
        bpsGeneration: 0,
      }).proxy_url,
      'socks5h://new:2',
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
