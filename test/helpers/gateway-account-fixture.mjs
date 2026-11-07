import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { startGateway, REPO_ROOT } from '../harness.mjs'
import { DatabaseSync } from 'node:sqlite'
import { buildGatewayHeaders, verifyGatewayHeaders } from '../../src/lib/gateway-worker/gateway-auth.mjs'
import { loadRuntimeSecretsReadOnly } from '../../src/lib/core/runtime-secrets.mjs'
import { decryptString } from '../../src/lib/db/secure.mjs'

// Local contract fixture only: never exchanges real OAuth credentials.
export async function startGatewayAccountFixture({ env = {} } = {}) {
  const secret = crypto.randomUUID()
  const accounts = new Map()
  const calls = []
  // 假的 OpenAI 令牌服务（S1：控制面换码与刷新；环回地址直连，不经账号代理）。身份按 identity，可由测试修改
  const identity = {
    email: 'fixture@example.test',
    chatgpt_account_id: 'identity-fixture',
    plan: 'plus',
    user: 'user-f',
  }
  const tokenRequests = []
  let issued = 0
  const jwt = (payload) =>
    `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`
  function issueTokens(form) {
    issued += 1
    const auth = {
      chatgpt_account_id: identity.chatgpt_account_id,
      chatgpt_plan_type: identity.plan,
      chatgpt_user_id: identity.user,
    }
    const email = form.grant_type === 'refresh_token' ? 'refreshed@example.test' : identity.email
    return {
      access_token: jwt({
        exp: Math.floor(Date.now() / 1000) + 3600,
        client_id: form.client_id,
        'https://api.openai.com/auth': auth,
      }),
      refresh_token: `fixture-rt-${issued}`,
      id_token: jwt({ email, aud: [form.client_id], 'https://api.openai.com/auth': auth }),
      expires_in: 3600,
    }
  }
  const worker = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString()
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.url === '/oauth/token' && req.method === 'POST') {
      const form = Object.fromEntries(new URLSearchParams(raw))
      tokenRequests.push(form)
      if (form.grant_type === 'authorization_code' && form.code !== 'fixture-code')
        return send(400, { error: 'invalid_grant' })
      return send(200, issueTokens(form))
    }
    const signed = verifyGatewayHeaders({ secret, headers: req.headers, body: raw })
    if (!signed.ok) return send(401, { error: { code: signed.code } })
    const body = raw ? JSON.parse(raw) : {}
    calls.push({ method: req.method, path: req.url, body })
    const bps = req.url.match(/^\/internal\/v1\/accounts\/([^/]+)\/bps$/)
    if (bps) {
      const account = accounts.get(decodeURIComponent(bps[1]))
      if (!account) return send(404, { error: { code: 'account_not_found' } })
      delete account.bps_revision
      return send(200, { ok: true, bps_revision: account.bps_revision || 0 })
    }
    const match = req.url.match(/^\/internal\/v1\/accounts\/([^/]+)(?:\/(refresh|test))?$/)
    if (match) {
      // 账号来自控制面数据库（Worker 直读）：假 Worker 按运行账号 ID 现建一份运行态
      const id = decodeURIComponent(match[1])
      if (!accounts.has(id)) accounts.set(id, { id, credential_revision: 1 })
      const account = accounts.get(id)
      if (match[2] === 'refresh') account.credential_revision += 1
      return send(200, { account })
    }
    return send(404, { error: { code: 'fixture_unknown_route' } })
  })
  await new Promise((resolve) => worker.listen(0, '127.0.0.1', resolve))
  let gw
  try {
    gw = await startGateway({
      disableWatchdog: true,
      env: {
        KIN_CODEX_GATEWAY_INTERNAL_TOKEN: secret,
        KIN_CODEX_GATEWAY_ALLOW_INSECURE: '1',
        KIN_CODEX_GATEWAY_OAUTH_TOKEN_URL: `http://127.0.0.1:${worker.address().port}/oauth/token`,
        ...env,
      },
    })
    fs.mkdirSync(path.join(gw.project, 'web'), { recursive: true })
    fs.symlinkSync(path.join(REPO_ROOT, 'web/dist'), path.join(gw.project, 'web/dist'))
    const login = await fetch(gw.baseUrl + '/api/panel/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'testpass' }),
    })
    if (!login.ok) throw new Error(`fixture login failed: ${await login.text()}`)
    const cookie = login.headers.get('set-cookie').split(';')[0]
    async function request(method, suffix, body) {
      const res = await fetch(gw.baseUrl + '/api/panel/' + suffix, {
        method,
        headers: { cookie, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      const json = await res.json()
      return { status: res.status, data: json.data || json, raw: json }
    }
    const registered = await request('POST', 'gateway-workers/register', {
      id: 'fixture-gw',
      name: 'Fixture Worker',
      base_url: `http://127.0.0.1:${worker.address().port}`,
      protocol_version: 1,
      health_state: 'healthy',
      drain_state: 'accepting',
      boot_id: 'fixture-boot',
      capabilities: { operations: ['responses'] },
    })
    if (registered.status !== 200) throw new Error(JSON.stringify(registered))
    for (const name of ['Codex Test A', 'Codex Test B']) {
      const group = await request('POST', 'groups', {
        name,
        platform: 'openai',
        models: ['gpt-5-codex'],
        rate_multiplier: 0,
      })
      if (group.status >= 400) throw new Error(JSON.stringify(group))
    }
    const catalog = await request('GET', 'codex-accounts/catalog')
    const groups = catalog.data.groups.map((g) => g.id)
    // Worker 直读的事实：gateway_account_facts_v1 一行、分组与解开的代理地址（与 Go FactsReader 读同一视图）
    const secrets = {}
    function facts(id) {
      const db = new DatabaseSync(path.join(gw.project, 'data', 'kin.db'), { readOnly: true })
      try {
        const row = db.prepare('SELECT * FROM gateway_account_facts_v1 WHERE account_resource_id=?').get(id)
        if (!row) return null
        const groups = db
          .prepare('SELECT group_id FROM gateway_account_groups_v1 WHERE account_resource_id=? ORDER BY group_id')
          .all(id)
          .map((g) => g.group_id)
        if (!secrets.loaded) {
          loadRuntimeSecretsReadOnly({ env: secrets, root: gw.project })
          secrets.loaded = true
        }
        const secret = row.secret_json
          ? JSON.parse(decryptString(row.secret_json, secrets.TAPMODELS_DB_SECRET || secrets.KIN_DB_SECRET))
          : {}
        return { ...row, groups, proxy_url: secret.proxy_url || '' }
      } finally {
        db.close()
      }
    }
    // 心跳带上读取进度（已读到当前事实序列），控制面据此把绑定标为已同步，与真实 Worker 一致
    const beat = async () => {
      const db = new DatabaseSync(path.join(gw.project, 'data', 'kin.db'), { readOnly: true })
      let seq = 0
      try {
        seq = Number(db.prepare('SELECT value FROM gateway_fact_seq WHERE id=1').get()?.value || 0)
      } finally {
        db.close()
      }
      // 与真实 Worker 一样走签名的内部心跳（共用令牌：实例未签发实例密钥）
      const path_ = '/internal/v1/gateway/workers/heartbeat'
      const body = {
        id: 'fixture-gw',
        base_url: `http://127.0.0.1:${worker.address().port}`,
        protocol_version: 1,
        health_state: 'healthy',
        drain_state: 'accepting',
        boot_id: 'fixture-boot',
        facts: { mode: 'primary', status: { contract: 1, seq } },
      }
      const raw = JSON.stringify(body)
      const res = await fetch(gw.baseUrl + path_, {
        method: 'POST',
        headers: { ...buildGatewayHeaders({ secret, body: raw, path: path_ }), 'x-kin-gateway-token': secret },
        body: raw,
      })
      if (!res.ok) throw new Error(`fixture heartbeat failed: ${res.status} ${await res.text()}`)
    }
    const heartbeat = setInterval(() => beat().catch(() => {}), 15000)
    heartbeat.unref()
    return {
      ...gw,
      cookie,
      groups,
      request,
      accounts,
      calls,
      facts,
      beat,
      identity,
      tokenRequests,
      // 一份当前身份的 BPS（Excel 客户端）令牌，用于 BPS 导入
      bpsTokens: () => issueTokens({ grant_type: 'authorization_code', client_id: 'app_fnr0pYvVwwFDocDumLG3H2Bp' }),
      // 授权链接里的 state 拼成回调（state 由控制面生成）；原生 state 在 Desktop 外层链接的 authorize_url 里
      callbackFor(authUrl, code = 'fixture-code') {
        const url = new URL(authUrl)
        const state =
          url.searchParams.get('state') || new URL(url.searchParams.get('authorize_url')).searchParams.get('state')
        return `http://localhost:1455/auth/callback?code=${code}&state=${state}`
      },
      async stop() {
        clearInterval(heartbeat)
        await gw.stop()
        worker.closeAllConnections()
        await new Promise((resolve) => worker.close(resolve))
        fs.rmSync(gw.project, { recursive: true, force: true })
      },
    }
  } catch (error) {
    if (gw) {
      await gw.stop()
      fs.rmSync(gw.project, { recursive: true, force: true })
    }
    worker.closeAllConnections()
    worker.close()
    throw error
  }
}
