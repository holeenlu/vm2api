import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'
import { startGateway, api, REPO_ROOT, pickFreePort } from '../harness.mjs'
import { buildGatewayHeaders } from '../../src/lib/gateway-worker/gateway-auth.mjs'

// 降级演练（中期技术债 M3，ACCEPTANCE 第 5 条）：控制面 + 外部真实 Go Worker，结算只走事件通道。
//   A. 控制面宕机（SIGKILL）：Worker 继续运行，宕机期间产生的事件留在本地、不自行确认；同一数据目录重启控制面后全部补交，
//      收件箱与 Worker 事件日志的序号逐个对上，回执与使用记录数量正确，executor-replay-diff 无差异。
//   B. 控制面数据库不可用（见文件后半）。
// 不调用真实 OpenAI；没有 Go 工具链且未提供 KIN_CODEX_GATEWAY_BIN 时跳过（CI 设置 KIN_E2E_REQUIRE_GO=1 时失败）。

function goBinary() {
  if (process.env.KIN_CODEX_GATEWAY_BIN) return { bin: process.env.KIN_CODEX_GATEWAY_BIN }
  const go = spawnSync('go', ['version'], { encoding: 'utf8' })
  if (go.status !== 0) {
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

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(fn, { timeoutMs = 30_000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await fn()
    if (last) return last
    await delay(intervalMs)
  }
  throw new Error(`timed out waiting: ${JSON.stringify(last)}`)
}

// 最小 SOCKS5 代理（账号导入需要代理地址，账号出站经它连到假上游）
const isLoopbackHost = (host) => host === 'localhost' || host.startsWith('127.') || host === '::1'

function startForwardProxy() {
  return net.createServer((client) => {
    client.on('error', () => client.destroy())
    client.once('data', () => {
      client.write(Buffer.from([5, 0]))
      client.once('data', (buf) => {
        const type = buf[3]
        const addrLen = type === 1 ? 4 : 1 + buf[4]
        const host =
          type === 3 ? buf.subarray(5, 5 + buf[4]).toString('latin1') : Array.from(buf.subarray(4, 8)).join('.')
        const port = buf.readUInt16BE(4 + addrLen)
        // 控制面重启后代理池会经本机转发探测公网目标（1.1.1.1:443 TLS，失败再走 8.8.8.8:53 DNS）：
        // 这里不外连，TLS 目标直接拒绝，DNS 目标就地回一个合法应答，e2e 全程不产生外部连接（worker-e2e 的 strace 检查）
        if (!isLoopbackHost(host)) {
          if (port !== 53) {
            client.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]))
            return
          }
          client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]))
          let dns = Buffer.alloc(0)
          client.on('data', (chunk) => {
            dns = Buffer.concat([dns, chunk])
            if (dns.length < 2 || dns.length < 2 + dns.readUInt16BE(0)) return
            const reply = Buffer.from(dns.subarray(2, 2 + dns.readUInt16BE(0)))
            reply.writeUInt16BE(0x8180, 2)
            const frame = Buffer.alloc(2 + reply.length)
            frame.writeUInt16BE(reply.length, 0)
            reply.copy(frame, 2)
            client.end(frame)
          })
          return
        }
        const upstream = net.connect(port, host, () => {
          client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]))
          client.pipe(upstream).pipe(client)
        })
        upstream.on('error', () => client.destroy())
        client.on('close', () => upstream.destroy())
      })
    })
  })
}

// 假 ChatGPT（HTTP/SSE）：正文含 hold-me 的请求只发出开头就挂住（模拟控制面宕机时仍在执行的流），其余正常完成。
// 每个响应带额度头，挂住的请求带不同的用量百分比，让 Worker 在控制面宕机期间也产生额度事件。
function startFakeChatGPT() {
  const state = { requests: 0, held: new Set(), turn: 0, refreshes: 0 }
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    let body = Buffer.concat(chunks)
    if (req.headers['content-encoding'] === 'zstd') body = zlib.zstdDecompressSync(body)
    const raw = body.toString('utf8')
    const pathname = new URL(req.url, 'http://upstream').pathname
    if (pathname === '/oauth/token') {
      state.refreshes++
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ access_token: 'tok_outage_2', refresh_token: 'rt_outage_2', expires_in: 3600 }))
    }
    if (pathname !== '/backend-api/codex/responses') {
      res.writeHead(404, { 'content-type': 'application/json' })
      return res.end('{"error":{"code":"not_found"}}')
    }
    state.requests++
    const hold = raw.includes('hold-me')
    const id = `resp_outage_${++state.turn}`
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'x-codex-primary-used-percent': hold ? '57' : '12',
      'x-codex-primary-window-minutes': '300',
      'x-codex-secondary-used-percent': '3',
      'x-codex-secondary-window-minutes': '10080',
    })
    const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`)
    send({ type: 'response.created', response: { id, model: 'gpt-e2e' } })
    send({ type: 'response.output_text.delta', delta: 'po' })
    const finish = () => {
      send({ type: 'response.output_text.delta', delta: 'ng' })
      send({
        type: 'response.completed',
        response: {
          id,
          model: 'gpt-e2e',
          usage: { input_tokens: 7, input_tokens_details: { cached_tokens: 2 }, output_tokens: 3 },
        },
      })
      res.end()
    }
    if (hold) {
      state.held.add(res)
      res.finishStream = finish
      res.on('close', () => state.held.delete(res))
      return
    }
    finish()
  })
  // 让挂住的请求正常完成
  state.release = () => {
    for (const res of state.held) res.finishStream()
  }
  return { server, state }
}

const built = goBinary()
const t0 = Date.now()
const step = (msg) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`)

/**
 * 控制面（可杀掉后用同一数据目录、同一端口重启）+ 一个外部 Worker + 一个已投影的 Codex 账号与 API Key。
 * 外部 Worker 不随控制面退出：控制面宕机期间 Worker 照常运行。
 */
async function startChain(t, { group: groupOptions = {}, balance = 0 } = {}) {
  const secret = crypto.randomUUID()
  const bundleKey = crypto.randomBytes(32).toString('hex')
  const fake = startFakeChatGPT()
  const upstreamPort = await listen(fake.server)
  const proxy = startForwardProxy()
  const proxyPort = await listen(proxy)
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-outage-'))
  const cpPort = await pickFreePort()
  const dbSecret = crypto.randomBytes(32).toString('hex')
  const cpEnv = {
    // 用例轮询面板接口很密，放宽主密钥限流（同 gateway-worker-real）
    KIN_RATE_CAP: '100000',
    KIN_RATE_REFILL: '1000',
    KIN_CODEX_GATEWAY_RELEASE_CHECK: 'off',
    KIN_CODEX_GATEWAY_INTERNAL_TOKEN: secret,
    KIN_CODEX_GATEWAY_CREDENTIAL_BUNDLE_KEY: bundleKey,
    KIN_CODEX_GATEWAY_SUPERVISE: '0',
    // Worker 直读控制面库（G4）：字段加密密钥显式给出，同一个值传给外部 Worker
    TAPMODELS_DB_SECRET: dbSecret,
  }
  const chain = {
    secret,
    fake,
    project,
    gw: null,
    dbPath: path.join(project, 'data', 'kin.db'),
    async startControlPlane() {
      chain.gw = await startGateway({ project, port: cpPort, disableWatchdog: true, env: cpEnv, readyMs: 20_000 })
      return chain.gw
    },
    // 模拟宕机：SIGKILL，不走平滑停机
    async killControlPlane() {
      const child = chain.gw.child
      if (child.exitCode != null || child.signalCode != null) return
      const exited = new Promise((resolve) => child.once('exit', resolve))
      child.kill('SIGKILL')
      await exited
    },
  }
  await chain.startControlPlane()
  const workerPort = await pickFreePort()
  const workerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-outage-worker-'))
  let workerLog = ''
  const worker = spawn(built.bin, [], {
    env: {
      ...process.env,
      KIN_CODEX_GATEWAY_LISTEN: `127.0.0.1:${workerPort}`,
      KIN_CODEX_GATEWAY_ADVERTISE_URL: `http://127.0.0.1:${workerPort}`,
      KIN_CODEX_GATEWAY_INSTANCE_ID: 'gw_outage',
      KIN_CODEX_GATEWAY_FACTS_DB: chain.dbPath,
      TAPMODELS_DB_SECRET: dbSecret,
      KIN_CODEX_GATEWAY_RELEASE_CHECK: 'off',
      KIN_CODEX_GATEWAY_DATA_DIR: workerDir,
      KIN_CODEX_GATEWAY_INTERNAL_TOKEN: secret,
      KIN_CODEX_GATEWAY_CREDENTIAL_BUNDLE_KEY: bundleKey,
      KIN_CODEX_GATEWAY_CONTROL_PLANE_URL: `http://127.0.0.1:${cpPort}/internal/v1/gateway/workers/register`,
      KIN_CODEX_GATEWAY_UPSTREAM_BASE_URL: `http://127.0.0.1:${upstreamPort}/backend-api/codex`,
      KIN_CODEX_GATEWAY_UPSTREAM_TRANSPORT: 'http',
      KIN_CODEX_GATEWAY_OAUTH_TOKEN_URL: `http://127.0.0.1:${upstreamPort}/oauth/token`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  worker.stdout.on('data', (chunk) => (workerLog += chunk))
  worker.stderr.on('data', (chunk) => (workerLog += chunk))
  t.after(async () => {
    if (worker.exitCode == null) {
      const exited = new Promise((resolve) => worker.once('exit', resolve))
      worker.kill('SIGTERM')
      await exited
    }
    await chain.gw?.stop()
    for (const res of fake.state.held) res.destroy()
    fake.server.closeAllConnections?.()
    fake.server.close()
    proxy.close()
    fs.rmSync(workerDir, { recursive: true, force: true })
    if (process.platform === 'darwin') spawnSync('chflags', ['-R', 'nouchg', project])
    fs.rmSync(project, { recursive: true, force: true })
  })
  chain.workerDir = workerDir
  chain.logs = () => `--- worker\n${workerLog}\n--- control plane\n${chain.gw?.stdout()}${chain.gw?.stderr()}`
  const panel = (method, suffix, body) => api(chain.gw, method, `/api/panel/${suffix}`, { body })
  const data = (r) => r.json?.data ?? r.json
  chain.panel = panel
  chain.data = data
  chain.query = (sql, ...args) => {
    const db = new DatabaseSync(chain.dbPath, { readOnly: true })
    try {
      return db.prepare(sql).all(...args)
    } finally {
      db.close()
    }
  }
  // Worker 健康接口：共用令牌可读（只读探测），返回事件日志水位
  chain.workerHealth = async () => {
    const response = await fetch(`http://127.0.0.1:${workerPort}/internal/v1/health`, {
      headers: buildGatewayHeaders({ secret, body: '' }),
    }).catch(() => null)
    return response ? response.json().catch(() => null) : null
  }
  chain.instance = async () =>
    (data(await panel('GET', 'gateway-workers'))?.items || []).find((item) => item.id === 'gw_outage')

  // 外部 Worker（共用令牌，2026-11-07 S4 起不再有实例密钥与批准）：账号配置与凭据由 Worker 直读控制面库
  await waitFor(async () => (await chain.instance())?.health_state === 'healthy', { timeoutMs: 45_000 }).catch(
    (error) => assert.fail(`${error.message}\n${chain.logs()}`),
  )

  const group = data(
    await panel('POST', 'groups', { name: 'Codex Outage', platform: 'openai', rate_multiplier: 0, ...groupOptions }),
  ).item
  const user = data(
    await panel('POST', 'users', { username: 'gw-outage', password: 'gw-outage-pass', concurrency: 20 }),
  ).item
  await panel('PUT', `users/${user.id}/groups`, { groups: [{ group_id: group.id }] })
  if (balance > 0) {
    const credited = await panel('POST', `users/${user.id}/balance`, {
      amount: balance,
      reason: 'drill',
      idempotency_key: `credit-${crypto.randomUUID()}`,
    })
    assert.equal(credited.status, 200, credited.text)
  }
  const draft = data(
    await panel('POST', 'codex-accounts/drafts', {
      name: 'Outage Codex',
      group_ids: [group.id],
      proxy_endpoint: `socks5://127.0.0.1:${proxyPort}`,
      max_concurrency: 8,
      idempotency_key: crypto.randomUUID(),
    }),
  )
  const imported = await panel('POST', `codex-accounts/drafts/${draft.draft.id}/import`, {
    access_token: 'tok_outage',
    refresh_token: 'rt_outage',
    chatgpt_account_id: 'acct_outage',
    email: 'outage@example.test',
  })
  assert.equal(imported.status, 200, imported.text + chain.logs())
  chain.account = data(imported).account
  await waitFor(
    async () => data(await panel('GET', `codex-accounts/${chain.account.id}`))?.account?.projection_status === 'synced',
    { timeoutMs: 45_000 },
  ).catch((error) => assert.fail(`${error.message}\n${chain.logs()}`))
  await panel('POST', `codex-accounts/${chain.account.id}/resume`, {})
  chain.user = user
  chain.key = data(
    await panel('POST', 'api-keys', { name: 'Outage', user_id: user.id, group_id: group.id, max_concurrency: 10 }),
  ).item
  chain.headers = { authorization: `Bearer ${chain.key.key}` }
  const models = await api(chain.gw, 'GET', '/v1/models', { headers: chain.headers })
  chain.model = models.json?.data?.find((m) => /^gpt-/.test(m.id) && !/image/.test(m.id))?.id
  assert.ok(chain.model, models.text)
  chain.chat = () =>
    Promise.race([
      api(chain.gw, 'POST', '/v1/chat/completions', {
        headers: chain.headers,
        body: { model: chain.model, stream: false, messages: [{ role: 'user', content: 'hi' }] },
      }),
      delay(30_000).then(() => assert.fail(`chat request hung\n${chain.logs()}`)),
    ])
  // 事件链路就绪：Worker 已从心跳得知控制面必需事件
  await waitFor(async () => (await chain.workerHealth())?.events?.required === true, { timeoutMs: 45_000 })
  return chain
}

// 收件箱里本实例当前流的事件
function inboxRows(chain, streamId) {
  return chain.query(
    'SELECT event_id,seq,type,status FROM executor_event_inbox WHERE instance_id=? AND stream_id=? ORDER BY seq',
    'gw_outage',
    streamId,
  )
}

function replayDiffCli(dbPath) {
  return spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, 'scripts/executor-replay-diff.mjs'), '--db', dbPath, '--since-hours', '1'],
    {
      encoding: 'utf8',
    },
  )
}

test('drill A: the control plane is killed while events are required; the Worker keeps them unacknowledged and every one is delivered after restart', {
  skip: built.skip,
  timeout: 240_000,
}, async (t) => {
  const chain = await startChain(t)

  // 1. 正常阶段：请求的事件被消费，Worker 的确认序号追上 head
  for (let i = 0; i < 3; i++) {
    const response = await chain.chat()
    assert.equal(response.status, 200, response.text + chain.logs())
    assert.equal(response.json.choices[0].message.content, 'pong')
  }
  const steady = await waitFor(async () => {
    const health = await chain.workerHealth()
    const finalized = chain.query(
      "SELECT COUNT(*) AS n FROM executor_event_inbox WHERE type='request.finalized' AND status='applied'",
    )[0].n
    return finalized === 3 && health?.events?.acked === health?.events?.head && health.events
  }).catch((error) => assert.fail(`${error.message}\n${chain.logs()}`))
  assert.equal(steady.required, true)
  const streamId = steady.stream_id

  // 2. 三个流式请求在途（上游只发出开头就挂住），此时 SIGKILL 控制面
  const inflight = Array.from({ length: 3 }, () =>
    api(chain.gw, 'POST', '/v1/responses', {
      headers: chain.headers,
      body: { model: chain.model, input: 'hold-me', stream: true },
    }).catch((error) => ({ status: 0, error })),
  )
  const settledInflight = inflight.map((p) => p.then((r) => [r.status, r.text?.slice(0, 200)]))
  const outcomes = []
  for (const p of settledInflight) p.then((r) => outcomes.push(r))
  await waitFor(() => chain.fake.state.held.size === 3).catch((error) =>
    assert.fail(
      `${error.message} held=${chain.fake.state.held.size} upstream=${chain.fake.state.requests} finished=${JSON.stringify(outcomes)}\n${chain.logs()}`,
    ),
  )
  const atKill = (await chain.workerHealth()).events
  step('SIGKILL the control plane with three streams in flight')
  await chain.killControlPlane()
  const killedAt = Date.now()
  for (const result of await Promise.all(inflight))
    assert.notEqual(result.status, 200, 'the in-flight stream cannot complete through a dead control plane')

  // 宕机期间：调用方连接随控制面断开，Worker 取消上游并为每个在途分发写 request.finalized（以及额度变化）；
  // 事件必需，Worker 不自行确认：head 前进，acked 不动。等过至少一个维护周期（10 秒）再确认 acked 仍未变化
  const during = await waitFor(async () => {
    const health = await chain.workerHealth()
    return health?.events?.head >= atKill.head + 3 && health.events
  }).catch((error) => assert.fail(`${error.message}\n${chain.logs()}`))
  assert.equal(chain.fake.state.held.size, 0, 'the Worker cancelled the upstream requests')
  await delay(Math.max(0, 12_000 - (Date.now() - killedAt)))
  const beforeRestart = (await chain.workerHealth()).events
  assert.equal(beforeRestart.required, true, 'the last known policy (required) is kept while the control plane is down')
  assert.equal(beforeRestart.acked, atKill.acked, 'the Worker never acknowledges required events on its own')
  assert.ok(beforeRestart.head >= during.head)
  assert.equal(beforeRestart.stream_id, streamId)
  // 结算只走事件：宕机期间的 request.finalized 留在 Worker 事件日志（未确认），恢复后补交
  const outageEvents = beforeRestart.head - atKill.head

  // 3. 同一数据目录、同一端口重启控制面：Worker 下一次心跳重新连上，宕机期间的事件全部补交并被消费
  step('restart the control plane on the same data directory')
  await chain.startControlPlane()
  const caughtUp = await waitFor(
    async () => {
      const health = await chain.workerHealth()
      const head = health?.events?.head
      const rows = inboxRows(chain, streamId)
      return head && health.events.acked === head && rows.length === head && rows.at(-1).seq === head && health.events
    },
    { timeoutMs: 60_000 },
  ).catch((error) => assert.fail(`${error.message}\n${chain.logs()}`))
  const rows = inboxRows(chain, streamId)
  // 序号 1..head 逐个都在、没有重复，全部处理成功（account.state 追赶时可能是 stale）
  assert.deepEqual(
    rows.map((row) => row.seq),
    Array.from({ length: caughtUp.head }, (_, i) => i + 1),
  )
  assert.equal(new Set(rows.map((row) => row.event_id)).size, rows.length)
  assert.deepEqual(
    rows.filter((row) => !['applied', 'stale'].includes(row.status)),
    [],
    'every event was processed',
  )
  const finalized = rows.filter((row) => row.type === 'request.finalized')
  assert.equal(finalized.length, 6, 'three before the outage, three cut off in flight')
  const outageRows = rows.filter((row) => row.seq > atKill.head)
  assert.equal(outageRows.length, outageEvents)
  assert.equal(outageRows.filter((row) => row.type === 'request.finalized').length, 3)

  // 回执：每个 request.finalized 一张（事件入库按（实例, dispatch）幂等）；在途的三个已发往上游、
  // 调用方随控制面断开，Worker 记为 ambiguous（结果不明，按回执对账）；
  // 使用记录：六个分发各一条——宕机前完成的三个正常收口，在途的三个由重启后的在途记录扫描补写
  // （审计阶段 1 W2：`billing_inflight` 孤儿扫描写 ambiguous 使用记录并补入对账队列），不再是看不见的盲区
  const receipts = chain.query('SELECT dispatch_id,terminal_state FROM gateway_worker_receipts')
  assert.equal(receipts.length, 6)
  assert.equal(receipts.filter((row) => row.terminal_state === 'ambiguous').length, 3, JSON.stringify(receipts))
  const usage = await waitFor(
    () => {
      const rows = chain.query(
        "SELECT request_id,final_state,error_code,billing_status FROM usage_logs WHERE execution_kind='gateway_worker' ORDER BY rowid",
      )
      return rows.length === 6 && rows
    },
    { timeoutMs: 30_000 },
  ).catch((error) => assert.fail(`${error.message}\n${chain.logs()}`))
  const interrupted = usage.filter((row) => row.error_code === 'process_interrupted')
  assert.equal(interrupted.length, 3, JSON.stringify(usage))
  assert.deepEqual(
    [...new Set(interrupted.map((row) => row.final_state))],
    ['ambiguous'],
    'the cut-off in-flight requests are visible and reconciled, never charged as completed',
  )

  // 4. 回放比对：differing 0、inbox problems 0
  const diff = replayDiffCli(chain.dbPath)
  assert.equal(diff.status, 0, diff.stdout + diff.stderr)
  assert.match(diff.stdout, /differing 0, inbox problems 0/)
  assert.match(diff.stdout, /events checked 6,/)

  // 恢复后照常接单
  const after = await chain.chat()
  assert.equal(after.status, 200, after.text + chain.logs())
  console.log(
    `[drill A] stream ${streamId}: acked=head=${atKill.head} at kill; worker head ${beforeRestart.head} (acked ${beforeRestart.acked}) after ${Math.round((Date.now() - killedAt) / 1000)}s down; ` +
      `${outageEvents} events produced during the outage (${outageRows.map((row) => `${row.seq}:${row.type}`).join(', ')}); ` +
      `inbox ${rows.length} rows = seq 1..${caughtUp.head}; receipts ${receipts.length}; ${diff.stdout.split('\n')[0]}`,
  )
})

// 另一个进程（运维脚本、手工 sqlite3 会话、备份工具）对控制面数据库持有写锁，直到 release()
async function holdWriteLock(dbPath) {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `const { DatabaseSync } = require('node:sqlite')
       const db = new DatabaseSync(process.env.DRILL_DB)
       db.exec('PRAGMA busy_timeout = 10000')
       db.exec('BEGIN IMMEDIATE')
       console.log('locked')
       process.stdin.once('data', () => { db.exec('ROLLBACK'); db.close(); process.exit(0) })`,
    ],
    { env: { ...process.env, DRILL_DB: dbPath }, stdio: ['pipe', 'pipe', 'inherit'] },
  )
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve)
    child.once('exit', (code) => reject(new Error(`lock holder exited ${code}`)))
  })
  return {
    child,
    async release() {
      if (child.exitCode != null) return
      const exited = new Promise((resolve) => child.once('exit', resolve))
      child.stdin.write('release\n')
      await exited
    },
  }
}

async function healthz(gw, endpoint = '/healthz') {
  const started = Date.now()
  const response = await fetch(`${gw.baseUrl}${endpoint}`)
  return {
    status: response.status,
    retryAfter: response.headers.get('retry-after'),
    body: await response.json().catch(() => null),
    ms: Date.now() - started,
  }
}

// 就绪接口：数据库写不进去时 503（M3 复审 P1-4）；/healthz 仍是存活检查
const readyz = (gw) => healthz(gw, '/readyz')

test('drill B1: another process holds the database write lock; billing is refused, nothing is lost and everything catches up without a restart', {
  skip: built.skip,
  timeout: 240_000,
}, async (t) => {
  const chain = await startChain(t, { group: { rate_multiplier: 1 }, balance: 10 })
  const settled = () =>
    chain.query(
      "SELECT u.request_id,u.billing_status,c.request_id AS charged FROM usage_logs u LEFT JOIN billing_charges c ON c.request_id=u.request_id WHERE u.execution_kind='gateway_worker' ORDER BY u.rowid",
    )
  const baseline = await chain.chat()
  assert.equal(baseline.status, 200, baseline.text + chain.logs())
  await waitFor(() => {
    const rows = settled()
    return rows.length === 1 && rows[0].charged && rows[0].billing_status !== 'settlement_pending' && rows
  }).catch((error) => assert.fail(`${error.message}\n${chain.logs()}`))
  assert.equal((await healthz(chain.gw)).status, 200)
  assert.equal((await readyz(chain.gw)).status, 200)
  const beforeLock = await waitFor(async () => {
    const events = (await chain.workerHealth())?.events
    return events?.acked === events?.head && events
  })

  // 1. 请求 R1 已通过准入、在上游执行中；此时另一个进程拿走写锁，R1 随后完成，它的收口（结算 + 使用记录）写不进去
  const r1 = api(chain.gw, 'POST', '/v1/responses', {
    headers: chain.headers,
    body: { model: chain.model, input: 'hold-me', stream: true },
  })
  await waitFor(() => chain.fake.state.held.size === 1)
  const lock = await holdWriteLock(chain.dbPath)
  t.after(() => lock.release())
  const lockedAt = Date.now()
  chain.fake.state.release()
  const r1Response = await r1
  assert.equal(r1Response.status, 200, r1Response.text)
  assert.match(r1Response.text, /response\.completed/, 'the client gets the complete answer')

  // 2. /readyz 反映故障：503 degraded（带 Retry-After，不暴露错误细节）；/healthz 仍是 200 存活，只带 degraded 标志。
  //    降级后写入快速失败，两个接口都不再被写锁冻住
  const degraded = await waitFor(async () => {
    const probe = await readyz(chain.gw)
    return probe.status === 503 && probe
  }).catch((error) => assert.fail(`${error.message}\n${chain.logs()}`))
  assert.deepEqual(degraded.body, { status: 'degraded' })
  assert.equal(degraded.retryAfter, '5')
  const live = await healthz(chain.gw)
  assert.equal(live.status, 200)
  assert.deepEqual(live.body, { status: 'ok', degraded: true })
  const samples = []
  for (let i = 0; i < 10; i++) {
    samples.push((await healthz(chain.gw)).ms, (await readyz(chain.gw)).ms)
    await delay(100)
  }
  assert.ok(Math.max(...samples) < 1000, `healthz / readyz stay responsive while degraded: ${samples}`)

  // 3. 计费请求在准入时拒绝（503 database_unavailable），不发往上游
  const upstreamBefore = chain.fake.state.requests
  const r2 = await chain.chat()
  assert.equal(r2.status, 503, r2.text)
  assert.equal(r2.json?.error?.code, 'database_unavailable')
  assert.equal(r2.headers.get('retry-after'), '5')
  assert.equal(chain.fake.state.requests, upstreamBefore, 'a refused request is not sent upstream')

  // 4. 面板：数据库读探测仍正常，但写入健康显示失败、R1 的收口在等待重试
  const metrics = chain.data(await chain.panel('GET', 'database/metrics'))
  assert.equal(metrics?.write_health?.writable, false, JSON.stringify(metrics?.write_health))
  assert.equal(metrics.write_health.last_error_code, 'SQLITE_BUSY', 'details are only on the authenticated panel')
  assert.ok(metrics.write_health.settlement_retry.pending >= 1, JSON.stringify(metrics.write_health))

  // 5. Worker 侧：R1 的 request.finalized 已产生、未被确认（留在 Worker 事件日志）。
  //    凭据刷新（S1b）：Worker 换票后新令牌先落本地账号表，写回凭据库被写锁挡住，解锁后由后台循环补写
  const vaultRevision = () =>
    Number(chain.query("SELECT revision FROM executor_credentials WHERE grant_kind='native'")[0]?.revision || 0)
  const revisionBefore = vaultRevision()
  await chain.panel('POST', `codex-accounts/${chain.account.id}/refresh`, {})
  assert.equal(chain.fake.state.refreshes, 1, 'the Worker refreshes and keeps the new tokens locally')
  assert.equal(vaultRevision(), revisionBefore, 'the vault write waits for the lock')
  await delay(Math.max(0, 12_000 - (Date.now() - lockedAt)))
  const during = (await chain.workerHealth()).events
  assert.equal(during.acked, beforeLock.acked, 'events are not acknowledged while the control plane cannot store them')
  assert.ok(during.head > beforeLock.head)
  assert.equal(settled().length, 1, 'R1 has no usage row yet')
  assert.equal((await readyz(chain.gw)).status, 503)
  assert.equal((await healthz(chain.gw)).status, 200)

  // 6. 写锁释放：不重启，探测到可写即恢复；R1 的收口补写，回执与事件补交，结算完成
  await lock.release()
  const releasedAt = Date.now()
  await waitFor(async () => (await readyz(chain.gw)).status === 200, { timeoutMs: 10_000 })
  assert.deepEqual((await healthz(chain.gw)).body, { status: 'ok', degraded: false })
  const recoveredMs = Date.now() - releasedAt
  const rows = await waitFor(
    async () => {
      const list = settled()
      const events = (await chain.workerHealth())?.events
      return (
        list.length === 2 &&
        list.every((row) => row.charged && row.billing_status !== 'settlement_pending') &&
        events?.acked === events?.head &&
        list
      )
    },
    { timeoutMs: 60_000 },
  ).catch((error) => assert.fail(`${error.message}\n${chain.logs()}`))
  // R1 的使用记录按原始完成时刻记账（M3 复审 P2-4），不是补写时刻
  const r1Row = chain.query(
    "SELECT created_at AS ts FROM usage_logs WHERE execution_kind='gateway_worker' ORDER BY rowid DESC LIMIT 1",
  )[0]
  assert.ok(Date.parse(r1Row.ts) < releasedAt, `R1 ts ${r1Row.ts} is its completion time`)
  const finalHealth = (await chain.workerHealth()).events
  const inbox = inboxRows(chain, finalHealth.stream_id)
  assert.deepEqual(
    inbox.map((row) => row.seq),
    Array.from({ length: finalHealth.head }, (_, i) => i + 1),
  )
  assert.deepEqual(
    inbox.filter((row) => !['applied', 'stale'].includes(row.status)),
    [],
  )
  const recovered = chain.data(await chain.panel('GET', 'database/metrics')).write_health
  assert.equal(recovered.writable, true)
  assert.ok(recovered.recoveries >= 1 && recovered.settlement_retry.recovered >= 1, JSON.stringify(recovered))
  assert.equal(recovered.settlement_retry.pending, 0)
  assert.equal(
    fs.existsSync(path.join(chain.project, 'data', 'request-logs', 'pending-commits.jsonl')),
    false,
    'nothing was left for scripts/replay-pending-commits.mjs',
  )
  // 没有落到失败文件的使用记录（结算与使用记录经重试写入）；补写工具预览为 0
  const replay = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, 'scripts/replay-failed-usage-logs.mjs'), '--data-dir', path.join(chain.project, 'data')],
    { encoding: 'utf8' },
  )
  assert.equal(replay.status, 0, replay.stdout + replay.stderr)
  const diff = replayDiffCli(chain.dbPath)
  assert.equal(diff.status, 0, diff.stdout + diff.stderr)
  assert.match(diff.stdout, /differing 0, inbox problems 0/)
  // 恢复后：锁期间刷新出的令牌补写进凭据库（后台循环 30 秒一次），再刷新照常写回；计费请求照常
  await waitFor(() => vaultRevision() === revisionBefore + 1, { timeoutMs: 60_000 }).catch((error) =>
    assert.fail(`${error.message}\n${chain.logs()}`),
  )
  const refreshed = await chain.panel('POST', `codex-accounts/${chain.account.id}/refresh`, {})
  assert.equal(refreshed.status, 200, refreshed.text + chain.logs())
  assert.equal(chain.fake.state.refreshes, 2)
  assert.equal(vaultRevision(), revisionBefore + 2)
  const after = await chain.chat()
  assert.equal(after.status, 200, after.text)
  console.log(
    `[drill B1] lock held ${Math.round((releasedAt - lockedAt) / 1000)}s; readyz 503 (panel: ${metrics.write_health.last_error_code} since ${metrics.write_health.since}), healthz 200 degraded, ` +
      `samples ${samples.join('/')}ms; R2 503 database_unavailable; worker head ${beforeLock.head}->${during.head} acked ${during.acked}; ` +
      `recovered in ${recoveredMs}ms; usage rows ${rows.length} settled; inbox ${inbox.length} = seq 1..${finalHealth.head}; ` +
      `retry ${JSON.stringify(recovered.settlement_retry)}; replay preview: ${replay.stdout.trim()}; ${diff.stdout.split('\n')[0]}`,
  )
})

test('drill B2: the database file turns read-only; the control plane repairs its own file mode, and refuses to start on a read-only connection until fixed', {
  skip: built.skip,
  timeout: 240_000,
}, async (t) => {
  const chain = await startChain(t)
  const first = await chain.chat()
  assert.equal(first.status, 200, first.text)

  // 运行中改权限对已打开的连接无效（文件描述符保持可写）：照常写入
  fs.chmodSync(chain.dbPath, 0o444)
  const running = await chain.chat()
  assert.equal(running.status, 200, running.text)
  await waitFor(
    () => chain.query("SELECT COUNT(*) AS n FROM usage_logs WHERE execution_kind='gateway_worker'")[0].n === 2,
  )
  assert.equal((await healthz(chain.gw)).status, 200)

  // 权限改成只读后控制面重启：先把属于自己的文件改回 0600 再打开（此前 SQLite 会静默以只读打开，所有写入失败）
  await chain.killControlPlane()
  await chain.startControlPlane()
  assert.equal(fs.statSync(chain.dbPath).mode & 0o777, 0o600)
  const repaired = await chain.chat()
  assert.equal(repaired.status, 200, repaired.text)
  await waitFor(
    () => chain.query("SELECT COUNT(*) AS n FROM usage_logs WHERE execution_kind='gateway_worker'")[0].n === 3,
  )

  // 改不回来的只读（属主不同、只读挂载；macOS 上用不可变标志 uchg 复现）：拒绝启动并说明原因；
  // 期间 Worker 的事件留在本地，修复后启动补交
  if (process.platform !== 'darwin') {
    t.diagnostic('read-only connection at startup: reproduced with chflags uchg on macOS only; skipped here')
    return
  }
  const inflight = api(chain.gw, 'POST', '/v1/responses', {
    headers: chain.headers,
    body: { model: chain.model, input: 'hold-me', stream: true },
  }).catch(() => null)
  await waitFor(() => chain.fake.state.held.size === 1)
  const atKill = (await chain.workerHealth()).events
  await chain.killControlPlane()
  await inflight
  spawnSync('chflags', ['uchg', chain.dbPath])
  let refused = null
  try {
    await chain.startControlPlane()
  } catch (error) {
    refused = error
  }
  assert.ok(refused, 'the control plane must not run on a read-only connection')
  // 报错写明库文件、-wal / -shm 与所在目录的可写性（M3 复审 P2-9）
  assert.match(refused.message, /was opened read-only .*kin\.db is not writable.*-wal.*-shm.*directory/s)
  const waiting = await waitFor(async () => {
    const events = (await chain.workerHealth())?.events
    return events?.head > atKill.head && events
  })
  assert.equal(waiting.acked, atKill.acked)
  spawnSync('chflags', ['nouchg', chain.dbPath])
  await chain.startControlPlane()
  const caughtUp = await waitFor(
    async () => {
      const events = (await chain.workerHealth())?.events
      return events?.acked === events?.head && events.head >= waiting.head && events
    },
    { timeoutMs: 60_000 },
  ).catch((error) => assert.fail(`${error.message}\n${chain.logs()}`))
  const inbox = inboxRows(chain, caughtUp.stream_id)
  assert.deepEqual(
    inbox.map((row) => row.seq),
    Array.from({ length: caughtUp.head }, (_, i) => i + 1),
  )
  const after = await chain.chat()
  assert.equal(after.status, 200, after.text)
  console.log(
    `[drill B2] chmod 0444 while running: writes unaffected; restart repaired mode to 0600; uchg: start refused (${refused.message.split('\n')[0].slice(0, 160)}); ` +
      `worker head ${atKill.head}->${waiting.head} acked ${waiting.acked} while refused; after fix inbox seq 1..${caughtUp.head}`,
  )
})
