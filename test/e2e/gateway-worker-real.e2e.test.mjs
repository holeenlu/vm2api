import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { WebSocket, WebSocketServer } from 'ws'
import { startGateway, api, REPO_ROOT } from '../harness.mjs'
import { diffDatabase } from '../../scripts/executor-replay-diff.mjs'
import { migrateWorkerCredentials } from '../../scripts/migrate-worker-credentials.mjs'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { buildGatewayHeaders } from '../../src/lib/gateway-worker/gateway-auth.mjs'

// 真实链路：Node 控制面 → 编译出的 Go kin-codex-gateway → 账号代理 → 假 ChatGPT 上游（HTTP/WS）。
// 不调用真实 OpenAI；没有 Go 工具链且未提供 KIN_CODEX_GATEWAY_BIN 时跳过。

function goBinary() {
  if (process.env.KIN_CODEX_GATEWAY_BIN) return { bin: process.env.KIN_CODEX_GATEWAY_BIN }
  const go = spawnSync('go', ['version'], { encoding: 'utf8' })
  if (go.status !== 0) {
    // CI 设置 KIN_E2E_REQUIRE_GO=1：缺 Go 时失败而不是静默跳过（最终审计 U10）
    if (process.env.KIN_E2E_REQUIRE_GO === '1') throw new Error('go toolchain is required (KIN_E2E_REQUIRE_GO=1)')
    return { skip: 'go toolchain not available' }
  }
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kin-gw-bin-')), 'kin-codex-gateway')
  const build = spawnSync('go', ['build', '-o', out, './cmd/kin-codex-gateway'], {
    cwd: path.join(REPO_ROOT, 'worker'),
    encoding: 'utf8',
    env: { ...process.env, CGO_ENABLED: '0' },
  })
  if (build.status !== 0) throw new Error(`go build failed: ${build.stderr}`)
  return { bin: out }
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

// 最小 SOCKS5 代理：无认证握手后，把 CONNECT 的目标（域名或 IP）接成 TCP 隧道。seen 记录每个 CONNECT 目标。
function startForwardProxy() {
  const seen = []
  const server = net.createServer((client) => {
    client.on('error', () => client.destroy())
    let stage = 'greeting'
    let buf = Buffer.alloc(0)
    const onData = (data) => {
      buf = Buffer.concat([buf, data])
      if (stage === 'greeting') {
        if (buf.length < 2 || buf.length < 2 + buf[1]) return
        buf = buf.subarray(2 + buf[1])
        client.write(Buffer.from([5, 0]))
        stage = 'request'
      }
      if (stage === 'request') {
        if (buf.length < 5) return
        const type = buf[3]
        const addrLen = type === 1 ? 4 : type === 4 ? 16 : 1 + buf[4]
        if (buf.length < 4 + addrLen + 2) return
        if (type === 4) return client.destroy() // the fixtures only use a hostname or an IPv4 address
        const host =
          type === 3 ? buf.subarray(5, 5 + buf[4]).toString('latin1') : Array.from(buf.subarray(4, 8)).join('.')
        const port = buf.readUInt16BE(4 + addrLen)
        const rest = buf.subarray(4 + addrLen + 2)
        stage = 'tunnel'
        client.off('data', onData)
        seen.push(`CONNECT ${host}:${port}`)
        const upstream = net.connect(port, host, () => {
          client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]))
          if (rest.length) upstream.write(rest)
          client.pipe(upstream).pipe(client)
        })
        upstream.on('error', () => client.destroy())
        client.on('close', () => upstream.destroy())
      }
    }
    client.on('data', onData)
  })
  return { server, seen }
}

function sse(id, text = 'pong') {
  return [
    { type: 'response.created', response: { id, model: 'gpt-e2e' } },
    { type: 'response.output_text.delta', delta: text },
    {
      type: 'response.completed',
      response: {
        id,
        model: 'gpt-e2e',
        usage: {
          input_tokens: 7,
          input_tokens_details: { cached_tokens: 2 },
          output_tokens: 3,
          output_tokens_details: { reasoning_tokens: 1 },
        },
      },
    },
  ]
}

function startFakeChatGPT() {
  const state = {
    http: [],
    ws: [],
    wsConnections: 0,
    wsMode: 'ok',
    search: [],
    turn: 0,
    clients: new Set(),
    live: [],
    sideband: [],
    hangup: [],
  }
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://upstream').pathname
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    let raw = Buffer.concat(chunks)
    if (req.headers['content-encoding'] === 'zstd') raw = zlib.zstdDecompressSync(raw)
    // OAuth 换票（凭据刷新租约 e2e）：轮换出新的访问令牌与刷新令牌
    if (pathname === '/oauth/token') {
      state.tokenRefreshes = (state.tokenRefreshes || 0) + 1
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ access_token: 'tok_e2e_2', refresh_token: 'rt_e2e_2', expires_in: 3600 }))
    }
    // Codex Live：引导在 chatgpt.com backend，hangup 在 api.openai.com（同一假上游的 /v1 前缀）
    if (pathname === '/backend-api/codex/realtime/calls') {
      state.live.push({
        headers: req.headers,
        query: new URL(req.url, 'http://upstream').search,
        body: raw.toString('utf8'),
      })
      res.writeHead(201, { 'content-type': 'application/sdp', location: '/v1/realtime/calls/rtc_e2e' })
      return res.end('v=0 answer')
    }
    if (/^\/v1\/realtime\/calls\/[^/]+\/hangup$/.test(pathname)) {
      state.hangup.push({ headers: req.headers, pathname })
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end('{}')
    }
    const body = raw.length ? JSON.parse(raw.toString('utf8')) : {}
    if (pathname === '/backend-api/codex/responses') {
      state.http.push({ headers: req.headers, body })
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'x-codex-primary-used-percent': '12',
        'x-codex-primary-window-minutes': '300',
        'x-codex-secondary-used-percent': '3',
        'x-codex-secondary-window-minutes': '10080',
      })
      for (const event of sse(`resp_http_${++state.turn}`)) res.write(`data: ${JSON.stringify(event)}\n\n`)
      return res.end()
    }
    if (pathname === '/backend-api/codex/alpha/search') {
      state.search.push({ headers: req.headers, body })
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ results: [{ title: 'e2e' }] }))
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":{"code":"not_found"}}')
  })
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: true })
  const liveWss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has('realtime') ? 'realtime' : false),
  })
  server.on('upgrade', (req, socket, head) => {
    // 经 HTTP 转发代理时请求行是 absolute-form，按路径判断
    const upgradePath = new URL(req.url, 'http://upstream')
    if (upgradePath.pathname.startsWith('/v1/')) {
      state.sideband.push({ headers: req.headers, url: upgradePath.pathname + upgradePath.search })
      liveWss.handleUpgrade(req, socket, head, (ws) => ws.on('message', (data) => ws.send(`echo:${data}`)))
      return
    }
    if (state.wsMode === 'upgrade_required') {
      socket.end('HTTP/1.1 426 Upgrade Required\r\ncontent-length: 0\r\n\r\n')
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      state.clients.add(ws)
      ws.on('close', () => state.clients.delete(ws))
      const connection = ++state.wsConnections
      ws.on('message', (data) => {
        const frame = JSON.parse(String(data))
        state.ws.push({ connection, headers: req.headers, frame })
        if (frame.type !== 'response.create') return
        for (const event of sse(`resp_ws_${connection}_${++state.turn}`)) ws.send(JSON.stringify(event))
      })
    })
  })
  return { server, state }
}

async function waitFor(fn, { timeoutMs = 20_000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await fn()
    if (last) return last
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`timed out waiting: ${JSON.stringify(last)}`)
}

const built = goBinary()

// 同一条链路分别在三种执行事件模式下运行（docs/control-plane/DEVELOPMENT_PLAN.md P1.7、P1.8）：
// off 为改动前行为；shadow 拉取事件并与回执比对，不生效；primary 以事件为主来源。三种模式下回执与使用记录一致。
for (const eventsMode of ['off', 'shadow', 'primary'])
  test(
    `real Go Worker [events=${eventsMode}]: Responses over upstream WS, Chat, HTTP+zstd fallback, Search, inbound WS continuation and Receipts`,
    { skip: built.skip, timeout: 120_000 },
    (t) => realWorkerFlow(t, eventsMode),
  )

// 按实例签发的内部 HMAC 密钥（中期技术债 M2）：托管 Worker 用一次性引导令牌自动引导 → 用实例密钥跑一次请求 → 在线轮换 →
// 再跑一次 → 吊销（退回共用令牌）→ 管理员允许引导后重新签发
test(
  'real Go Worker: instance key issued at registration, used, rotated online and re-bootstrapped after revocation and a new grant',
  { skip: built.skip, timeout: 120_000 },
  (t) => instanceKeyFlow(t),
)

async function instanceKeyFlow(t) {
  const secret = crypto.randomUUID()
  const fake = startFakeChatGPT()
  const upstreamPort = await listen(fake.server)
  const probe = net.createServer()
  const workerPort = await listen(probe)
  await new Promise((resolve) => probe.close(resolve))
  const proxy = startForwardProxy()
  const proxyPort = await listen(proxy.server)
  const workerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-gw-keys-'))
  const gw = await startGateway({
    disableWatchdog: true,
    env: {
      KIN_RATE_CAP: '100000',
      KIN_RATE_REFILL: '1000',
      KIN_CODEX_GATEWAY_RELEASE_CHECK: 'off',
      KIN_CODEX_GATEWAY_INTERNAL_TOKEN: secret,
      KIN_CODEX_GATEWAY_SUPERVISE: '1',
      KIN_CODEX_GATEWAY_BIN: built.bin,
      KIN_CODEX_GATEWAY_LISTEN: `127.0.0.1:${workerPort}`,
      KIN_CODEX_GATEWAY_INSTANCE_ID: 'gw_keys',
      KIN_CODEX_GATEWAY_DATA_DIR: workerDir,
      KIN_CODEX_GATEWAY_RECEIPT_TOKEN: secret,
      KIN_CODEX_GATEWAY_CREDENTIAL_BUNDLE_KEY: crypto.randomBytes(32).toString('hex'),
      KIN_CODEX_GATEWAY_UPSTREAM_BASE_URL: `http://127.0.0.1:${upstreamPort}/backend-api/codex`,
      KIN_CODEX_GATEWAY_UPSTREAM_TRANSPORT: 'http',
      KIN_CODEX_GATEWAY_INSTANCE_KEYS: 'on',
    },
  })
  const workerLog = () => gw.stdout() + gw.stderr()
  t.after(async () => {
    await gw.stop()
    fake.server.closeAllConnections?.()
    fake.server.close()
    proxy.server.close()
    fs.rmSync(workerDir, { recursive: true, force: true })
    fs.rmSync(gw.project, { recursive: true, force: true })
  })
  const panel = async (method, suffix, body) => {
    const r = await api(gw, method, `/api/panel/${suffix}`, { body })
    if (r.status >= 400) console.error(`[panel] ${method} ${suffix} -> ${r.status} ${r.text.slice(0, 500)}`)
    return r
  }
  const data = (r) => r.json?.data ?? r.json
  const instance = async () =>
    (data(await panel('GET', 'gateway-workers'))?.items || []).find((i) => i.id === 'gw_keys')
  const dbPath = path.join(gw.project, 'data', 'kin.db')
  const query = (sql, ...args) => {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      return db.prepare(sql).all(...args)
    } finally {
      db.close()
    }
  }

  // 1. 托管器拉起时给一次性引导令牌：注册即签发，Worker 换上实例密钥并立即用它心跳，控制面记为已确认
  const issued = await waitFor(async () => {
    const item = await instance()
    return item?.health_state === 'healthy' && item.instance_key?.state === 'issued' && item.instance_key
  }).catch(() => assert.fail(`instance key was not issued\n${workerLog()}`))
  const firstKey = issued.keys[0].key_id
  const keyFile = fs.readFileSync(path.join(workerDir, 'instance-key.json'), 'utf8')
  assert.ok(keyFile.startsWith('kin-instance-key:v1:'), 'the Worker seals its instance key at rest')
  assert.equal((fs.statSync(path.join(workerDir, 'instance-key.json')).mode & 0o777).toString(8), '600')
  const [row] = query(
    'SELECT sealed_secret,state,confirmed_at FROM gateway_worker_instance_keys WHERE key_id=?',
    firstKey,
  )
  assert.ok(row.sealed_secret.startsWith('ik1:') && row.confirmed_at && row.state === 'active')

  // 共用令牌不能再调用 Worker 的内部接口（只读健康探测除外）
  const direct = async (urlPath, method = 'POST') => {
    const body = method === 'GET' ? '' : '{}'
    const response = await fetch(`http://127.0.0.1:${workerPort}${urlPath}`, {
      method,
      headers: buildGatewayHeaders({ secret, body }),
      ...(method === 'GET' ? {} : { body }),
    })
    return response.status
  }
  assert.equal(await direct('/internal/v1/accounts', 'GET'), 401)
  assert.equal(await direct('/internal/v1/health', 'GET'), 200)

  const group = data(await panel('POST', 'groups', { name: 'Codex Keys', platform: 'openai', rate_multiplier: 0 })).item
  const user = data(await panel('POST', 'users', { username: 'gw-keys', password: 'gw-keys-pass' })).item
  await panel('PUT', `users/${user.id}/groups`, { groups: [{ group_id: group.id }] })
  const draft = data(
    await panel('POST', 'codex-accounts/drafts', {
      name: 'Keys Codex',
      group_ids: [group.id],
      proxy_endpoint: `socks5://127.0.0.1:${proxyPort}`,
      max_concurrency: 4,
      idempotency_key: crypto.randomUUID(),
    }),
  )
  const imported = await panel('POST', `codex-accounts/drafts/${draft.draft.id}/import`, {
    access_token: 'tok_keys',
    refresh_token: 'rt_keys',
    chatgpt_account_id: 'acct_keys',
    email: 'keys@example.test',
  })
  assert.equal(imported.status, 200, imported.text)
  const account = data(imported).account
  // 投影经实例密钥签名送达 Worker
  await waitFor(
    async () => data(await panel('GET', `codex-accounts/${account.id}`))?.account?.projection_status === 'synced',
  ).catch(() => assert.fail(`projection signed with the instance key failed\n${workerLog()}`))
  await panel('POST', `codex-accounts/${account.id}/resume`, {})
  const key = data(await panel('POST', 'api-keys', { name: 'Keys', user_id: user.id, group_id: group.id })).item
  const headers = { authorization: `Bearer ${key.key}` }
  const models = await api(gw, 'GET', '/v1/models', { headers })
  const model = models.json?.data?.find((m) => /^gpt-/.test(m.id) && !/image/.test(m.id))?.id
  assert.ok(model, models.text)
  const chat = async () => {
    const r = await api(gw, 'POST', '/v1/chat/completions', {
      headers,
      body: { model, stream: false, messages: [{ role: 'user', content: 'hi' }] },
    })
    assert.equal(r.status, 200, r.text + workerLog())
    assert.equal(r.json.choices[0].message.content, 'pong')
  }
  // 2. 用实例密钥跑一次请求
  await chat()

  // 3. 在线轮换：旧密钥进入宽限期，Worker 下一次心跳拿到新密钥并切换
  const rotated = await panel('POST', 'gateway-workers/gw_keys/instance-key/rotate', {})
  assert.equal(rotated.status, 200, rotated.text)
  const nextKey = data(rotated).rotated.key_id
  assert.notEqual(nextKey, firstKey)
  const switched = await waitFor(
    async () => {
      const keys = (await instance())?.instance_key?.keys || []
      const current = keys.find((entry) => entry.key_id === nextKey)
      return current?.confirmed_at && keys
    },
    { timeoutMs: 40_000 },
  ).catch(() => assert.fail(`Worker did not switch to the rotated key\n${workerLog()}`))
  const retiring = switched.find((entry) => entry.key_id === firstKey)
  assert.equal(retiring?.state, 'retiring', 'the old key stays valid during the grace period')
  assert.ok(Date.parse(retiring.expires_at) > Date.now())
  // 4. 轮换后再跑一次
  await chat()

  // 吊销立即生效：Worker 收到已签名的 instance_key_invalid 后删除本地密钥，退回共用令牌；
  // 吊销不重新开放引导（审查 P0-2），一次性引导令牌已经用过，需要管理员重新允许引导
  const revoked = await panel('POST', 'gateway-workers/gw_keys/instance-key/revoke', {})
  assert.equal(revoked.status, 200, revoked.text)
  await waitFor(
    async () => {
      const item = await instance()
      return item?.instance_key?.state === 'none' && !fs.existsSync(path.join(workerDir, 'instance-key.json'))
    },
    { timeoutMs: 40_000 },
  ).catch(() => assert.fail(`Worker did not drop the revoked key\n${workerLog()}`))
  await chat()
  const allowed = await panel('POST', 'gateway-workers/gw_keys/instance-key/allow-bootstrap', {})
  assert.equal(allowed.status, 200, allowed.text)
  await waitFor(
    async () => {
      const item = await instance()
      return (
        item?.instance_key?.state === 'issued' &&
        !item.instance_key.keys.some((k) => [firstKey, nextKey].includes(k.key_id))
      )
    },
    { timeoutMs: 40_000 },
  ).catch(() => assert.fail(`Worker did not bootstrap again after the grant\n${workerLog()}`))
  assert.equal((await panel('POST', 'gateway-workers/gw_keys/instance-key/allow-bootstrap', {})).status, 409)
  await chat()
  assert.deepEqual(
    query("SELECT action FROM operation_audit WHERE action LIKE 'gateway.instance_key.%' ORDER BY rowid").map(
      (r) => r.action,
    ),
    [
      'gateway.instance_key.issued',
      'gateway.instance_key.rotated',
      'gateway.instance_key.revoked',
      'gateway.instance_key.bootstrap_allowed',
      'gateway.instance_key.issued',
    ],
  )
}

async function realWorkerFlow(t, eventsMode) {
  const secret = crypto.randomUUID()
  const fake = startFakeChatGPT()
  const upstreamPort = await listen(fake.server)
  const proxy = startForwardProxy()
  const proxyPort = await listen(proxy.server)
  const probe = net.createServer()
  const workerPort = await listen(probe)
  await new Promise((resolve) => probe.close(resolve))
  const workerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-gw-data-'))
  const bundleKey = crypto.randomBytes(32).toString('hex')
  // 控制面托管 Worker：随控制面拉起同机子进程，回连地址由控制面按自身端口补齐
  const gw = await startGateway({
    disableWatchdog: true,
    env: {
      // 用例轮询面板接口很密：CI 机器较慢时会耗尽主密钥的请求限流（默认 60 个、每秒补 1 个），返回 429（最终审计 U10）
      KIN_RATE_CAP: '100000',
      KIN_RATE_REFILL: '1000',
      // 封闭环境（最终审计 U10a）：托管 Worker 继承控制面环境，不访问 OpenAI 官方发布源
      KIN_CODEX_GATEWAY_RELEASE_CHECK: 'off',
      KIN_CODEX_GATEWAY_INTERNAL_TOKEN: secret,
      KIN_CODEX_GATEWAY_SUPERVISE: '1',
      KIN_CODEX_GATEWAY_BIN: built.bin,
      KIN_CODEX_GATEWAY_LISTEN: `127.0.0.1:${workerPort}`,
      KIN_CODEX_GATEWAY_INSTANCE_ID: 'gw_e2e',
      KIN_CODEX_GATEWAY_DATA_DIR: workerDir,
      KIN_CODEX_GATEWAY_RECEIPT_TOKEN: secret,
      KIN_CODEX_GATEWAY_CREDENTIAL_BUNDLE_KEY: bundleKey,
      KIN_CODEX_GATEWAY_UPSTREAM_BASE_URL: `http://127.0.0.1:${upstreamPort}/backend-api/codex`,
      KIN_CODEX_GATEWAY_LIVE_API_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
      KIN_EXECUTOR_EVENTS: eventsMode,
      KIN_CODEX_GATEWAY_OAUTH_TOKEN_URL: `http://127.0.0.1:${upstreamPort}/oauth/token`,
      // 凭据刷新租约恒开、令牌以控制面凭据库为准（G1 起两者都不再有开关）
    },
  })
  const workerLog = () => gw.stdout() + gw.stderr()
  t.after(async () => {
    await gw.stop()
    fake.server.closeAllConnections?.()
    fake.server.close()
    proxy.server.close()
    fs.rmSync(workerDir, { recursive: true, force: true })
    fs.rmSync(gw.project, { recursive: true, force: true })
  })
  // 面板请求失败时把状态码与正文写到 stderr（TAP 注释里可见）：CI 上出现过偶发的错误响应，需要现场证据（最终审计 U10）
  const panel = async (method, suffix, body) => {
    const r = await api(gw, method, `/api/panel/${suffix}`, { body })
    if (r.status >= 400) console.error(`[panel] ${method} ${suffix} -> ${r.status} ${r.text.slice(0, 500)}`)
    return r
  }
  const data = (r) => r.json?.data ?? r.json

  // 托管的 Worker 主动注册并心跳；面板显示托管进程状态
  await waitFor(async () =>
    (data(await panel('GET', 'gateway-workers'))?.items || []).find(
      (item) => item.id === 'gw_e2e' && item.health_state === 'healthy',
    ),
  )
  // 列表请求偶发返回错误（CI 机器上三个 e2e 文件并行、负载高）：等到返回 200 且带托管进程状态，
  // 超时时把最后一次响应带进断言信息，便于定位（最终审计 U10 首次 CI 运行）
  let listed = null
  await waitFor(async () => {
    listed = await panel('GET', 'gateway-workers')
    return listed.status === 200 && data(listed)?.supervisor
  }).catch(() => assert.fail(`gateway-workers list: ${listed?.status} ${listed?.text?.slice(0, 500)}\n${workerLog()}`))
  const supervised = data(listed).supervisor
  assert.equal(supervised.status, 'running', JSON.stringify(supervised))
  assert.ok(supervised.pid > 0)

  const groupCreated = await panel('POST', 'groups', { name: 'Codex E2E', platform: 'openai', rate_multiplier: 0 })
  const group = data(groupCreated)?.item
  assert.ok(group, `create group: ${groupCreated.status} ${groupCreated.text.slice(0, 500)}`)
  const userCreated = await panel('POST', 'users', { username: 'gw-e2e', password: 'gw-e2e-pass' })
  const user = data(userCreated)?.item
  assert.ok(user, `create user: ${userCreated.status} ${userCreated.text.slice(0, 500)}`)
  await panel('PUT', `users/${user.id}/groups`, { groups: [{ group_id: group.id }] })

  // 平台自营账号：经草稿导入凭据，账号出站走本地转发代理
  const draft = data(
    await panel('POST', 'codex-accounts/drafts', {
      name: 'E2E Codex',
      group_ids: [group.id],
      proxy_endpoint: `socks5://127.0.0.1:${proxyPort}`,
      max_concurrency: 4,
      idempotency_key: crypto.randomUUID(),
    }),
  )
  assert.ok(draft?.draft?.id, JSON.stringify(draft))
  const imported = await panel('POST', `codex-accounts/drafts/${draft.draft.id}/import`, {
    access_token: 'tok_e2e',
    refresh_token: 'rt_e2e',
    chatgpt_account_id: 'acct_e2e',
    email: 'e2e@example.test',
  })
  assert.equal(imported.status, 200, imported.text)
  const account = data(imported).account
  await waitFor(
    async () => data(await panel('GET', `codex-accounts/${account.id}`))?.account?.projection_status === 'synced',
  )
  await panel('POST', `codex-accounts/${account.id}/resume`, {})

  const key = data(await panel('POST', 'api-keys', { name: 'GW E2E Key', user_id: user.id, group_id: group.id })).item
  const headers = { authorization: `Bearer ${key.key}` }

  // P8：只绑定 Gateway 账号的分组也能列出 OpenAI 模型
  const models = await api(gw, 'GET', '/v1/models', { headers })
  assert.equal(models.status, 200, models.text)
  const model = models.json.data.find((m) => /^gpt-/.test(m.id) && !/image/.test(m.id))?.id
  assert.ok(model, models.text)

  // 1. Responses SSE：上游走 WebSocket，身份头由 Worker 重建
  const streamed = await api(gw, 'POST', '/v1/responses', { headers, body: { model, input: 'hi', stream: true } })
  assert.equal(streamed.status, 200, streamed.text + workerLog())
  assert.match(streamed.text, /response\.completed/)
  assert.ok(fake.state.ws.length >= 1, 'upstream WebSocket was not used')
  const wsHandshake = fake.state.ws[0].headers
  assert.equal(wsHandshake.authorization, 'Bearer tok_e2e')
  assert.equal(wsHandshake['chatgpt-account-id'], 'acct_e2e')
  // 默认上游客户端画像：Codex Desktop · macOS · 已核验的最新官方发布。版本取自官方安装包内置 Core 的版本，
  // 可能带预发布后缀（例如 0.167.0-alpha.3.2tools；Worker 的 validSemver 允许），用例不能只认 x.y.z（U10 首次 CI 运行）
  assert.equal(wsHandshake.originator, 'Codex Desktop')
  assert.match(
    wsHandshake['user-agent'],
    /^Codex Desktop\/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)? \(Mac OS [\d.]+; arm64\) unknown \(Codex Desktop; [\d.]+\)$/,
  )
  assert.equal(wsHandshake.version, wsHandshake['user-agent'].split('/')[1].split(' ')[0])
  assert.equal(wsHandshake['openai-beta'], 'responses_websockets=2026-02-06')
  assert.equal(fake.state.ws[0].frame.type, 'response.create')
  assert.ok(
    proxy.seen.some((line) => line.startsWith('CONNECT ') && line.endsWith(`:${upstreamPort}`)),
    'account proxy was not used',
  )

  // 2. Chat Completions 非流式：协议回转为 chat.completion
  const chat = await api(gw, 'POST', '/v1/chat/completions', {
    headers,
    body: { model, stream: false, messages: [{ role: 'user', content: 'hi' }] },
  })
  assert.equal(chat.status, 200, chat.text)
  assert.equal(chat.json.object, 'chat.completion')
  assert.equal(chat.json.choices[0].message.content, 'pong')

  // 3. 上游拒绝 WS（426）→ 回退 HTTP/SSE，OAuth 正文 zstd 压缩，关联 ID 隔离
  // 断开 Worker 池中的空闲上游连接，迫使重新握手
  fake.state.wsMode = 'upgrade_required'
  for (const client of fake.state.clients) client.terminate()
  await new Promise((resolve) => setTimeout(resolve, 100))
  const viaHttp = await api(gw, 'POST', '/v1/responses', {
    headers: { ...headers, 'session-id': 'sess-e2e' },
    body: { model, input: 'hi', stream: false, prompt_cache_key: 'pck-e2e' },
  })
  assert.equal(viaHttp.status, 200, viaHttp.text)
  assert.equal(viaHttp.json.output[0].content[0].text, 'pong')
  const httpReq = fake.state.http.at(-1)
  assert.equal(httpReq.headers['content-encoding'], 'zstd')
  assert.equal(httpReq.body.stream, true)
  assert.notEqual(httpReq.body.prompt_cache_key, 'pck-e2e')
  assert.match(httpReq.body.prompt_cache_key, /^[0-9a-f-]{36}$/)
  // 全局请求位置：时区上下文与 web_search 的 user_location 在 Worker 出站前改写
  const location = { country: 'JP', region: 'Tokyo', city: 'Chiyoda', timezone: 'Asia/Tokyo' }
  assert.equal((await panel('PUT', 'codex-request-location', { enabled: true, location })).status, 200)
  const located = await api(gw, 'POST', '/v1/responses', {
    headers,
    body: {
      model,
      stream: false,
      tools: [{ type: 'web_search' }],
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: '<environment_context><timezone>UTC</timezone></environment_context>' },
          ],
        },
      ],
    },
  })
  assert.equal(located.status, 200, located.text)
  const locatedReq = fake.state.http.at(-1).body
  assert.equal(
    locatedReq.input[0].content[0].text,
    '<environment_context><timezone>Asia/Tokyo</timezone></environment_context>',
  )
  assert.deepEqual(locatedReq.tools[0].user_location, { type: 'approximate', ...location })
  await panel('PUT', 'codex-request-location', { enabled: false, location })
  fake.state.wsMode = 'ok'

  // 4. 独立 Search 走 Worker 发往 /alpha/search，按分组单次价计费
  const search = await api(gw, 'POST', '/v1/alpha/search', { headers, body: { model, query: 'e2e' } })
  assert.equal(search.status, 200, search.text)
  assert.equal(fake.state.search.length, 1)
  assert.equal(fake.state.search[0].headers.authorization, 'Bearer tok_e2e')

  // 5. 入站 Responses WS：同一连接的续接在原上游 WS 上原生发送 previous_response_id
  const before = fake.state.wsConnections
  const ws = new WebSocket(`${gw.baseUrl.replace('http', 'ws')}/v1/responses`, { headers })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  const nextCompleted = () =>
    new Promise((resolve) => {
      const onMessage = (raw) => {
        const frame = JSON.parse(String(raw))
        if (frame.type === 'response.completed' || frame.type === 'error') {
          ws.off('message', onMessage)
          resolve(frame)
        }
      }
      ws.on('message', onMessage)
    })
  ws.send(JSON.stringify({ type: 'response.create', model, input: 'one' }))
  const first = await nextCompleted()
  assert.equal(first.type, 'response.completed', JSON.stringify(first))
  ws.send(JSON.stringify({ type: 'response.create', model, input: 'two', previous_response_id: first.response.id }))
  const second = await nextCompleted()
  assert.equal(second.type, 'response.completed', JSON.stringify(second))
  ws.close()
  const continued = fake.state.ws.filter((item) => item.frame.previous_response_id === first.response.id)
  assert.equal(continued.length, 1, 'continuation was not sent natively on the upstream WS')
  assert.equal(fake.state.wsConnections - before, 1, 'continuation opened a new upstream connection')

  // 6. Codex Live：SDP 引导经 Worker 选号发往 ChatGPT；sideband 中继到钉住账号；hangup 删除登记
  const call = await fetch(`${gw.baseUrl}/v1/realtime/calls`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/sdp' },
    body: 'v=0 offer',
  })
  assert.equal(call.status, 201, await call.clone().text())
  assert.equal(await call.text(), 'v=0 answer')
  assert.equal(call.headers.get('location'), '/v1/realtime/calls/rtc_e2e')
  assert.equal(fake.state.live.length, 1)
  assert.equal(fake.state.live[0].query, '?intent=quicksilver&architecture=avas')
  assert.equal(JSON.parse(fake.state.live[0].body).sdp, 'v=0 offer')
  assert.equal(fake.state.live[0].headers.authorization, 'Bearer tok_e2e')
  const side = new WebSocket(`${gw.baseUrl.replace('http', 'ws')}/v1/realtime/calls/rtc_e2e`, ['realtime'], { headers })
  await new Promise((resolve, reject) => {
    side.once('open', resolve)
    side.once('error', reject)
    side.once('unexpected-response', (_req, res) => reject(new Error(`sideband ${res.statusCode} ${workerLog()}`)))
  })
  assert.equal(side.protocol, 'realtime')
  const echoed = new Promise((resolve) => side.once('message', (raw) => resolve(String(raw))))
  side.send('{"type":"session.update"}')
  assert.equal(await echoed, 'echo:{"type":"session.update"}')
  side.close()
  assert.equal(fake.state.sideband[0].url, '/v1/realtime/calls/rtc_e2e')
  assert.equal(fake.state.sideband[0].headers.authorization, 'Bearer tok_e2e')
  const hangup = await api(gw, 'POST', '/v1/realtime/calls/rtc_e2e/hangup', { headers, body: {} })
  assert.equal(hangup.status, 200, hangup.text)
  assert.equal(fake.state.hangup.length, 1)
  const unsupported = await api(gw, 'POST', '/v1/realtime/client_secrets', { headers, body: {} })
  assert.equal(unsupported.status, 501)

  // Receipt 回到控制面：usage 按 VM 口径记账，额度头不下发给客户端
  const receipts = await waitFor(async () => {
    const items = data(await panel('GET', `codex-accounts/${account.id}`))?.receipts || []
    return items.length >= 4 && items
  })
  assert.ok(receipts.every((item) => item.runtime_account_id === account.runtime_account_id))
  assert.equal(viaHttp.headers.get('x-codex-primary-used-percent'), null)

  // 执行事件：Worker 每个分发都写 request.finalized；shadow 下与回执逐个匹配，primary 下由事件写入回执
  const inbox = () => {
    const db = new DatabaseSync(path.join(gw.project, 'data', 'kin.db'), { readOnly: true })
    try {
      return db.prepare("SELECT type,mode,status FROM executor_event_inbox WHERE type='request.finalized'").all()
    } finally {
      db.close()
    }
  }
  if (eventsMode === 'off') assert.equal(inbox().length, 0)
  else {
    const expected = eventsMode === 'shadow' ? 'matched' : 'applied'
    const rows = await waitFor(() => {
      const items = inbox()
      return items.length >= receipts.length && items.every((row) => row.status === expected) && items
    })
    assert.ok(rows.every((row) => row.mode === eventsMode))
    // 回放比对（P2 阶段标准）：计费字段与请求尝试条数逐个一致
    const db = new DatabaseSync(path.join(gw.project, 'data', 'kin.db'), { readOnly: true })
    try {
      // 实时尝试经写回队列落库，读到的可能稍晚：等差异清零（超时则报出最后一次的差异）
      let report
      try {
        report = await waitFor(() => {
          report = diffDatabase(db, { sinceHours: 1 })
          return report.differing.length === 0 && report
        })
      } catch {}
      assert.ok(report.checked >= receipts.length)
      assert.deepEqual(report.differing, [])
      // 交付时不写请求尝试的只有语音通话与搜索各一次（primary 下 60 秒后由事件补齐）
      assert.equal(report.attempts_pending, 2)
    } finally {
      db.close()
    }
  }

  // 手动刷新：刷新租约恒开（G1），Worker 先申请租约，换票后报告轮换结果与新令牌指纹
  const refreshed = await panel('POST', `codex-accounts/${account.id}/refresh`, {})
  assert.equal(refreshed.status, 200, refreshed.text + workerLog())
  assert.equal(fake.state.tokenRefreshes, 1)
  {
    const db = new DatabaseSync(path.join(gw.project, 'data', 'kin.db'), { readOnly: true })
    try {
      const leases = db.prepare("SELECT * FROM credential_refresh_leases WHERE grant_kind='native'").all()
      assert.equal(leases.length, 1, workerLog())
      const fingerprint = crypto.createHash('sha256').update('rt_e2e_2').digest('hex').slice(0, 16)
      assert.deepEqual(
        [leases[0].holder_instance_id, leases[0].state, leases[0].outcome, leases[0].token_fingerprint],
        ['gw_e2e', 'released', 'rotated', fingerprint],
      )
      // 凭据库：导入时收录代次 1，刷新租约报告轮换后按 CAS 写入代次 2；库里没有明文
      const vaultRows = db.prepare("SELECT * FROM executor_credentials WHERE grant_kind='native'").all()
      assert.equal(vaultRows.length, 1, workerLog())
      assert.deepEqual(
        [vaultRows[0].revision, vaultRows[0].token_fingerprint, vaultRows[0].source],
        [2, fingerprint, 'refresh'],
      )
      assert.ok(!JSON.stringify(vaultRows).includes('rt_e2e_2'))
    } finally {
      db.close()
    }
  }

  // 迁移工具（P3.8）：凭据固定由控制面托管（G1），导入与轮换都已写入凭据库，演练结果为 current
  if (eventsMode !== 'off') {
    const db = createDatabase({ dataDir: path.join(gw.project, 'data') })
    try {
      const env = { KIN_CODEX_GATEWAY_INTERNAL_TOKEN: secret, KIN_CODEX_GATEWAY_CREDENTIAL_BUNDLE_KEY: bundleKey }
      const dry = await migrateWorkerCredentials({ db, env })
      const item = dry.items.find((entry) => entry.account_resource_id === account.id)
      assert.equal(item?.native, 'current', JSON.stringify(dry))
    } finally {
      db.close()
    }
  }

  // 托管进程崩溃后控制面按退避重启，新进程重新注册并可继续服务。
  // 等到新进程以新的 boot_id 登记：崩溃前最后一次心跳在 45 秒内仍显示 healthy，不能作为新进程就绪的依据
  const bootBefore = await waitFor(
    async () => data(await panel('GET', 'gateway-workers'))?.items?.find((item) => item.id === 'gw_e2e')?.boot_id,
  )
  process.kill(supervised.pid, 'SIGKILL')
  const restarted = await waitFor(async () => {
    const body = data(await panel('GET', 'gateway-workers'))
    const instance = (body?.items || []).find((item) => item.id === 'gw_e2e')
    return (
      body?.supervisor?.status === 'running' &&
      body.supervisor.pid !== supervised.pid &&
      body.supervisor.restarts >= 1 &&
      instance?.health_state === 'healthy' &&
      instance.boot_id &&
      instance.boot_id !== bootBefore &&
      body.supervisor
    )
  })
  assert.equal(restarted.last_exit.signal, 'SIGKILL')
  const afterRestart = await api(gw, 'POST', '/v1/responses', { headers, body: { model, input: 'hi', stream: true } })
  assert.equal(afterRestart.status, 200, afterRestart.text + workerLog())
}
