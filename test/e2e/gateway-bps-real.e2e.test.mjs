import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { startGateway, api, REPO_ROOT } from '../harness.mjs'

// 真实链路：控制面建 OAuth 账号 → 为它添加 BPS 附加授权（Go Worker 用 Excel 客户端换码）→ 配置 BPS 模型名单 →
// 名单内模型经 BPS 端点承接、名单外模型走原生 → 使用记录写入实际通道。
// 假上游同时提供 OAuth 令牌端点、BPS 端点与原生 Codex 端点；不调用真实 OpenAI。没有 Go 工具链时跳过。

function goBinary() {
  if (process.env.KIN_CODEX_GATEWAY_BIN) return { bin: process.env.KIN_CODEX_GATEWAY_BIN }
  const go = spawnSync('go', ['version'], { encoding: 'utf8' })
  if (go.status !== 0) return { skip: 'go toolchain not available' }
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kin-gw-bin-')), 'kin-codex-gateway')
  const build = spawnSync('go', ['build', '-o', out, './cmd/kin-codex-gateway'], {
    cwd: path.join(REPO_ROOT, 'worker'),
    encoding: 'utf8',
    env: { ...process.env, CGO_ENABLED: '0' },
  })
  if (build.status !== 0) throw new Error(`go build failed: ${build.stderr}`)
  return { bin: out }
}

const built = goBinary()

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

// 最小 SOCKS5 代理（无认证，CONNECT 到 IPv4 或域名）
function startSocksProxy() {
  return net.createServer((client) => {
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
        const addrLen = type === 1 ? 4 : 1 + buf[4]
        if (buf.length < 4 + addrLen + 2) return
        const host =
          type === 3 ? buf.subarray(5, 5 + buf[4]).toString('latin1') : Array.from(buf.subarray(4, 8)).join('.')
        const port = buf.readUInt16BE(4 + addrLen)
        const rest = buf.subarray(4 + addrLen + 2)
        stage = 'tunnel'
        client.off('data', onData)
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
}

function jwt(claims) {
  return `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`
}

function event(payload) {
  return `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`
}

function startFakeOpenAI() {
  const state = { token: [], bps: [], native: [] }
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    let bytes = Buffer.concat(chunks)
    // 原生 OAuth 推理正文按 Codex 合同 zstd 压缩
    if (req.headers['content-encoding'] === 'zstd') bytes = zlib.zstdDecompressSync(bytes)
    const raw = bytes.toString('utf8')
    const pathname = new URL(req.url, 'http://upstream').pathname
    if (pathname === '/oauth/token') {
      state.token.push(Object.fromEntries(new URLSearchParams(raw)))
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(
        JSON.stringify({
          access_token: jwt({ client_id: 'app_fnr0pYvVwwFDocDumLG3H2Bp' }),
          refresh_token: 'bps-refresh',
          id_token: jwt({
            email: 'bps@example.test',
            'https://api.openai.com/auth': { chatgpt_account_id: 'acct_bps', chatgpt_plan_type: 'pro' },
          }),
          expires_in: 3600,
        }),
      )
    }
    if (pathname === '/bps/responses') {
      state.bps.push({ headers: req.headers, body: JSON.parse(raw) })
      const message = {
        type: 'message',
        id: 'msg_bps',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'from-bps', annotations: [] }],
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(event({ type: 'response.created', response: { id: 'resp_bps', output: [] } }))
      res.write(
        event({
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'message', id: 'msg_bps', role: 'assistant', content: [] },
        }),
      )
      res.write(
        event({
          type: 'response.output_text.delta',
          output_index: 0,
          content_index: 0,
          item_id: 'msg_bps',
          delta: 'from-bps',
        }),
      )
      res.write(event({ type: 'response.output_item.done', output_index: 0, item: message }))
      res.write(
        event({
          type: 'response.completed',
          response: {
            id: 'resp_bps',
            status: 'completed',
            output: [message],
            usage: { input_tokens: 9, output_tokens: 4, total_tokens: 13 },
          },
        }),
      )
      return res.end()
    }
    if (pathname === '/backend-api/codex/responses') {
      state.native.push(raw ? JSON.parse(raw).model : null)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const payload of [
        { type: 'response.created', response: { id: 'resp_native', model: 'gpt-e2e' } },
        { type: 'response.output_text.delta', delta: 'from-native' },
        { type: 'response.completed', response: { id: 'resp_native', usage: { input_tokens: 3, output_tokens: 1 } } },
      ])
        res.write(`data: ${JSON.stringify(payload)}\n\n`)
      return res.end()
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":{"code":"not_found"}}')
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
  throw new Error(`condition not met: ${JSON.stringify(last)}`)
}

test('real Go Worker: an OAuth account adds a BPS grant; listed models use BPS, others stay native', {
  skip: built.skip,
  timeout: 120_000,
}, async (t) => {
  const secret = crypto.randomUUID()
  const fake = startFakeOpenAI()
  const upstreamPort = await listen(fake.server)
  const socks = startSocksProxy()
  const proxyPort = await listen(socks)
  const probe = net.createServer()
  const workerPort = await listen(probe)
  await new Promise((resolve) => probe.close(resolve))
  const workerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-gw-bps-'))
  const base = `http://127.0.0.1:${upstreamPort}`
  const gw = await startGateway({
    disableWatchdog: true,
    env: {
      KIN_CODEX_GATEWAY_INTERNAL_TOKEN: secret,
      KIN_CODEX_GATEWAY_SUPERVISE: '1',
      KIN_CODEX_GATEWAY_BIN: built.bin,
      KIN_CODEX_GATEWAY_LISTEN: `127.0.0.1:${workerPort}`,
      KIN_CODEX_GATEWAY_INSTANCE_ID: 'gw_bps',
      KIN_CODEX_GATEWAY_DATA_DIR: workerDir,
      KIN_CODEX_GATEWAY_RECEIPT_TOKEN: secret,
      KIN_CODEX_GATEWAY_CREDENTIAL_BUNDLE_KEY: crypto.randomBytes(32).toString('hex'),
      KIN_CODEX_GATEWAY_UPSTREAM_BASE_URL: `${base}/backend-api/codex`,
      KIN_CODEX_GATEWAY_UPSTREAM_TRANSPORT: 'http',
      KIN_CODEX_GATEWAY_OAUTH_TOKEN_URL: `${base}/oauth/token`,
      KIN_CODEX_GATEWAY_BPS_BASE_URL: `${base}/bps`,
    },
  })
  const workerLog = () => gw.stdout() + gw.stderr()
  t.after(async () => {
    await gw.stop()
    fake.server.closeAllConnections?.()
    fake.server.close()
    socks.close()
    fs.rmSync(workerDir, { recursive: true, force: true })
    fs.rmSync(gw.project, { recursive: true, force: true })
  })
  const panel = (method, suffix, body) => api(gw, method, `/api/panel/${suffix}`, { body })
  const data = (r) => r.json?.data ?? r.json

  await waitFor(async () =>
    (data(await panel('GET', 'gateway-workers'))?.items || []).find(
      (item) => item.id === 'gw_bps' && item.health_state === 'healthy',
    ),
  )
  const group = data(await panel('POST', 'groups', { name: 'BPS E2E', platform: 'openai', rate_multiplier: 0 })).item
  const user = data(await panel('POST', 'users', { username: 'bps-e2e', password: 'bps-e2e-pass' })).item
  await panel('PUT', `users/${user.id}/groups`, { groups: [{ group_id: group.id }] })

  // 运营端先用原生凭据建 OAuth 账号（BPS 是附加授权）
  const draft = data(
    await panel('POST', 'codex-accounts/drafts', {
      name: 'E2E BPS',
      group_ids: [group.id],
      proxy_endpoint: `socks5://127.0.0.1:${proxyPort}`,
      idempotency_key: crypto.randomUUID(),
    }),
  )
  assert.ok(draft?.draft?.id, JSON.stringify(draft))
  const imported = await panel('POST', `codex-accounts/drafts/${draft.draft.id}/import`, {
    access_token: 'tok_native',
    refresh_token: 'rt_native',
    chatgpt_account_id: 'acct_bps',
    email: 'bps@example.test',
  })
  assert.equal(imported.status, 200, imported.text + workerLog())
  const account = data(imported).account
  await waitFor(
    async () => data(await panel('GET', `codex-accounts/${account.id}`))?.account?.projection_status === 'synced',
  )
  await panel('POST', `codex-accounts/${account.id}/resume`, {})
  // 为同一账号添加 BPS 授权：授权链接是 Excel 插件地址，回调落在官方 bps.openai.com
  const bpsDraft = data(
    await panel('POST', `codex-accounts/${account.id}/drafts`, {
      authorization_kind: 'bps_oauth',
      idempotency_key: crypto.randomUUID(),
    }),
  )
  const started = await panel('POST', `codex-accounts/drafts/${bpsDraft.draft.id}/oauth/generate-auth-url`, {})
  assert.equal(started.status, 200, started.text + workerLog())
  const authUrl = new URL(data(started).auth_url)
  assert.equal(authUrl.origin + authUrl.pathname, 'https://auth.openai.com/api/accounts/authorize')
  assert.equal(authUrl.searchParams.get('client_id'), 'app_fnr0pYvVwwFDocDumLG3H2Bp')
  const callback = `${authUrl.searchParams.get('redirect_uri')}?code=code-bps&state=${authUrl.searchParams.get('state')}`
  assert.match(callback, /^https:\/\/bps\.openai\.com\/basispoints\/extension\//)
  const completed = await panel('POST', `codex-accounts/drafts/${bpsDraft.draft.id}/oauth/exchange-code`, {
    session_id: data(started).session_id,
    code: callback,
  })
  assert.equal(completed.status, 200, completed.text + workerLog())
  assert.equal(fake.state.token[0].client_id, 'app_fnr0pYvVwwFDocDumLG3H2Bp')
  assert.equal(data(completed).account.config.bps_grant.revision, 1)

  const key = data(await panel('POST', 'api-keys', { name: 'BPS E2E Key', user_id: user.id, group_id: group.id })).item
  const headers = { authorization: `Bearer ${key.key}` }
  const models = await api(gw, 'GET', '/v1/models', { headers })
  const ids = (models.json?.data || []).map((m) => m.id).filter((id) => /^gpt-/.test(id) && !/image/.test(id))
  assert.ok(ids.length >= 2, models.text)
  const [listed, unlisted] = ids
  const nativeManifest = (await api(gw, 'GET', '/v1/models?client_version=0.160.0', { headers })).json.models
  // BPS 模型名单只含 listed
  const updated = await panel('PATCH', `codex-accounts/${account.id}`, { bps: { models: [listed] } })
  assert.equal(updated.status, 200, updated.text)
  await waitFor(
    async () => data(await panel('GET', `codex-accounts/${account.id}`))?.account?.projection_status === 'synced',
  )
  // Codex 模型目录：经 BPS 的模型不声明原生多智能体，其余模型保持原样
  const manifest = await api(gw, 'GET', '/v1/models?client_version=0.160.0', { headers })
  assert.equal(manifest.status, 200, manifest.text)
  const entry = (slug) => manifest.json.models.find((m) => m.slug === slug)
  assert.equal(entry(listed).multi_agent_version, null)
  assert.ok(entry(listed).context_window <= 922_000)
  assert.deepEqual(
    entry(unlisted),
    nativeManifest.find((m) => m.slug === unlisted),
  )
  const input = [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }]
  const viaBps = await api(gw, 'POST', '/v1/responses', { headers, body: { model: listed, input, stream: true } })
  assert.equal(viaBps.status, 200, viaBps.text + workerLog())
  assert.match(viaBps.text, /from-bps/)
  assert.equal(fake.state.bps.length, 1)
  assert.equal(fake.state.bps[0].headers['x-basispoints-auth-mode'], 'chatgpt')
  assert.equal(fake.state.bps[0].headers['chatgpt-account-id'], 'acct_bps')
  assert.equal(fake.state.bps[0].body.model_selection, 'explicit')
  const viaNative = await api(gw, 'POST', '/v1/responses', { headers, body: { model: unlisted, input, stream: true } })
  assert.equal(viaNative.status, 200, viaNative.text + workerLog())
  assert.match(viaNative.text, /from-native/)
  assert.equal(fake.state.bps.length, 1)
  // 无正文的是原生通道的上游 WebSocket 握手尝试（假上游不支持 WS，Worker 回退 HTTP）
  assert.deepEqual(fake.state.native.filter(Boolean), [unlisted])

  // 使用记录写入实际通道（超管诊断字段）
  const rows = await waitFor(async () => {
    const page = data(await panel('GET', 'usage-logs?include_muted=1'))
    const items = page?.items || page?.rows || page?.logs || []
    return items.length >= 2 && items
  })
  const modeOf = (model) =>
    rows.find((item) => item.model === model || item.requestedModel === model)?.authorizationMode
  assert.equal(modeOf(listed), 'bps')
  assert.equal(modeOf(unlisted), 'native')
})
