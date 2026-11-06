import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, openDatabase } from '../../src/lib/db/database.mjs'
import {
  buildGatewayHeaders,
  signGatewayResponse,
  verifyGatewayHeaders,
} from '../../src/lib/gateway-worker/gateway-auth.mjs'
import {
  createGatewayInternalReceiptRoute,
  createGatewayInternalRegistrationRoute,
  gatewayInstanceName,
} from '../../src/lib/gateway-worker/gateway-routes.mjs'
import { GatewayWorkerRepo } from '../../src/lib/gateway-worker/gateway-repo.mjs'
import { GatewayWorkerClient } from '../../src/lib/gateway-worker/gateway-client.mjs'
import {
  createInstanceKeyStore,
  instanceKeyStoreFor,
  instanceKeysMode,
  openInstanceSecret,
  sealInstanceSecret,
  unwrapDeliveredSecret,
  validInstanceId,
} from '../../src/lib/gateway-worker/instance-keys.mjs'
import { createWorkerSupervisor } from '../../src/lib/gateway-worker/worker-supervisor.mjs'

const TOKEN = 'shared-route-token'
const ENV_NAMES = [
  'KIN_CODEX_GATEWAY_INTERNAL_TOKEN',
  'KIN_CODEX_GATEWAY_INSTANCE_KEYS',
  'TAPMODELS_DB_SECRET',
  'KIN_DB_SECRET',
  'KIN_CODEX_GATEWAY_INSTANCE_KEY_WRAP',
]

// takeover：用例里先后登记多个实例 ID 时，模拟其他实例已静默（45 秒无心跳）、新实例接替（只支持单个 Worker）。
// 专门验证单 Worker 冲突的用例传 false。
function setup(t, { routeEnv = null, takeover = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instance-keys-'))
  const db = openDatabase({ dataDir: dir })
  const saved = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]))
  process.env.KIN_CODEX_GATEWAY_INTERNAL_TOKEN = TOKEN
  for (const name of [
    'KIN_CODEX_GATEWAY_INSTANCE_KEYS',
    'TAPMODELS_DB_SECRET',
    'KIN_DB_SECRET',
    'KIN_CODEX_GATEWAY_INSTANCE_KEY_WRAP',
  ])
    delete process.env[name]
  t.after(async () => {
    await closeDatabase()
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    fs.rmSync(dir, { recursive: true, force: true })
  })
  db.exec('PRAGMA foreign_keys=OFF')
  let rawReads = 0
  const json = (res, status, body) => Object.assign(res, { status, body })
  const readers = {
    json,
    readBody: async () => ({}),
    readRawBody: async (req) => {
      rawReads += 1
      return Buffer.from(req.raw)
    },
  }
  const register = createGatewayInternalRegistrationRoute({ ...readers, ...(routeEnv ? { env: routeEnv } : {}) })
  const receipts = createGatewayInternalReceiptRoute(readers)
  // auth：{ key: { key_id, secret }, instance } 用实例密钥（v2）签名；否则用共用令牌
  const call = async (
    body,
    {
      url = '/internal/v1/gateway/workers/register',
      auth = null,
      token = TOKEN,
      headers: extra = {},
      method = 'POST',
    } = {},
  ) => {
    const raw = JSON.stringify(body)
    const target = new URL(url, 'http://cp')
    if (takeover && body?.id && target.pathname === '/internal/v1/gateway/workers/register')
      db.prepare('UPDATE gateway_worker_instances SET last_heartbeat_at=? WHERE id<>?').run(
        new Date(Date.now() - 120_000).toISOString(),
        String(body.id),
      )
    const headers = auth
      ? buildGatewayHeaders({
          secret: auth.key.secret,
          body: raw,
          keyId: auth.key.key_id,
          instanceId: auth.instance,
          method,
          path: `${target.pathname}${target.search}`,
        })
      : { ...buildGatewayHeaders({ secret: token, body: raw }), 'x-kin-gateway-token': token }
    Object.assign(headers, extra)
    const res = {}
    const handler = target.pathname === '/internal/v1/gateway/receipts' ? receipts : register
    await handler({ method, headers, raw, socket: {} }, res, target)
    res.nonce = headers['x-kin-gateway-nonce']
    res.target = `${target.pathname}${target.search}`
    return res
  }
  const heartbeat = (id, extra = {}) => ({
    id,
    base_url: 'http://127.0.0.1:1',
    health_state: 'healthy',
    instance_key_support: 1,
    ...extra,
  })
  // 校验响应签名并解开下发的新密钥（Worker 的做法）
  const verifiedResponse = (res, holder) => {
    const text = JSON.stringify(res.body)
    const expected = signGatewayResponse({
      secret: holder,
      status: res.status,
      path: res.target,
      nonce: res.nonce,
      text,
    })
    return res.headers?.['x-kin-gateway-response-signature'] === expected.signature
  }
  const unwrap = (res, holder) => {
    const delivered = res.body.instance_key
    assert.ok(delivered, JSON.stringify(res.body))
    assert.equal(delivered.secret, undefined, 'new keys are never sent in plaintext')
    assert.ok(verifiedResponse(res, holder), 'the response carrying a key is signed with the holder secret')
    return {
      key_id: delivered.key_id,
      secret: unwrapDeliveredSecret(
        holder,
        { instanceId: delivered.instance_id, keyId: delivered.key_id, nonce: res.nonce },
        delivered.wrapped,
      ),
    }
  }
  const keys = instanceKeyStoreFor(db)
  // 管理员允许引导后用共用令牌引导，Worker 第一次用密钥心跳确认
  const enroll = async (id, extra = {}) => {
    await keys.allowBootstrap(id, { actor: 'admin' })
    const key = unwrap(await call(heartbeat(id, extra)), TOKEN)
    const confirmed = await call(heartbeat(id, extra), { auth: { key, instance: id } })
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body))
    return key
  }
  const audits = () =>
    db
      .prepare("SELECT action FROM operation_audit WHERE action LIKE 'gateway.instance_key.%' ORDER BY rowid")
      .all()
      .map((entry) => entry.action)
  return {
    db,
    dir,
    call,
    heartbeat,
    keys,
    repo: new GatewayWorkerRepo(db),
    unwrap,
    verifiedResponse,
    enroll,
    audits,
    rawReads: () => rawReads,
  }
}

// 托管器替身：拉起“子进程”时记下传入的一次性引导令牌
function fakeSupervisor(dir, instanceId) {
  const bin = path.join(dir, 'kin-codex-gateway')
  fs.writeFileSync(bin, '')
  const spawned = []
  const supervisor = createWorkerSupervisor({
    env: {
      KIN_CODEX_GATEWAY_SUPERVISE: '1',
      KIN_CODEX_GATEWAY_INSTANCE_ID: instanceId,
      KIN_CODEX_GATEWAY_INTERNAL_TOKEN: TOKEN,
      KIN_CODEX_GATEWAY_BIN: bin,
    },
    root: dir,
    dataDir: path.join(dir, 'cp-data'),
    log: {},
    spawnImpl: (_bin, _args, { env }) => {
      const proc = Object.assign(new EventEmitter(), { pid: 4242, kill() {} })
      spawned.push({ proc, token: env.KIN_CODEX_GATEWAY_BOOTSTRAP_TOKEN })
      return proc
    },
  })
  return { supervisor, spawned }
}

test('instance secrets are sealed with an AAD bound to the instance and key id, never with the shared token', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ik-seal-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const env = { KIN_CODEX_GATEWAY_INTERNAL_TOKEN: 'tok', KIN_DATA_DIR: dir }
  const sealed = sealInstanceSecret('gw-1', 'ik_1', 'a'.repeat(64), env)
  assert.match(sealed, /^ik1:wrap:/)
  assert.equal(sealed.includes('a'.repeat(16)), false)
  // 包裹用的独立随机值写进 runtime-secrets.json（0600），与共用令牌无关
  const secrets = JSON.parse(fs.readFileSync(path.join(dir, 'runtime-secrets.json'), 'utf8'))
  assert.match(secrets.KIN_CODEX_GATEWAY_INSTANCE_KEY_WRAP, /^[0-9a-f]{64}$/)
  assert.equal((fs.statSync(path.join(dir, 'runtime-secrets.json')).mode & 0o777).toString(8), '600')
  assert.equal(
    openInstanceSecret('gw-1', 'ik_1', sealed, { KIN_DATA_DIR: dir }),
    'a'.repeat(64),
    'the shared token is not needed',
  )
  assert.throws(() => openInstanceSecret('gw-2', 'ik_1', sealed, env))
  assert.throws(() => openInstanceSecret('gw-1', 'ik_2', sealed, env))
  assert.throws(() => openInstanceSecret('gw-1', 'ik_1', sealed, { KIN_CODEX_GATEWAY_INSTANCE_KEY_WRAP: 'other' }))
  const withDb = sealInstanceSecret('gw-1', 'ik_1', 'b'.repeat(64), { ...env, TAPMODELS_DB_SECRET: 'dbs' })
  assert.match(withDb, /^ik1:db:/)
  assert.equal(openInstanceSecret('gw-1', 'ik_1', withDb, { TAPMODELS_DB_SECRET: 'dbs' }), 'b'.repeat(64))
  assert.deepEqual(
    ['', 'off', 'ON', ' required ', 'bogus'].map((value) =>
      instanceKeysMode({ KIN_CODEX_GATEWAY_INSTANCE_KEYS: value }),
    ),
    ['on', 'off', 'on', 'required', 'on'],
  )
  assert.deepEqual(
    ['gw-01', 'gw_127.0.0.1_8790', 'a', '-gw', 'gw 1', 'gw/1', 'x'.repeat(65), ' gw'].map(validInstanceId),
    [true, true, true, false, false, false, false, false],
  )
  assert.equal(gatewayInstanceName('  Worker A ', 'gw-1'), 'Worker A')
  assert.equal(gatewayInstanceName('gw-01‮<script>', 'gw-1'), 'gw-1')
  assert.equal(gatewayInstanceName('x'.repeat(65), 'gw-1'), 'gw-1')
})

test('without a bootstrap authorization the shared token never issues or revokes keys', async (t) => {
  const { call, heartbeat, keys, audits } = setup(t)
  // on：照旧以共用令牌接受注册，不签发，提示需要授权
  // 新实例 ID 以待批准登记（复审 P1-1）
  const first = await call(heartbeat('gw-1'))
  assert.equal(first.status, 200, JSON.stringify(first.body))
  assert.equal(first.body.instance_key, undefined)
  assert.equal(first.body.instance_key_status, 'instance_pending_approval')
  // 旧版 Worker（不声明支持）照旧
  const legacy = await call(heartbeat('gw-old', { instance_key_support: undefined }))
  assert.deepEqual([legacy.status, legacy.body.instance_key_status], [200, 'instance_pending_approval'])
  // required：没有授权一律拒绝
  process.env.KIN_CODEX_GATEWAY_INSTANCE_KEYS = 'required'
  const denied = await call(heartbeat('gw-1'))
  assert.deepEqual([denied.status, denied.body.error.code], [401, 'instance_key_bootstrap_not_allowed'])
  assert.deepEqual(audits(), [])
  assert.equal(await keys.hasLiveKey('gw-1'), false)
})

test('an administrator grant allows exactly one bootstrap; the key is wrapped, signed and confirmed only after use', async (t) => {
  const { db, call, heartbeat, keys, unwrap, verifiedResponse, audits } = setup(t)
  const grant = await keys.allowBootstrap('gw-1', { actor: 'admin' })
  assert.ok(Date.parse(grant.expires_at) > Date.now())
  const first = await call(heartbeat('gw-1'))
  assert.equal(first.status, 200, JSON.stringify(first.body))
  assert.equal(first.headers['x-kin-gateway-response-key'], 'shared')
  const key = unwrap(first, TOKEN)
  assert.match(key.secret, /^[0-9a-f]{64}$/)
  const row = db.prepare('SELECT * FROM gateway_worker_instance_keys WHERE key_id=?').get(key.key_id)
  assert.equal(row.confirmed_at, null)
  assert.equal(JSON.stringify(row).includes(key.secret), false)
  // 授权用过即作废：再次以共用令牌注册既不签发、也不能改写这个实例（R1：抢先心跳改派发地址）
  const again = await call(heartbeat('gw-1', { base_url: 'http://attacker:1' }))
  assert.deepEqual([again.status, again.body.error?.code], [401, 'instance_key_required'])
  assert.equal(
    db.prepare('SELECT base_url FROM gateway_worker_instances WHERE id=?').get('gw-1').base_url,
    'http://127.0.0.1:1',
  )
  assert.equal(await keys.signingKey('gw-1'), null, 'unconfirmed keys are not used for outbound calls')
  const auth = { key, instance: 'gw-1' }
  const used = await call(heartbeat('gw-1'), { auth })
  assert.equal(used.status, 200, JSON.stringify(used.body))
  assert.ok(verifiedResponse(used, key.secret), 'responses to key-signed requests are signed with that key')
  assert.equal(used.headers['x-kin-gateway-response-key'], key.key_id)
  assert.ok(
    db.prepare('SELECT confirmed_at FROM gateway_worker_instance_keys WHERE key_id=?').get(key.key_id).confirmed_at,
  )
  assert.equal((await keys.signingKey('gw-1')).keyId, key.key_id)
  assert.deepEqual(audits(), ['gateway.instance_key.bootstrap_allowed', 'gateway.instance_key.issued'])

  // 冒充：注册、租约、回执一律被拒
  for (const [body, url] of [
    [heartbeat('gw-1'), undefined],
    [
      { instance_id: 'gw-1', runtime_account_id: 'rt', grant: 'native', credential_revision: 1 },
      '/internal/v1/gateway/workers/credentials/lease',
    ],
    [{ gateway_instance_id: 'gw-1', dispatch_id: 'd' }, '/internal/v1/gateway/receipts'],
  ]) {
    const res = await call(body, { url })
    assert.deepEqual([res.status, res.body.error.code], [401, 'instance_key_required'], url)
  }
  // 实例密钥不能代表别的实例；签名不符被拒
  const crossed = await call(heartbeat('gw-2'), { auth })
  assert.deepEqual([crossed.status, crossed.body.error.code], [403, 'instance_mismatch'])
  const forged = await call(heartbeat('gw-1'), { auth: { key: { ...key, secret: 'f'.repeat(64) }, instance: 'gw-1' } })
  assert.deepEqual([forged.status, forged.body.error.code], [401, 'instance_key_invalid'])
  // v2 签名串覆盖请求目标：心跳的签名不能改投到租约接口
  const raw = JSON.stringify(heartbeat('gw-1'))
  const headers = buildGatewayHeaders({
    secret: key.secret,
    body: raw,
    keyId: key.key_id,
    instanceId: 'gw-1',
    method: 'POST',
    path: '/internal/v1/gateway/workers/register',
  })
  const res = {}
  await createGatewayInternalRegistrationRoute({
    json: (r, status, body) => Object.assign(r, { status, body }),
    readBody: async () => ({}),
    readRawBody: async (req) => Buffer.from(req.raw),
  })({ method: 'POST', headers, raw, socket: {} }, res, new URL('http://cp/internal/v1/gateway/workers/heartbeat'))
  assert.deepEqual([res.status, res.body.error.code], [401, 'instance_key_invalid'])
  // 实例密钥签名的租约请求照常处理（实例存在，账号未绑定时返回 404）
  const keyedLease = await call(
    { instance_id: 'gw-1', runtime_account_id: 'rt', grant: 'native', credential_revision: 1 },
    { url: '/internal/v1/gateway/workers/credentials/lease', auth },
  )
  assert.equal(keyedLease.status, 404, JSON.stringify(keyedLease.body))
})

test('a supervised Worker bootstraps once with its one-time token; a supervisor without a running child grants nothing', async (t) => {
  const { dir, call, heartbeat, keys, unwrap } = setup(t)
  const { supervisor, spawned } = fakeSupervisor(dir, 'gw-sup')
  // 托管器存在但还没拉起子进程（例如二进制缺失）：没有引导令牌（审查 R4）
  const early = await call(heartbeat('gw-sup', { bootstrap_token: 'guess' }))
  assert.equal(early.body.instance_key, undefined)
  supervisor.reconcile()
  assert.equal(spawned.length, 1)
  const token = spawned[0].token
  assert.match(token, /^[0-9a-f]{64}$/)
  // 令牌只对托管的实例 ID 有效；错的令牌不签发
  assert.equal((await call(heartbeat('gw-other', { bootstrap_token: token }))).body.instance_key, undefined)
  assert.equal((await call(heartbeat('gw-sup', { bootstrap_token: 'f'.repeat(64) }))).body.instance_key, undefined)
  const issued = await call(heartbeat('gw-sup', { bootstrap_token: token }))
  assert.equal(issued.headers['x-kin-gateway-response-key'], 'bootstrap')
  const key = unwrap(issued, token)
  // 响应丢失或 Worker 落盘失败（复审 P1-2）：同一令牌在它签发的密钥确认之前可以重新引导，旧的待确认密钥被吊销
  const retried = await call(heartbeat('gw-sup', { bootstrap_token: token }))
  const retriedKey = unwrap(retried, token)
  assert.notEqual(retriedKey.key_id, key.key_id)
  const stale = await call(heartbeat('gw-sup'), { auth: { key, instance: 'gw-sup' } })
  assert.deepEqual([stale.status, stale.body.error.code], [401, 'instance_key_invalid'])
  assert.equal((await call(heartbeat('gw-sup'), { auth: { key: retriedKey, instance: 'gw-sup' } })).status, 200)
  // 确认之后同一令牌不能再用
  const replay = await call(heartbeat('gw-sup', { bootstrap_token: token }))
  assert.equal(replay.status, 401)
  assert.equal(replay.body.instance_key, undefined)
  // 数据目录丢失的托管 Worker 也不能靠共用令牌重新引导（R4 的豁免已删除）
  assert.equal((await call(heartbeat('gw-sup'))).status, 401)
  // 子进程重启：新令牌，但已有已确认的密钥时拒绝签发
  spawned[0].proc.emit('exit', 1, null)
  supervisor.reconcile()
  await new Promise((resolve) => setTimeout(resolve, 1100))
  supervisor.reconcile()
  const restarted = spawned.at(-1)
  assert.notEqual(restarted.token, token)
  const refused = await call(heartbeat('gw-sup', { bootstrap_token: restarted.token }))
  assert.deepEqual([refused.status, refused.body.error.code], [401, 'instance_key_required'])
  assert.equal((await keys.signingKey('gw-sup')).keyId, retriedKey.key_id)
  // 管理员吊销后，新子进程的令牌可以重新引导
  await keys.revoke('gw-sup', { actor: 'admin' })
  const rebooted = await call(heartbeat('gw-sup', { bootstrap_token: restarted.token }))
  assert.ok(unwrap(rebooted, restarted.token).key_id)
  supervisor.stop()
})

test('revocation closes bootstrap until a new grant; rotation keeps both keys for the grace period', async (t) => {
  const { db, call, heartbeat, keys, unwrap, verifiedResponse, enroll, audits } = setup(t)
  const issued = await enroll('gw-1')
  const oldAuth = { key: issued, instance: 'gw-1' }
  const rotated = await keys.rotate('gw-1', { actor: 'tester', graceMs: 400 })
  assert.equal(rotated.previous_key_id, issued.key_id)
  assert.equal((await keys.signingKey('gw-1')).keyId, issued.key_id)
  // 下一次心跳（旧密钥签名）拿到用旧密钥包裹的新密钥（持有旧密钥的一方同样能拿到：轮换不能处置泄露）
  const next = await call(heartbeat('gw-1'), { auth: oldAuth })
  const delivered = unwrap(next, issued.secret)
  assert.equal(delivered.key_id, rotated.key_id)
  assert.equal(next.body.instance_key.previous_expires_at, rotated.previous_expires_at)
  const newAuth = { key: delivered, instance: 'gw-1' }
  assert.equal((await call(heartbeat('gw-1'), { auth: newAuth })).status, 200)
  assert.equal((await call(heartbeat('gw-1'), { auth: oldAuth })).status, 200)
  assert.equal((await keys.signingKey('gw-1')).keyId, delivered.key_id)
  await new Promise((resolve) => setTimeout(resolve, 450))
  const expired = await call(heartbeat('gw-1'), { auth: oldAuth })
  assert.deepEqual([expired.status, expired.body.error.code], [401, 'instance_key_invalid'])
  assert.ok(verifiedResponse(expired, issued.secret), 'the rejection is signed with the rejected key')

  // 吊销：立即失效（与未知密钥同一个错误码）；之后共用令牌不能重新引导（R2）
  await keys.revoke('gw-1', { actor: 'tester' })
  const revoked = await call(heartbeat('gw-1'), { auth: newAuth })
  assert.deepEqual([revoked.status, revoked.body.error.code], [401, 'instance_key_invalid'])
  assert.ok(verifiedResponse(revoked, delivered.secret))
  const unknown = await call(heartbeat('gw-1'), {
    auth: { key: { key_id: 'ik_nope', secret: 'x'.repeat(64) }, instance: 'gw-1' },
  })
  assert.deepEqual([unknown.status, unknown.body.error.code], [401, 'instance_key_invalid'])
  assert.equal(unknown.headers, undefined, 'unknown keys cannot sign the rejection')
  assert.equal(await keys.signingKey('gw-1'), null)
  const reopened = await call(heartbeat('gw-1'))
  assert.equal(reopened.body.instance_key, undefined, 'revocation does not reopen bootstrap')
  // 重新授权后才能再引导
  await keys.allowBootstrap('gw-1', { actor: 'admin' })
  assert.ok(unwrap(await call(heartbeat('gw-1')), TOKEN).key_id)
  assert.deepEqual(audits(), [
    'gateway.instance_key.bootstrap_allowed',
    'gateway.instance_key.issued',
    'gateway.instance_key.rotated',
    'gateway.instance_key.revoked',
    'gateway.instance_key.bootstrap_allowed',
    'gateway.instance_key.issued',
  ])
  assert.equal(await keys.rotate('gw-none'), null)
  assert.ok(db)
})

test('bootstrap re-checks inside its transaction: a confirmed key is never replaced (R7)', async (t) => {
  const { db, call, heartbeat, keys } = setup(t)
  await keys.allowBootstrap('gw-r', { actor: 'admin' })
  const issued = await call(heartbeat('gw-r'))
  const nonce = issued.nonce
  const key = {
    key_id: issued.body.instance_key.key_id,
    secret: unwrapDeliveredSecret(
      TOKEN,
      { instanceId: 'gw-r', keyId: issued.body.instance_key.key_id, nonce },
      issued.body.instance_key.wrapped,
    ),
  }
  // 竞争者在授权检查之后、签发之前被插队：合法 Worker 已确认
  await keys.allowBootstrap('gw-r', { actor: 'admin' })
  assert.equal((await call(heartbeat('gw-r'), { auth: { key, instance: 'gw-r' } })).status, 200)
  const raced = await keys.bootstrap('gw-r', { authorization: { kind: 'grant' } })
  assert.deepEqual(raced, { ok: false, code: 'instance_key_already_issued' })
  assert.ok(
    db.prepare('SELECT 1 FROM gateway_worker_bootstrap_grants WHERE instance_id=? AND consumed_at IS NULL').get('gw-r'),
    'the grant is not consumed',
  )
  assert.equal(
    (await call(heartbeat('gw-r'), { auth: { key, instance: 'gw-r' } })).status,
    200,
    'the confirmed key survives',
  )
  // 已消耗的托管令牌不能再用；授权消耗失败时不吊销待确认的密钥
  const consumed = { kind: 'supervisor', allowed: () => false }
  await keys.revoke('gw-r')
  await keys.allowBootstrap('gw-p', { actor: 'admin' })
  const pending = await call(heartbeat('gw-p'))
  assert.ok(pending.body.instance_key)
  assert.deepEqual(await keys.bootstrap('gw-p', { authorization: consumed }), {
    ok: false,
    code: 'instance_key_bootstrap_not_allowed',
  })
  assert.equal(await keys.hasLiveKey('gw-p'), true)
})

test('receipts can only update the dispatches of the authenticated instance (P0-4)', async (t) => {
  const { db, call, heartbeat, repo, enroll } = setup(t)
  const kv = await enroll('gw-v')
  const kx = await enroll('gw-x')
  const dispatchId = await repo.createDispatch({
    requestId: 'req1',
    instanceId: 'gw-v',
    nonce: 'n',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  })
  db.prepare(
    `INSERT INTO usage_logs(id,request_id,created_at,execution_kind,gateway_instance_id,dispatch_id,final_state,billing_status,status,model,input_tokens,output_tokens)
     VALUES('log1','req1',?,'gateway_worker','gw-v',?,'ambiguous','pending',200,'gpt-5',10,10)`,
  ).run(new Date().toISOString(), dispatchId)
  const forgedUsage = {
    request_id: 'req1',
    dispatch_id: dispatchId,
    terminal_state: 'completed',
    usage: { input_tokens: 999999, output_tokens: 999999 },
    usage_confidence: 'complete',
  }
  // 共用令牌以未签发实例名义
  const shared = await call({ ...forgedUsage, gateway_instance_id: 'evil' }, { url: '/internal/v1/gateway/receipts' })
  assert.deepEqual([shared.status, shared.body.error.code], [403, 'receipt_instance_mismatch'])
  // 另一个实例的实例密钥
  const other = await call(
    { ...forgedUsage, gateway_instance_id: 'gw-x', terminal_state: 'cancelled' },
    { url: '/internal/v1/gateway/receipts', auth: { key: kx, instance: 'gw-x' } },
  )
  assert.deepEqual([other.status, other.body.error.code], [403, 'receipt_instance_mismatch'])
  assert.equal(
    db.prepare('SELECT status FROM gateway_worker_dispatches WHERE dispatch_id=?').get(dispatchId).status,
    'created',
  )
  assert.deepEqual(
    { ...db.prepare("SELECT gateway_instance_id,input_tokens,output_tokens FROM usage_logs WHERE id='log1'").get() },
    { gateway_instance_id: 'gw-v', input_tokens: 10, output_tokens: 10 },
  )
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM gateway_worker_receipts').get().n, 0)
  // 所属实例自己的回执照常入账
  const own = await call(
    { ...forgedUsage, gateway_instance_id: 'gw-v', usage: { input_tokens: 12, output_tokens: 3 } },
    { url: '/internal/v1/gateway/receipts', auth: { key: kv, instance: 'gw-v' } },
  )
  assert.equal(own.status, 200, JSON.stringify(own.body))
  assert.equal(
    db.prepare('SELECT status FROM gateway_worker_dispatches WHERE dispatch_id=?').get(dispatchId).status,
    'completed',
  )
  assert.ok(heartbeat)
})

test('KIN_CODEX_GATEWAY_INSTANCE_KEYS off / on / required', async (t) => {
  const { call, heartbeat, keys, enroll } = setup(t)
  const key = await enroll('gw-1')
  const auth = { key, instance: 'gw-1' }
  // off：不签发新密钥，共用令牌对已签发实例也有效，已有密钥照常校验
  process.env.KIN_CODEX_GATEWAY_INSTANCE_KEYS = 'off'
  assert.equal((await call(heartbeat('gw-1'))).status, 200)
  await keys.allowBootstrap('gw-2', { actor: 'admin' })
  const offNew = await call(heartbeat('gw-2'))
  assert.deepEqual([offNew.status, offNew.body.instance_key], [200, undefined])
  assert.equal((await call(heartbeat('gw-1'), { auth })).status, 200)
  // required：共用令牌只能用于有授权的引导
  process.env.KIN_CODEX_GATEWAY_INSTANCE_KEYS = 'required'
  const legacy = await call(heartbeat('gw-3', { instance_key_support: undefined }))
  assert.deepEqual([legacy.status, legacy.body.error.code], [401, 'instance_key_bootstrap_not_allowed'])
  await keys.allowBootstrap('gw-3', { actor: 'admin' })
  assert.ok((await call(heartbeat('gw-3'))).body.instance_key)
  const lease = await call(
    { instance_id: 'gw-4', runtime_account_id: 'rt', grant: 'native', credential_revision: 1 },
    { url: '/internal/v1/gateway/workers/credentials/lease' },
  )
  assert.deepEqual([lease.status, lease.body.error.code], [401, 'instance_key_bootstrap_not_allowed'])
  assert.equal((await call(heartbeat('gw-1'))).status, 401, 'issued instances still need their key')
  assert.equal((await call(heartbeat('gw-1'), { auth })).status, 200)
  // on（默认）：未登记的实例不能申请租约（待批准的实例见专门的用例）
  delete process.env.KIN_CODEX_GATEWAY_INSTANCE_KEYS
  const lease4 = await call(
    { instance_id: 'gw-4', runtime_account_id: 'rt', grant: 'native', credential_revision: 1 },
    { url: '/internal/v1/gateway/workers/credentials/lease' },
  )
  assert.deepEqual([lease4.status, lease4.body.error.code], [404, 'gateway_instance_not_found'])
})

test('prefilter and instance id validation', async (t) => {
  const routeEnv = { ...process.env, KIN_CODEX_GATEWAY_INTERNAL_TOKEN: TOKEN }
  const { db, call, heartbeat, keys, unwrap, rawReads } = setup(t, { routeEnv })
  routeEnv.KIN_CODEX_GATEWAY_INTERNAL_TOKEN = TOKEN
  // 只带 key 头、没有完整签名头：不读正文
  const before = rawReads()
  const bare = await call(heartbeat('gw-1'), { headers: { 'x-kin-gateway-signature': '' } })
  assert.equal(bare.status, 401)
  const onlyKey = {}
  await createGatewayInternalRegistrationRoute({
    json: (r, status, body) => Object.assign(r, { status, body }),
    readBody: async () => ({}),
    readRawBody: async () => assert.fail('body read'),
  })(
    {
      method: 'POST',
      headers: { 'x-kin-gateway-key': 'ik_x', 'x-kin-gateway-instance': 'gw-1' },
      raw: '{}',
      socket: {},
    },
    onlyKey,
    new URL('http://cp/internal/v1/gateway/workers/register'),
  )
  assert.equal(onlyKey.status, 401)
  assert.equal(rawReads(), before)
  const badId = await call(heartbeat('gw 1'))
  assert.deepEqual([badId.status, badId.body.error.code], [400, 'invalid_instance_id'])
  // 显示名不合法时用实例 ID
  await call(heartbeat('gw-n', { name: 'gw-01‮', instance_key_support: undefined }))
  assert.equal(db.prepare('SELECT name FROM gateway_worker_instances WHERE id=?').get('gw-n').name, 'gw-n')
})

test('the control plane signs requests to a Worker with the confirmed instance key (v2 covers method and path)', async (t) => {
  const { call, heartbeat, keys, repo, unwrap } = setup(t)
  const seen = []
  let workerKey = null
  const worker = http.createServer((req, res) => {
    const instance = req.headers['x-kin-gateway-instance']
    const verified =
      workerKey && instance
        ? verifyGatewayHeaders({
            secret: workerKey.secret,
            headers: req.headers,
            body: '',
            method: req.method,
            path: req.url,
          }).ok
        : null
    seen.push({ key: req.headers['x-kin-gateway-key'], instance, verified })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, health_state: 'healthy' }))
  })
  await new Promise((resolve) => worker.listen(0, '127.0.0.1', resolve))
  t.after(() => worker.close())
  const base = `http://127.0.0.1:${worker.address().port}`
  await keys.allowBootstrap('gw-1', { actor: 'admin' })
  workerKey = unwrap(await call(heartbeat('gw-1', { base_url: base })), TOKEN)
  const client = new GatewayWorkerClient({ repo, secret: TOKEN })
  await client.health('gw-1')
  assert.deepEqual(
    seen.at(-1),
    { key: 'default', instance: undefined, verified: null },
    'unconfirmed key: shared token',
  )
  await call(heartbeat('gw-1', { base_url: base }), { auth: { key: workerKey, instance: 'gw-1' } })
  await client.health('gw-1')
  assert.deepEqual(seen.at(-1), { key: workerKey.key_id, instance: 'gw-1', verified: true })
})

test('an instance key store with an injected clock expires retiring keys', async (t) => {
  const { db } = setup(t)
  let clock = Date.parse('2026-11-06T00:00:00Z')
  const keys = createInstanceKeyStore({ db, now: () => clock })
  await keys.allowBootstrap('gw-c', { actor: 'admin' })
  const issued = await keys.bootstrap('gw-c', { authorization: { kind: 'grant' } })
  assert.equal(issued.ok, true)
  const verifyHeaders = ({ secret }) => ({ ok: secret === issued.secret, nonce: 'n' })
  assert.equal((await keys.verify({ instanceId: 'gw-c', keyId: issued.key_id, verifyHeaders })).ok, true)
  assert.equal(await keys.issued('gw-c'), false, 'verification alone does not confirm')
  await keys.confirm('gw-c', issued.key_id)
  assert.equal(await keys.issued('gw-c'), true)
  const rotated = await keys.rotate('gw-c', { graceMs: 600_000 })
  assert.equal(rotated.previous_expires_at, '2026-11-06T00:10:00.000Z')
  clock += 599_000
  assert.equal((await keys.verify({ instanceId: 'gw-c', keyId: issued.key_id, verifyHeaders })).ok, true)
  clock += 2_000
  // 宽限期已过、新密钥还没被用过：续接窗口内只允许换取新密钥（复审 P2-7）
  const renew = await keys.verify({ instanceId: 'gw-c', keyId: issued.key_id, verifyHeaders })
  assert.deepEqual([renew.ok, renew.renewOnly], [true, true])
  clock += 24 * 3600_000
  const expired = await keys.verify({ instanceId: 'gw-c', keyId: issued.key_id, verifyHeaders })
  assert.deepEqual([expired.code, expired.reason], ['instance_key_invalid', 'expired'])
  // 授权窗口按时钟过期
  await keys.allowBootstrap('gw-d', { actor: 'admin', windowMs: 1000 })
  clock += 2_000
  assert.equal(await keys.bootstrapGrant('gw-d'), undefined)
  assert.deepEqual(await keys.bootstrap('gw-d', { authorization: { kind: 'grant' } }), {
    ok: false,
    code: 'instance_key_bootstrap_not_allowed',
  })
})

test('new instance IDs registered with the shared token stay pending: no policy, freezes, leases or receipts (P1-1)', async (t) => {
  const { db, call, heartbeat, keys, repo, enroll, unwrap } = setup(t)
  const k01 = await enroll('gw-01')
  // 升级过渡：已登记、没有实例密钥的旧实例照旧工作（拿到策略）
  await repo.upsertInstance({ id: 'gw-old', base_url: 'http://127.0.0.1:2', health_state: 'healthy' })
  const old = await call(heartbeat('gw-old', { instance_key_support: undefined }))
  assert.equal(old.status, 200)
  assert.ok(old.body.policy, 'existing instances keep receiving the policy')
  // 新实例 evil：待批准，不下发策略、不采信冻结
  await repo.recordAccountBinding({
    accountResourceId: 'acc1',
    instanceId: 'gw-01',
    runtimeAccountId: 'rt1',
    status: 'synced',
  })
  await repo.recordAccountBinding({
    accountResourceId: 'acc1',
    instanceId: 'evil',
    runtimeAccountId: 'rt1',
    status: 'drifted',
  })
  const evil = await call(
    heartbeat('evil', {
      base_url: 'http://attacker:1',
      drain_state: 'draining',
      protection_freezes: [
        { account_id: 'rt1', frozen_until: new Date(Date.now() + 86400_000).toISOString(), reason: 'evil' },
      ],
    }),
  )
  assert.deepEqual(
    [evil.status, evil.body.instance_key_status, evil.body.policy],
    [200, 'instance_pending_approval', undefined],
  )
  // 待批准实例上报的事实直读状态不采信（第三轮复审 P1-B）
  await call(heartbeat('evil', { base_url: 'http://attacker:1', facts: { mode: 'shadow', status: { accounts: 9 } } }))
  assert.equal(db.prepare("SELECT facts_json FROM gateway_worker_instances WHERE id='evil'").get().facts_json, null)
  assert.equal((await repo.getInstance('evil')).approval_state, 'pending')
  const hb = await call(heartbeat('gw-01'), { auth: { key: k01, instance: 'gw-01' } })
  assert.equal(hb.status, 200)
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM gateway_account_freezes WHERE source_instance_id='evil'").get().n,
    0,
  )
  assert.equal(
    await repo.pickInstance({ exclude: new Set(['gw-01', 'gw-old']) }),
    null,
    'pending instances are never dispatched to',
  )
  const lease = await call(
    { instance_id: 'evil', runtime_account_id: 'rt1', grant: 'native', credential_revision: 1 },
    { url: '/internal/v1/gateway/workers/credentials/lease' },
  )
  assert.deepEqual([lease.status, lease.body.error.code], [403, 'instance_pending_approval'])
  const receipt = await call(
    { gateway_instance_id: 'evil', dispatch_id: 'd' },
    { url: '/internal/v1/gateway/receipts' },
  )
  assert.deepEqual([receipt.status, receipt.body.error.code], [403, 'instance_pending_approval'])
  // 批准（允许引导）后完成引导即准入
  await keys.allowBootstrap('evil', { actor: 'admin' })
  await repo.admitPendingInstance('evil')
  const key = unwrap(await call(heartbeat('evil')), TOKEN)
  assert.equal((await call(heartbeat('evil'), { auth: { key, instance: 'evil' } })).status, 200)
  assert.equal((await repo.getInstance('evil')).approval_state, null)
})

test('single Worker mode rejects a new instance ID even when it reports draining (P1-1)', async (t) => {
  const { call, heartbeat, enroll } = setup(t, { takeover: false })
  await enroll('gw-01')
  for (const extra of [{}, { drain_state: 'draining' }, { health_state: 'unhealthy' }]) {
    const res = await call(heartbeat('evil', { base_url: 'http://attacker:1', ...extra }))
    assert.deepEqual([res.status, res.body.error?.code], [409, 'gateway_single_worker'], JSON.stringify(extra))
  }
})

test('single Worker mode: a pending first instance still blocks further new IDs (N2)', async (t) => {
  const { call, heartbeat, repo } = setup(t, { takeover: false })
  assert.equal((await call(heartbeat('gw-01'))).status, 200)
  assert.equal((await repo.getInstance('gw-01')).approval_state, 'pending')
  for (const extra of [{}, { drain_state: 'draining' }]) {
    const res = await call(heartbeat('evil', { base_url: 'http://attacker:1', ...extra }))
    assert.deepEqual([res.status, res.body.error?.code], [409, 'gateway_single_worker'], JSON.stringify(extra))
  }
  assert.equal(await repo.getInstance('evil'), null)
})

test('the loser of a bootstrap race writes nothing (P2-1)', async (t) => {
  const { call, heartbeat, keys, repo } = setup(t)
  await repo.upsertInstance({ id: 'gw-n', base_url: 'http://legit:1', health_state: 'healthy' })
  await keys.allowBootstrap('gw-n', { actor: 'admin' })
  const [legit, evil] = await Promise.all([
    call(heartbeat('gw-n', { base_url: 'http://legit:1' })),
    call(heartbeat('gw-n', { base_url: 'http://attacker:1', name: 'evil' })),
  ])
  const winners = [legit, evil].filter((res) => res.body.instance_key)
  assert.equal(winners.length, 1)
  const loser = [legit, evil].find((res) => !res.body.instance_key)
  assert.equal(loser.status, 401)
  assert.equal((await repo.getInstance('gw-n')).base_url, winners[0] === legit ? 'http://legit:1' : 'http://attacker:1')
})

test('prefilter rejects unknown key ids before reading the body and hides whether a key exists (P2-5)', async (t) => {
  const { call, heartbeat, enroll, rawReads } = setup(t)
  const key = await enroll('gw-1')
  const before = rawReads()
  const unknown = await call(heartbeat('gw-1'), {
    auth: { key: { key_id: 'ik_nope', secret: 'x'.repeat(64) }, instance: 'gw-1' },
  })
  const otherInstance = await call(heartbeat('gw-2'), { auth: { key, instance: 'gw-2' } })
  assert.equal(rawReads(), before, 'the body is not read')
  const badSignature = await call(heartbeat('gw-1'), {
    auth: { key: { ...key, secret: 'y'.repeat(64) }, instance: 'gw-1' },
  })
  assert.deepEqual(
    [unknown, otherInstance, badSignature].map((res) => [res.status, res.body.error.code]),
    [
      [401, 'instance_key_invalid'],
      [401, 'instance_key_invalid'],
      [401, 'instance_key_invalid'],
    ],
  )
  assert.equal(badSignature.headers, undefined, 'an unverifiable rejection is not signed')
})

test('a Worker offline past the grace period renews with the expired key once, only via heartbeat (P2-7)', async (t) => {
  const { call, heartbeat, keys, enroll, unwrap } = setup(t)
  const k1 = await enroll('gw-1')
  await keys.rotate('gw-1', { actor: 'admin', graceMs: 50 })
  await new Promise((resolve) => setTimeout(resolve, 80))
  const lease = await call(
    { instance_id: 'gw-1', runtime_account_id: 'rt', grant: 'native', credential_revision: 1 },
    { url: '/internal/v1/gateway/workers/credentials/lease', auth: { key: k1, instance: 'gw-1' } },
  )
  assert.deepEqual([lease.status, lease.body.error.code], [401, 'instance_key_invalid'])
  const renewed = await call(heartbeat('gw-1'), { auth: { key: k1, instance: 'gw-1' } })
  assert.equal(renewed.status, 200, JSON.stringify(renewed.body))
  assert.equal(renewed.body.policy, undefined, 'renewal only delivers the key')
  const k2 = unwrap(renewed, k1.secret)
  assert.equal((await call(heartbeat('gw-1'), { auth: { key: k2, instance: 'gw-1' } })).status, 200)
  const after = await call(heartbeat('gw-1'), { auth: { key: k1, instance: 'gw-1' } })
  assert.deepEqual(
    [after.status, after.body.error.code],
    [401, 'instance_key_invalid'],
    'no renewal once the new key is in use',
  )
})

test('the supervised Worker inherits only whitelisted environment variables (P2-4)', async () => {
  const { supervisedWorkerEnv, workerEnvAllowed } = await import('../../src/lib/gateway-worker/worker-supervisor.mjs')
  const env = supervisedWorkerEnv({
    env: {
      // 事实直读关闭：数据库字段密钥不传（开启时见下一个用例）
      KIN_CODEX_GATEWAY_FACTS: 'off',
      TAPMODELS_DB_SECRET: 'db',
      KIN_ADMIN_PASSWORD: 'pw',
      TAPMODELS_API_KEY: 'k',
      KIN_CODEX_GATEWAY_INSTANCE_KEY_WRAP: 'w',
      KIN_CODEX_GATEWAY_BOOTSTRAP_TOKEN: 'b',
      KIN_CODEX_GATEWAY_INTERNAL_TOKEN: 'tok',
      KIN_REDIS_URL: 'redis://x',
      HTTPS_PROXY: 'http://p',
      PATH: '/bin',
      HOME: '/home/x',
      PORT: '9001',
    },
    root: '/nonexistent',
    dataDir: '/tmp/x',
  })
  for (const name of [
    'TAPMODELS_DB_SECRET',
    'KIN_ADMIN_PASSWORD',
    'TAPMODELS_API_KEY',
    'KIN_CODEX_GATEWAY_INSTANCE_KEY_WRAP',
    'KIN_CODEX_GATEWAY_BOOTSTRAP_TOKEN',
    'PORT',
  ])
    assert.equal(env[name], undefined, name)
  for (const name of ['KIN_CODEX_GATEWAY_INTERNAL_TOKEN', 'KIN_REDIS_URL', 'HTTPS_PROXY', 'PATH', 'HOME'])
    assert.ok(env[name], name)
  assert.equal(env.KIN_CODEX_GATEWAY_CONTROL_PLANE_URL, 'http://127.0.0.1:9001/internal/v1/gateway/workers/register')
  assert.equal(workerEnvAllowed('KIN_DB_SECRET'), false)
})

test('database field secrets reach the supervised Worker only when fact reads are on; the master key file passes through', async () => {
  const { supervisedWorkerEnv } = await import('../../src/lib/gateway-worker/worker-supervisor.mjs')
  const base = {
    TAPMODELS_DB_SECRET: 'db',
    KIN_DB_SECRET: 'kdb',
    KIN_CREDENTIAL_MASTER_KEY_FILE: '/vault/keys.json',
    PORT: '9001',
  }
  const on = supervisedWorkerEnv({ env: base, root: '/nonexistent', dataDir: '/tmp/x' })
  assert.ok(on.KIN_CODEX_GATEWAY_FACTS_DB, 'the supervisor points the Worker at the control-plane database')
  assert.deepEqual([on.TAPMODELS_DB_SECRET, on.KIN_DB_SECRET], ['db', 'kdb'])
  assert.equal(on.KIN_CREDENTIAL_MASTER_KEY_FILE, '/vault/keys.json', 'passed as configured, not replaced by a default')
  const off = supervisedWorkerEnv({
    env: { ...base, KIN_CODEX_GATEWAY_FACTS: 'off' },
    root: '/nonexistent',
    dataDir: '/tmp/x',
  })
  assert.deepEqual([off.TAPMODELS_DB_SECRET, off.KIN_DB_SECRET], [undefined, undefined])
  const defaulted = supervisedWorkerEnv({ env: { PORT: '9001' }, root: '/nonexistent', dataDir: '/tmp/x' })
  assert.match(defaulted.KIN_CREDENTIAL_MASTER_KEY_FILE, /credential-master-keys\.json$/)
})

test('off mode: a supervised Worker presenting its token gets bootstrap-signed responses without a key (R3 P1-A)', async (t) => {
  const { dir, call, heartbeat, verifiedResponse } = setup(t)
  process.env.KIN_CODEX_GATEWAY_INSTANCE_KEYS = 'off'
  const { supervisor, spawned } = fakeSupervisor(dir, 'gw-sup')
  supervisor.reconcile()
  const token = spawned[0].token
  const res = await call(heartbeat('gw-sup', { bootstrap_token: token }))
  assert.equal(res.status, 200)
  assert.equal(res.body.instance_key, undefined)
  assert.ok(res.body.policy)
  assert.equal(res.headers['x-kin-gateway-response-key'], 'bootstrap')
  assert.ok(verifiedResponse(res, token))
  supervisor.stop()
})

test('unkeyed existing instances cannot report draining to bypass single-Worker mode (R3 P2-1)', async (t) => {
  const { call, heartbeat, repo, enroll } = setup(t, { takeover: false })
  await enroll('gw-01')
  // 升级前遗留的离线行（已批准、没有实例密钥）
  await repo.upsertInstance({ id: 'gw-old', base_url: 'http://old:1', health_state: 'offline' })
  const evil = await call(heartbeat('gw-old', { base_url: 'http://attacker:1', drain_state: 'draining' }))
  assert.deepEqual([evil.status, evil.body.error?.code], [409, 'gateway_single_worker'])
  assert.equal((await repo.getInstance('gw-old')).base_url, 'http://old:1')
})

test('an online pre-upgrade instance without a key keeps working in single-Worker mode (R3 P2-1)', async (t) => {
  const { call, heartbeat, repo } = setup(t, { takeover: false })
  await repo.upsertInstance({ id: 'gw-legacy', base_url: 'http://127.0.0.1:3', health_state: 'healthy' })
  const legacy = await call(heartbeat('gw-legacy', { instance_key_support: undefined }))
  assert.equal(legacy.status, 200, JSON.stringify(legacy.body))
  assert.ok(legacy.body.policy)
  const draining = await call(heartbeat('gw-legacy', { instance_key_support: undefined, drain_state: 'draining' }))
  assert.equal(draining.status, 200, 'its own drain is not blocked by itself')
})

test('a Worker offline across two rotations still renews to the newest key (R3 P2-3); bootstrap errors answer 503 (R3 P2-4)', async (t) => {
  const { call, heartbeat, keys, enroll, unwrap, db } = setup(t)
  const k1 = await enroll('gw-r')
  await keys.rotate('gw-r', { actor: 'admin', graceMs: 30 })
  const r2 = await keys.rotate('gw-r', { actor: 'admin', graceMs: 30 })
  await new Promise((resolve) => setTimeout(resolve, 60))
  const renewed = await call(heartbeat('gw-r'), { auth: { key: k1, instance: 'gw-r' } })
  assert.equal(renewed.status, 200, JSON.stringify(renewed.body))
  assert.equal(unwrap(renewed, k1.secret).key_id, r2.key_id)
  // 签发出错：按引导失败返回 503，不是整个心跳 500
  await keys.allowBootstrap('gw-e', { actor: 'admin' })
  const original = keys.bootstrap
  keys.bootstrap = async () => {
    throw new Error('wrap key unavailable')
  }
  try {
    const failed = await call(heartbeat('gw-e'))
    assert.deepEqual([failed.status, failed.body.error?.code], [503, 'instance_key_bootstrap_failed'])
  } finally {
    keys.bootstrap = original
  }
  assert.ok(db)
})
