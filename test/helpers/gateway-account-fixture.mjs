import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { startGateway, REPO_ROOT } from '../harness.mjs'
import { verifyGatewayHeaders } from '../../src/lib/gateway-worker/gateway-auth.mjs'

// Local contract fixture only: never exchanges real OAuth credentials.
export async function startGatewayAccountFixture({ env = {} } = {}) {
  const secret = crypto.randomUUID()
  const accounts = new Map()
  const sessions = new Map()
  const calls = []
  const state = 'fixture-state'
  const worker = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString()
    const signed = verifyGatewayHeaders({ secret, headers: req.headers, body: raw })
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (!signed.ok) return send(401, { error: { code: signed.code } })
    const body = raw ? JSON.parse(raw) : {}
    calls.push({ method: req.method, path: req.url, body })
    if (req.url === '/internal/v1/oauth/start') {
      const session_id = crypto.randomUUID()
      sessions.set(session_id, body)
      return send(200, {
        session_id,
        auth_url: `https://oauth.example.test/authorize?state=${state}`,
        state_hash: crypto.createHash('sha256').update(state).digest('hex'),
        expires_at: new Date(Date.now() + 600000).toISOString(),
      })
    }
    if (req.url === '/internal/v1/oauth/complete') {
      const session = sessions.get(body.session_id)
      if (!session || new URL(body.callback).searchParams.get('state') !== state)
        return send(409, { error: { code: 'oauth_state_mismatch' } })
      // BPS 附加授权写入已有账号，只回报 BPS 授权代次
      if (session.grant === 'bps') {
        const account = accounts.get(session.runtime_account_id)
        if (!account) return send(409, { error: { code: 'bps_requires_account' } })
        account.bps_revision = (account.bps_revision || 0) + 1
        return send(200, { account, bps_revision: account.bps_revision })
      }
      const account = {
        ...accounts.get(session.runtime_account_id),
        id: session.runtime_account_id,
        email: 'fixture@example.test',
        chatgpt_account_id: `identity-${session.runtime_account_id}`,
        credential_revision: body.expected_credential_revision + 1,
        proxy_url: session.proxy_url,
      }
      accounts.set(account.id, account)
      return send(200, { account, credential_revision: account.credential_revision })
    }
    if (req.url === '/internal/v1/accounts' && req.method === 'POST') {
      if (body.expires_at != null && typeof body.expires_at !== 'string')
        return send(400, { error: { code: 'invalid_expiry_type' } })
      const account = { ...body, email: body.email || 'import@example.test' }
      accounts.set(account.id, account)
      return send(200, { account })
    }
    const bps = req.url.match(/^\/internal\/v1\/accounts\/([^/]+)\/bps(?:\/(import))?$/)
    if (bps) {
      const account = accounts.get(decodeURIComponent(bps[1]))
      if (!account) return send(404, { error: { code: 'account_not_found' } })
      if (bps[2] === 'import') account.bps_revision = (account.bps_revision || 0) + 1
      else delete account.bps_revision
      return send(200, { ok: true, bps_revision: account.bps_revision || 0 })
    }
    const match = req.url.match(/^\/internal\/v1\/accounts\/([^/]+)(?:\/(export|refresh|reauthorize|test))?$/)
    if (match) {
      const account = accounts.get(decodeURIComponent(match[1]))
      if (!account) return send(404, { error: { code: 'account_not_found' } })
      if (req.method === 'DELETE' && !match[2]) {
        accounts.delete(account.id)
        return send(200, { ok: true, deleted: account.id })
      }
      if (req.method === 'PATCH' || match[2] === 'reauthorize') Object.assign(account, body)
      if (match[2] === 'refresh')
        Object.assign(account, {
          credential_revision: account.credential_revision + 1,
          email: 'refreshed@example.test',
        })
      const { access_token, refresh_token, id_token, proxy_url, ...publicAccount } = account
      return send(200, {
        account: publicAccount,
        ...(match[2] === 'export' ? { credential_bundle: 'fixture-opaque-bundle' } : {}),
      })
    }
    if (req.url === '/internal/v1/receipts/replay' || req.url.startsWith('/internal/v1/receipts/replay?'))
      return send(200, { receipts: [] })
    return send(404, { error: { code: 'fixture_unknown_route' } })
  })
  await new Promise((resolve) => worker.listen(0, '127.0.0.1', resolve))
  let gw
  try {
    gw = await startGateway({
      disableWatchdog: true,
      env: {
        KIN_CODEX_GATEWAY_INTERNAL_TOKEN: secret,
        KIN_CODEX_GATEWAY_REQUIRE_MTLS: '0',
        KIN_CODEX_GATEWAY_ALLOW_INSECURE: '1',
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
    const heartbeat = setInterval(
      () =>
        request('POST', 'gateway-workers/register', {
          id: 'fixture-gw',
          base_url: `http://127.0.0.1:${worker.address().port}`,
          protocol_version: 1,
          health_state: 'healthy',
          drain_state: 'accepting',
          boot_id: 'fixture-boot',
        }).catch(() => {}),
      15000,
    )
    heartbeat.unref()
    return {
      ...gw,
      cookie,
      groups,
      request,
      accounts,
      sessions,
      calls,
      callback: `http://localhost:1455/auth/callback?code=fixture-code&state=${state}`,
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
