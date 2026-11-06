import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, openDatabase } from '../../src/lib/db/database.mjs'
import { buildGatewayHeaders } from '../../src/lib/gateway-worker/gateway-auth.mjs'
import { createGatewayInternalRegistrationRoute } from '../../src/lib/gateway-worker/gateway-routes.mjs'
import { GatewayWorkerRepo } from '../../src/lib/gateway-worker/gateway-repo.mjs'
import { GatewayWorkerClient } from '../../src/lib/gateway-worker/gateway-client.mjs'
import {
  certificateIdentity,
  certificateMatchesInstance,
  checkClientCertificate,
  parseSubjectAltName,
  startGatewayInternalTlsListener,
  trustedProxies,
} from '../../src/lib/gateway-worker/gateway-mtls.mjs'
import { instanceKeyStoreFor, unwrapDeliveredSecret } from '../../src/lib/gateway-worker/instance-keys.mjs'

// 用 scripts/gateway-mtls-certs.sh 生成的证书链验证“证书主体与实例 ID 绑定”（中期技术债 M2）
const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const hasOpenssl = spawnSync('openssl', ['version']).status === 0

function generate(names, extra = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-mtls-'))
  const out = path.join(dir, 'certs')
  const run = spawnSync('sh', [path.join(REPO_ROOT, 'scripts/gateway-mtls-certs.sh'), out, ...extra, ...names], {
    encoding: 'utf8',
  })
  if (run.status !== 0) throw new Error(run.stderr)
  const file = (name) => path.join(out, name)
  return { dir, out, file, read: (name) => fs.readFileSync(file(name)) }
}

function withEnv(t, values) {
  const saved = {}
  for (const [name, value] of Object.entries(values)) {
    saved[name] = process.env[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  t.after(() => {
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
  })
}

test('the certificate script binds identities to instance IDs', { skip: !hasOpenssl && 'openssl missing' }, (t) => {
  const pki = generate(['gw-a'], ['--control-plane-name', 'cp.internal'])
  t.after(() => fs.rmSync(pki.dir, { recursive: true, force: true }))
  assert.equal((fs.statSync(pki.out).mode & 0o777).toString(8), '700')
  assert.equal((fs.statSync(pki.file('worker-gw-a.key')).mode & 0o777).toString(8), '600')
  const ca = new crypto.X509Certificate(pki.read('ca.crt'))
  const worker = new crypto.X509Certificate(pki.read('worker-gw-a.crt'))
  const control = new crypto.X509Certificate(pki.read('control-plane.crt'))
  assert.ok(worker.checkIssued(ca) && worker.verify(ca.publicKey))
  assert.deepEqual(certificateIdentity(worker).uris, ['gw-a'])
  assert.equal(certificateMatchesInstance(certificateIdentity(worker), 'gw-a'), true)
  assert.equal(certificateMatchesInstance(certificateIdentity(worker), 'gw-b'), false)
  assert.deepEqual(certificateIdentity(control).uris, [])
  assert.equal(certificateMatchesInstance(certificateIdentity(control), 'gw-a'), false)
  // 一张证书只能代表一个实例；没有实例 URI 时看 CN
  assert.equal(
    certificateMatchesInstance({ uris: ['gw-a', 'gw-b'], cn: 'gw-a' }, 'gw-a'),
    false,
    'a certificate naming two instances binds to neither',
  )
  assert.equal(certificateMatchesInstance({ uris: [], cn: 'gw-a' }, 'gw-a'), true)
  assert.deepEqual(parseSubjectAltName('DNS:a, URI:"urn:kin:gateway:x,y", IP Address:127.0.0.1'), [
    { type: 'DNS', value: 'a' },
    { type: 'URI', value: 'urn:kin:gateway:x,y' },
    { type: 'IP Address', value: '127.0.0.1' },
  ])
})

test('trusted reverse-proxy certificate headers are accepted only from listed proxies and must match the instance', {
  skip: !hasOpenssl && 'openssl missing',
}, (t) => {
  const pki = generate(['gw-a', 'gw-b'])
  const foreign = generate(['gw-a'])
  t.after(() => {
    fs.rmSync(pki.dir, { recursive: true, force: true })
    fs.rmSync(foreign.dir, { recursive: true, force: true })
  })
  const env = {
    KIN_CODEX_GATEWAY_REQUIRE_MTLS: '1',
    KIN_CODEX_GATEWAY_MTLS_PROXY_HEADER: 'X-SSL-Client-Cert',
    KIN_CODEX_GATEWAY_MTLS_TRUSTED_PROXIES: '127.0.0.1, 10.1.0.0/16',
    KIN_CODEX_GATEWAY_TLS_CA_FILE: pki.file('ca.crt'),
  }
  // nginx $ssl_client_escaped_cert：URL 编码的 PEM
  const req = (cert, remoteAddress = '127.0.0.1') => ({
    socket: { remoteAddress },
    headers: cert ? { 'x-ssl-client-cert': encodeURIComponent(cert.toString()) } : {},
  })
  const workerA = pki.read('worker-gw-a.crt')
  assert.equal(checkClientCertificate(req(workerA), 'gw-a', env), null)
  assert.equal(checkClientCertificate(req(workerA, '::ffff:10.1.2.3'), 'gw-a', env), null)
  assert.equal(checkClientCertificate(req(workerA), 'gw-b', env).code, 'client_certificate_instance_mismatch')
  assert.equal(
    checkClientCertificate(req(pki.read('worker-gw-b.crt')), 'gw-a', env).code,
    'client_certificate_instance_mismatch',
  )
  assert.equal(
    checkClientCertificate(req(workerA, '192.0.2.9'), 'gw-a', env).code,
    'client_certificate_untrusted_source',
  )
  assert.equal(
    checkClientCertificate(req(foreign.read('worker-gw-a.crt')), 'gw-a', env).code,
    'client_certificate_untrusted',
  )
  assert.equal(checkClientCertificate(req(null), 'gw-a', env).code, 'client_certificate_required')
  // CA 文件缓存：内容换成另一套 CA（修改时间变化）后重读
  const caCopy = path.join(pki.dir, 'ca-copy.crt')
  fs.copyFileSync(pki.file('ca.crt'), caCopy)
  const cached = { ...env, KIN_CODEX_GATEWAY_TLS_CA_FILE: caCopy }
  assert.equal(checkClientCertificate(req(workerA), 'gw-a', cached), null)
  fs.copyFileSync(foreign.file('ca.crt'), caCopy)
  fs.utimesSync(caCopy, new Date(), new Date(Date.now() + 5000))
  assert.equal(checkClientCertificate(req(workerA), 'gw-a', cached).code, 'client_certificate_untrusted')
  // 不要求 mTLS、也没有证书时放行；没有配置反代头时忽略该头
  assert.equal(checkClientCertificate(req(null), 'gw-a', { ...env, KIN_CODEX_GATEWAY_REQUIRE_MTLS: '0' }), null)
  assert.equal(
    checkClientCertificate(req(workerA), 'gw-a', { ...env, KIN_CODEX_GATEWAY_MTLS_PROXY_HEADER: '' }).code,
    'client_certificate_required',
  )
})

test('the internal mTLS listener binds the Worker client certificate to the declared instance', {
  skip: !hasOpenssl && 'openssl missing',
}, async (t) => {
  const pki = generate(['gw-a', 'gw-b'], ['--control-plane-name', 'localhost'])
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-mtls-db-'))
  const db = openDatabase({ dataDir })
  t.after(async () => {
    await closeDatabase()
    fs.rmSync(pki.dir, { recursive: true, force: true })
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  withEnv(t, {
    KIN_CODEX_GATEWAY_INTERNAL_TOKEN: 'mtls-token',
    KIN_CODEX_GATEWAY_REQUIRE_MTLS: '1',
    KIN_CODEX_GATEWAY_MULTI_WORKER: '1',
    KIN_CODEX_GATEWAY_INSTANCE_KEYS: undefined,
  })
  db.exec('PRAGMA foreign_keys=OFF')
  const env = {
    ...process.env,
    KIN_CODEX_GATEWAY_INTERNAL_TLS_LISTEN: '127.0.0.1:0',
    KIN_CODEX_GATEWAY_INTERNAL_TLS_CERT_FILE: pki.file('control-plane.crt'),
    KIN_CODEX_GATEWAY_INTERNAL_TLS_KEY_FILE: pki.file('control-plane.key'),
    KIN_CODEX_GATEWAY_TLS_CA_FILE: pki.file('ca.crt'),
  }
  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const readRawBody = (req) =>
    new Promise((resolve, reject) => {
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => resolve(Buffer.concat(chunks)))
      req.on('error', reject)
    })
  const handle = createGatewayInternalRegistrationRoute({ json, readBody: async () => ({}), readRawBody })
  const server = startGatewayInternalTlsListener({ env, handle, log: {} })
  t.after(() => server.close())
  await new Promise((resolve) => (server.listening ? resolve() : server.once('listening', resolve)))
  const port = server.address().port
  const post = (cert, body, { auth = null } = {}) =>
    new Promise((resolve, reject) => {
      const raw = JSON.stringify(body)
      const headers = auth
        ? buildGatewayHeaders({
            secret: auth.secret,
            body: raw,
            keyId: auth.key_id,
            instanceId: body.id,
            method: 'POST',
            path: '/internal/v1/gateway/workers/register',
          })
        : { ...buildGatewayHeaders({ secret: 'mtls-token', body: raw }), 'x-kin-gateway-token': 'mtls-token' }
      const req = https.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/internal/v1/gateway/workers/register',
          headers: { ...headers, 'content-length': Buffer.byteLength(raw) },
          ca: pki.read('ca.crt'),
          servername: 'localhost',
          ...(cert ? { cert: pki.read(`worker-${cert}.crt`), key: pki.read(`worker-${cert}.key`) } : {}),
        },
        (res) => {
          const chunks = []
          res.on('data', (chunk) => chunks.push(chunk))
          res.on('end', () =>
            resolve({
              status: res.statusCode,
              nonce: headers['x-kin-gateway-nonce'],
              body: JSON.parse(Buffer.concat(chunks).toString() || '{}'),
            }),
          )
        },
      )
      req.on('error', reject)
      req.end(raw)
    })
  const heartbeat = (id) => ({ id, base_url: 'https://127.0.0.1:1', health_state: 'healthy', instance_key_support: 1 })
  // 外部 Worker 由管理员允许引导后用共用令牌引导（中期技术债 M2 审查 P0-1）
  await instanceKeyStoreFor(db).allowBootstrap('gw-a', { actor: 'admin' })
  const ok = await post('gw-a', heartbeat('gw-a'))
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
  const mismatch = await post('gw-b', heartbeat('gw-a'))
  assert.deepEqual([mismatch.status, mismatch.body.error?.code], [403, 'client_certificate_instance_mismatch'])
  // 实例密钥签名同样要求证书与实例一致
  const key = {
    key_id: ok.body.instance_key.key_id,
    secret: unwrapDeliveredSecret(
      'mtls-token',
      { instanceId: 'gw-a', keyId: ok.body.instance_key.key_id, nonce: ok.nonce },
      ok.body.instance_key.wrapped,
    ),
  }
  assert.equal((await post('gw-a', heartbeat('gw-a'), { auth: key })).status, 200)
  const keyed = await post('gw-b', heartbeat('gw-a'), { auth: key })
  assert.deepEqual([keyed.status, keyed.body.error?.code], [403, 'client_certificate_instance_mismatch'])
  // 没有客户端证书的连接在 TLS 握手时就被拒绝
  await assert.rejects(post(null, heartbeat('gw-a')))
  // 同一处理器经明文端口（没有证书）进来时，REQUIRE_MTLS 下拒绝
  const res = {}
  const raw = JSON.stringify(heartbeat('gw-b'))
  await handle(
    {
      method: 'POST',
      headers: { ...buildGatewayHeaders({ secret: 'mtls-token', body: raw }), 'x-kin-gateway-token': 'mtls-token' },
      raw,
      on(event, fn) {
        if (event === 'data') fn(Buffer.from(raw))
        if (event === 'end') fn()
      },
    },
    Object.assign(res, { writeHead: (status) => (res.status = status), end: (text) => (res.text = text) }),
    new URL('http://cp/internal/v1/gateway/workers/register'),
  )
  assert.equal(res.status, 401)
  assert.match(res.text, /client_certificate_required/)
})

test('the control plane only accepts a Worker server certificate bound to the instance under REQUIRE_MTLS', {
  skip: !hasOpenssl && 'openssl missing',
}, async (t) => {
  const pki = generate(['gw-a', 'gw-b'])
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-mtls-client-'))
  const db = openDatabase({ dataDir })
  t.after(async () => {
    await closeDatabase()
    fs.rmSync(pki.dir, { recursive: true, force: true })
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  withEnv(t, {
    KIN_CODEX_GATEWAY_REQUIRE_MTLS: '1',
    KIN_CODEX_GATEWAY_TLS_CLIENT_CERT_FILE: pki.file('control-plane.crt'),
    KIN_CODEX_GATEWAY_TLS_CLIENT_KEY_FILE: pki.file('control-plane.key'),
    KIN_CODEX_GATEWAY_TLS_CA_FILE: pki.file('ca.crt'),
    KIN_CODEX_GATEWAY_TLS_SERVER_NAME: undefined,
  })
  const start = (name) =>
    new Promise((resolve) => {
      const server = https.createServer(
        {
          cert: pki.read(`worker-${name}.crt`),
          key: pki.read(`worker-${name}.key`),
          ca: pki.read('ca.crt'),
          requestCert: true,
          rejectUnauthorized: true,
        },
        (req, res) => {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({ ok: true, health_state: 'healthy', peer: req.socket.getPeerCertificate().subject?.CN }),
          )
        },
      )
      server.listen(0, '127.0.0.1', () => resolve(server))
    })
  const repo = new GatewayWorkerRepo(db)
  const client = new GatewayWorkerClient({ repo, secret: 'tok' })
  const bound = await start('gw-a')
  const impostor = await start('gw-b')
  t.after(() => {
    bound.close()
    impostor.close()
  })
  await repo.upsertInstance({
    id: 'gw-a',
    base_url: `https://127.0.0.1:${bound.address().port}`,
    health_state: 'healthy',
  })
  const result = await client.health('gw-a')
  assert.equal(result.status, 200, JSON.stringify(result.data))
  assert.equal(result.data.peer, 'control-plane', 'the control plane presented its client certificate')
  await repo.upsertInstance({
    id: 'gw-a',
    base_url: `https://127.0.0.1:${impostor.address().port}`,
    health_state: 'healthy',
  })
  await assert.rejects(client.health('gw-a'), /not bound to instance gw-a/)
})

test('certificate identity parsing: URN case, several CNs, invalid proxy entries and listener errors', {
  skip: !hasOpenssl && 'openssl missing',
}, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-mtls-id-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  // URN 的 scheme 与 NID 不区分大小写，实例 ID 区分（与 Go 一致）
  assert.deepEqual(certificateIdentity({ subjectaltname: 'URI:URN:KIN:GATEWAY:gw-1', subject: {} }).uris, ['gw-1'])
  assert.equal(
    certificateMatchesInstance(certificateIdentity({ subjectaltname: 'URI:urn:kin:gateway:gw-1' }), 'GW-1'),
    false,
  )
  // 主体带多个 CN 的证书不绑定任何实例（审查：/tmp/m2rev/cn.mjs）
  spawnSync('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', path.join(dir, 'k.pem')])
  const made = spawnSync(
    'openssl',
    [
      'req',
      '-new',
      '-x509',
      '-key',
      path.join(dir, 'k.pem'),
      '-subj',
      '/CN=gw-1/CN=victim',
      '-days',
      '1',
      '-out',
      path.join(dir, 'c.pem'),
    ],
    { encoding: 'utf8' },
  )
  assert.equal(made.status, 0, made.stderr)
  const multi = certificateIdentity(new crypto.X509Certificate(fs.readFileSync(path.join(dir, 'c.pem'))))
  assert.equal(multi.invalid, true)
  assert.equal(certificateMatchesInstance(multi, 'victim'), false)
  assert.equal(certificateMatchesInstance(multi, 'gw-1'), false)
  assert.equal(
    certificateMatchesInstance(certificateIdentity({ subject: { CN: ['gw-1', 'victim'] } }), 'victim'),
    false,
  )
  // 非法的受信反代条目告警并忽略，合法条目照常生效，检查不抛错
  const warnings = []
  const list = trustedProxies(
    { KIN_CODEX_GATEWAY_MTLS_TRUSTED_PROXIES: '10.0.0.0/99, bogus, 127.0.0.1, 10.1.0.0/16' },
    { warn: (line) => warnings.push(line) },
  )
  assert.equal(warnings.filter((line) => /ignoring invalid entry/.test(line)).length, 2)
  // 非回环的受信反代：提醒主端口只能对反代开放（复审 P2-8）
  assert.ok(warnings.some((line) => /non-loopback/.test(line) && /10\.1\.0\.0\/16/.test(line)))
  const quiet = []
  trustedProxies({ KIN_CODEX_GATEWAY_MTLS_TRUSTED_PROXIES: '127.0.0.1, ::1' }, { warn: (line) => quiet.push(line) })
  assert.deepEqual(quiet, [])
  assert.equal(list.check('127.0.0.1', 'ipv4'), true)
  assert.equal(list.check('10.1.2.3', 'ipv4'), true)
  // 端口被占用：只告警，不抛出
  const pki = generate(['gw-a'])
  t.after(() => fs.rmSync(pki.dir, { recursive: true, force: true }))
  const blocker = https.createServer({ cert: pki.read('control-plane.crt'), key: pki.read('control-plane.key') })
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve))
  t.after(() => blocker.close())
  const errors = []
  const listener = startGatewayInternalTlsListener({
    env: {
      KIN_CODEX_GATEWAY_INTERNAL_TLS_LISTEN: `127.0.0.1:${blocker.address().port}`,
      KIN_CODEX_GATEWAY_INTERNAL_TLS_CERT_FILE: pki.file('control-plane.crt'),
      KIN_CODEX_GATEWAY_INTERNAL_TLS_KEY_FILE: pki.file('control-plane.key'),
      KIN_CODEX_GATEWAY_TLS_CA_FILE: pki.file('ca.crt'),
    },
    handle: async () => false,
    log: { error: (line) => errors.push(line), info() {} },
  })
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.ok(
    errors.some((line) => /EADDRINUSE/.test(line)),
    errors.join('\n'),
  )
  listener.close()
  // 证书文件缺失：监听不启动，也不抛出
  assert.equal(
    startGatewayInternalTlsListener({
      env: {
        KIN_CODEX_GATEWAY_INTERNAL_TLS_LISTEN: '127.0.0.1:0',
        KIN_CODEX_GATEWAY_INTERNAL_TLS_CERT_FILE: '/nonexistent',
      },
      handle: async () => false,
      log: { error() {} },
    }),
    null,
  )
})
