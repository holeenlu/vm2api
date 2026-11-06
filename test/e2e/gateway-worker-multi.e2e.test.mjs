import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { startGateway, api, REPO_ROOT, pickFreePort } from '../harness.mjs'
import { buildGatewayHeaders } from '../../src/lib/gateway-worker/gateway-auth.mjs'
import { openInstanceSecret } from '../../src/lib/gateway-worker/instance-keys.mjs'

// 两个真实 Worker 共用一个控制面（统一控制面重构 R3 审查 P1-6）：
//   - 刷新租约下并发刷新同一账号，刷新令牌只被使用一次，另一个实例经投影拿到新令牌；
//   - control 托管下令牌写入凭据库并按代次推进；
//   - 清空一个 Worker 的数据目录后重启：新托管公钥进入待确认，投影回退到共享凭据包，账号照常恢复；管理员确认后公钥替换。
//   - 外部 Worker 的数据目录清空后不能用共用令牌冒充原实例重新注册，管理员吊销其实例密钥后才能重新引导（中期技术债 M2）。

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

async function waitFor(fn, { timeoutMs = 30_000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await fn()
    if (last) return last
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`timed out waiting: ${JSON.stringify(last)}`)
}

// 假 OAuth：每次刷新轮换刷新令牌；用过的刷新令牌再出现即记为复用并拒绝（与上游一次性轮换一致）
function startFakeOAuth() {
  const state = { refreshes: 0, reused: 0, valid: new Set(['rt_multi_0']), seq: 0 }
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    if (new URL(req.url, 'http://x').pathname !== '/oauth/token') {
      res.writeHead(404)
      return res.end()
    }
    if (!state.valid.has(body.refresh_token)) {
      state.reused++
      res.writeHead(400, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: { code: 'refresh_token_reused', message: 'reused' } }))
    }
    // 让并发的另一次刷新确实撞上租约
    await new Promise((resolve) => setTimeout(resolve, 300))
    state.valid.delete(body.refresh_token)
    state.refreshes++
    state.seq++
    const next = `rt_multi_${state.seq}`
    state.valid.add(next)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ access_token: `at_multi_${state.seq}`, refresh_token: next, expires_in: 3600 }))
  })
  return { server, state }
}

// 最小 SOCKS5 代理（账号导入需要代理地址）
function startForwardProxy() {
  let tunnels = 0
  const server = net.createServer((client) => {
    client.on('error', () => client.destroy())
    client.once('data', () => {
      tunnels++
      client.write(Buffer.from([5, 0]))
      client.once('data', (buf) => {
        const type = buf[3]
        const addrLen = type === 1 ? 4 : 1 + buf[4]
        const host =
          type === 3 ? buf.subarray(5, 5 + buf[4]).toString('latin1') : Array.from(buf.subarray(4, 8)).join('.')
        const port = buf.readUInt16BE(4 + addrLen)
        const upstream = net.connect(port, host, () => {
          client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]))
          client.pipe(upstream).pipe(client)
        })
        upstream.on('error', () => client.destroy())
      })
    })
  })
  server.tunnelCount = () => tunnels
  return server
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

const built = goBinary()

test('two real Workers: concurrent refresh uses the refresh token once; a wiped Worker recovers', {
  skip: built.skip,
}, async (t) => {
  const secret = crypto.randomUUID()
  const bundleKey = crypto.randomBytes(32).toString('hex')
  const oauth = startFakeOAuth()
  const oauthPort = await listen(oauth.server)
  const proxy = startForwardProxy()
  const proxyPort = await listen(proxy)
  const gw = await startGateway({
    disableWatchdog: true,
    env: {
      // 用例轮询面板接口很密：CI 机器较慢时会耗尽主密钥的请求限流（默认 60 个、每秒补 1 个），返回 429（最终审计 U10）
      KIN_RATE_CAP: '100000',
      KIN_RATE_REFILL: '1000',
      // 封闭环境（最终审计 U10a）：托管 Worker 继承控制面环境，不访问 OpenAI 官方发布源
      KIN_CODEX_GATEWAY_RELEASE_CHECK: 'off',
      KIN_CODEX_GATEWAY_INTERNAL_TOKEN: secret,
      KIN_CODEX_GATEWAY_CREDENTIAL_BUNDLE_KEY: bundleKey,
      KIN_CODEX_GATEWAY_MULTI_WORKER: '1',
    },
  })
  const workers = new Map()
  const startWorker = async (id, { port, dataDir }) => {
    const child = spawn(built.bin, [], {
      env: {
        ...process.env,
        KIN_CODEX_GATEWAY_LISTEN: `127.0.0.1:${port}`,
        KIN_CODEX_GATEWAY_ADVERTISE_URL: `http://127.0.0.1:${port}`,
        KIN_CODEX_GATEWAY_INSTANCE_ID: id,
        KIN_CODEX_GATEWAY_RELEASE_CHECK: 'off',
        KIN_CODEX_GATEWAY_DATA_DIR: dataDir,
        KIN_CODEX_GATEWAY_INTERNAL_TOKEN: secret,
        KIN_CODEX_GATEWAY_RECEIPT_TOKEN: secret,
        KIN_CODEX_GATEWAY_CREDENTIAL_BUNDLE_KEY: bundleKey,
        KIN_CODEX_GATEWAY_CONTROL_PLANE_URL: `http://127.0.0.1:${gw.port}/internal/v1/gateway/workers/register`,
        KIN_CODEX_GATEWAY_RECEIPT_URL: `http://127.0.0.1:${gw.port}/internal/v1/gateway/receipts`,
        KIN_CODEX_GATEWAY_REQUIRE_MTLS: '0',
        KIN_CODEX_GATEWAY_UPSTREAM_BASE_URL: `http://127.0.0.1:${oauthPort}/backend-api/codex`,
        KIN_CODEX_GATEWAY_OAUTH_TOKEN_URL: `http://127.0.0.1:${oauthPort}/oauth/token`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let log = ''
    child.stdout.on('data', (chunk) => (log += chunk))
    child.stderr.on('data', (chunk) => (log += chunk))
    workers.set(id, { child, port, dataDir, log: () => log })
    return child
  }
  const stopWorker = async (id) => {
    const worker = workers.get(id)
    if (!worker || worker.child.exitCode != null) return
    const exited = new Promise((resolve) => worker.child.once('exit', resolve))
    worker.child.kill('SIGTERM')
    await exited
  }
  t.after(async () => {
    for (const id of workers.keys()) await stopWorker(id)
    await gw.stop()
    oauth.server.close()
    proxy.close()
    for (const worker of workers.values()) fs.rmSync(worker.dataDir, { recursive: true, force: true })
    fs.rmSync(gw.project, { recursive: true, force: true })
  })
  const panel = (method, suffix, body) => api(gw, method, `/api/panel/${suffix}`, { body })
  const data = (r) => r.json?.data ?? r.json
  const dbPath = path.join(gw.project, 'data', 'kin.db')
  const query = (sql, ...args) => {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      return db.prepare(sql).all(...args)
    } finally {
      db.close()
    }
  }
  const logs = () => [...workers.entries()].map(([id, w]) => `--- ${id}\n${w.log()}`).join('\n')
  // 直接调用 Worker 内部接口：已签发实例密钥的 Worker 只接受实例密钥签名（中期技术债 M2），按控制面库里已确认的密钥签名
  // 包裹密钥在控制面数据目录的 runtime-secrets.json（直接启动 server.mjs 时由控制面生成）
  const workerHeaders = (id, body, method, urlPath) => {
    const [row] = query(
      "SELECT key_id,sealed_secret FROM gateway_worker_instance_keys WHERE instance_id=? AND state<>'revoked' AND confirmed_at IS NOT NULL ORDER BY created_at DESC LIMIT 1",
      id,
    )
    if (!row) return buildGatewayHeaders({ secret, body })
    const key = openInstanceSecret(id, row.key_id, row.sealed_secret, { KIN_DATA_DIR: path.join(gw.project, 'data') })
    return buildGatewayHeaders({ secret: key, body, keyId: row.key_id, instanceId: id, method, path: urlPath })
  }
  const instanceKeyState = async (id) =>
    (data(await panel('GET', 'gateway-workers'))?.items || []).find((item) => item.id === id)?.instance_key?.state
  // 外部 Worker 由管理员允许引导（一次性、限时授权）后才签发实例密钥（中期技术债 M2 审查 P0-1）
  const allowBootstrap = async (id) => {
    const allowed = await panel('POST', `gateway-workers/${id}/instance-key/allow-bootstrap`, {})
    assert.equal(allowed.status, 200, allowed.text)
  }
  for (const id of ['gw_a', 'gw_b'])
    await startWorker(id, {
      port: await pickFreePort(),
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), `kin-gw-${id}-`)),
    })
  await waitFor(async () => {
    const items = data(await panel('GET', 'gateway-workers'))?.items || []
    return ['gw_a', 'gw_b'].every((id) => items.find((item) => item.id === id && item.health_state === 'healthy'))
  })
  // 新实例的首个托管公钥也要管理员确认（终审 B2）：确认前不固定，投影走共享凭据包
  for (const id of ['gw_a', 'gw_b']) {
    const first = await waitFor(() => {
      const [row] = query('SELECT custody_public_key,custody_key_pending FROM gateway_worker_instances WHERE id=?', id)
      return row?.custody_key_pending && row
    })
    assert.equal(first.custody_public_key, null, 'a new instance key is not trusted on first use')
    const accepted = await panel('POST', `gateway-workers/${id}/custody-key/accept`, {
      public_key: first.custody_key_pending,
    })
    assert.equal(accepted.status, 200, accepted.text)
  }

  for (const id of ['gw_a', 'gw_b']) await allowBootstrap(id)
  await waitFor(
    async () => (await instanceKeyState('gw_a')) === 'issued' && (await instanceKeyState('gw_b')) === 'issued',
    {
      timeoutMs: 45_000,
    },
  ).catch(() => assert.fail(`external Workers did not bootstrap after the grant\n${logs()}`))
  // CI 在共享 Redis 下重跑时设置 KIN_E2E_REQUIRE_REDIS=1（批准并引导之后再查：待批准实例的心跳不记录共享状态，中期技术债 M2）：两个实例都必须报告 Redis 可用，
  // 否则 Worker 静默退回本地状态也会通过（最终审计 U10 复核 Q2）
  if (process.env.KIN_E2E_REQUIRE_REDIS === '1')
    await waitFor(
      async () => {
        const items = data(await panel('GET', 'gateway-workers'))?.items || []
        return ['gw_a', 'gw_b'].every((id) =>
          items.find((item) => item.id === id && item.shared_state?.backend === 'redis' && item.shared_state?.healthy),
        )
      },
      { timeoutMs: 45_000 },
    )
  const group = data(
    await panel('POST', 'groups', { name: 'Codex Multi', platform: 'openai', rate_multiplier: 0 }),
  ).item
  const draft = data(
    await panel('POST', 'codex-accounts/drafts', {
      name: 'Multi Codex',
      group_ids: [group.id],
      proxy_endpoint: `socks5://127.0.0.1:${proxyPort}`,
      max_concurrency: 4,
      idempotency_key: crypto.randomUUID(),
    }),
  )
  const imported = await panel('POST', `codex-accounts/drafts/${draft.draft.id}/import`, {
    access_token: 'at_multi_0',
    refresh_token: 'rt_multi_0',
    chatgpt_account_id: 'acct_multi',
    email: 'multi@example.test',
  })
  assert.equal(imported.status, 200, imported.text + logs())
  const account = data(imported).account
  const bindings = () =>
    query(
      'SELECT gateway_instance_id,runtime_account_id,credential_revision,projection_status FROM gateway_worker_account_bindings WHERE account_resource_id=?',
      account.id,
    )
  // 账号投影到两个实例
  await waitFor(
    async () => {
      await panel('POST', 'gateway-workers/gw_a/register', {}).catch(() => null)
      const rows = bindings()
      return rows.length === 2 && rows.every((row) => row.projection_status === 'synced') && rows
    },
    { timeoutMs: 45_000 },
  )
  const runtimeId = bindings()[0].runtime_account_id

  // 两个实例同时刷新同一账号
  const refresh = async (id) => {
    const body = '{}'
    const response = await fetch(
      `http://127.0.0.1:${workers.get(id).port}/internal/v1/accounts/${encodeURIComponent(runtimeId)}/refresh`,
      {
        method: 'POST',
        headers: workerHeaders(id, body, 'POST', `/internal/v1/accounts/${encodeURIComponent(runtimeId)}/refresh`),
        body,
      },
    )
    return { status: response.status, body: await response.json().catch(() => null) }
  }
  const results = await Promise.all([refresh('gw_a'), refresh('gw_b')])
  assert.deepEqual(
    results.map((result) => result.status),
    [200, 200],
    JSON.stringify(results) + logs(),
  )
  assert.equal(oauth.state.refreshes, 1, 'the refresh token is exchanged exactly once')
  assert.equal(oauth.state.reused, 0, 'no instance replays the rotated refresh token')
  const revisions = results.map(
    (result) => result.body?.account?.credential_revision ?? result.body?.credential_revision,
  )
  assert.ok(
    revisions.every((revision) => revision === revisions[0]),
    JSON.stringify(results),
  )
  // 凭据库按代次记录轮换后的令牌（control 托管）
  const fingerprint = crypto.createHash('sha256').update('rt_multi_1').digest('hex').slice(0, 16)
  await waitFor(() => {
    const [row] = query(
      "SELECT revision,token_fingerprint FROM executor_credentials WHERE account_resource_id=? AND grant_kind='native'",
      account.id,
    )
    return row?.token_fingerprint === fingerprint && row
  })

  // Codex 设置修改后，一个心跳周期内两个实例都应用到新版本（P4.3 完成标准，R4 审查 P1-5）
  const current = data(await panel('GET', 'gateway-workers/settings'))
  const saved = await panel('PUT', 'gateway-workers/settings', {
    values: { warmup: { enabled: true, times: ['08:00'], model: 'gpt-5.5' } },
    expected_revision: current.revision,
  })
  assert.equal(saved.status, 200, saved.text)
  const revision = data(saved).revision
  assert.ok(revision > current.revision)
  const stale = await panel('PUT', 'gateway-workers/settings', {
    values: { credit_overage: true },
    expected_revision: current.revision,
  })
  assert.equal(stale.status, 409, 'saving over a newer revision is rejected')
  await waitFor(
    async () => {
      const revisions = await Promise.all(
        ['gw_a', 'gw_b'].map(async (id) => {
          const response = await fetch(`http://127.0.0.1:${workers.get(id).port}/internal/v1/health`, {
            headers: buildGatewayHeaders({ secret, body: '' }),
          })
          return (await response.json().catch(() => null))?.settings_revision
        }),
      )
      return revisions.every((value) => value === revision) && revisions
    },
    { timeoutMs: 40_000 },
  )

  // 清空 gw_b 的数据目录后重启：新托管公钥待确认，投影回退到共享凭据包，账号恢复
  const before = query('SELECT custody_public_key FROM gateway_worker_instances WHERE id=?', 'gw_b')[0]
  const port = workers.get('gw_b').port
  await stopWorker('gw_b')
  fs.rmSync(workers.get('gw_b').dataDir, { recursive: true, force: true })
  const wiped = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-gw-gw_b-wiped-'))
  // 数据目录清空的外部 Worker 只有共用令牌：冒充已签发实例的注册被拒，管理员吊销实例密钥后才能重新引导
  await startWorker('gw_b', { port, dataDir: wiped })
  await waitFor(() => /instance_key_required/.test(workers.get('gw_b').log()), { timeoutMs: 20_000 }).catch(() =>
    assert.fail(`a wiped Worker must not re-register with the shared token\n${logs()}`),
  )
  const revoked = await panel('POST', 'gateway-workers/gw_b/instance-key/revoke', {})
  assert.equal(revoked.status, 200, revoked.text)
  assert.ok(data(revoked).revoked.length >= 1)
  await allowBootstrap('gw_b')
  await waitFor(async () => (await instanceKeyState('gw_b')) === 'issued', { timeoutMs: 45_000 }).catch(() =>
    assert.fail(`the wiped Worker did not bootstrap after the grant\n${logs()}`),
  )
  const pending = await waitFor(
    () => {
      const [row] = query(
        'SELECT custody_public_key,custody_key_pending FROM gateway_worker_instances WHERE id=?',
        'gw_b',
      )
      return row?.custody_key_pending && row
    },
    { timeoutMs: 45_000 },
  )
  assert.equal(pending.custody_public_key, before.custody_public_key, 'the first registered key stays until accepted')
  await waitFor(
    async () => {
      const response = await fetch(
        `http://127.0.0.1:${port}/internal/v1/accounts/${encodeURIComponent(runtimeId)}/projection`,
        {
          headers: workerHeaders(
            'gw_b',
            '',
            'GET',
            `/internal/v1/accounts/${encodeURIComponent(runtimeId)}/projection`,
          ),
        },
      )
      const body = await response.json().catch(() => null)
      return response.status === 200 && Number(body?.credential_revision) >= revisions[0] && body
    },
    { timeoutMs: 45_000 },
  )
  // 管理员确认后替换
  const accepted = await panel('POST', 'gateway-workers/gw_b/custody-key/accept', {
    public_key: pending.custody_key_pending,
  })
  assert.equal(accepted.status, 200, accepted.text)
  const [row] = query('SELECT custody_public_key,custody_key_pending FROM gateway_worker_instances WHERE id=?', 'gw_b')
  assert.deepEqual([row.custody_public_key, row.custody_key_pending], [pending.custody_key_pending, null])

  // 最终审计 F1：另一个实例也不在线时再清空 gw_b——没有任何来源可导出，control 托管从凭据库重建投影
  // （gw_a 心跳超过 45 秒后才算不在线、才重建）；
  // 重建的令牌是凭据库里轮换后的最新令牌（再刷新一次能成功，且没有重放旧刷新令牌）
  await stopWorker('gw_a')
  await stopWorker('gw_b')
  fs.rmSync(wiped, { recursive: true, force: true })
  const wipedAgain = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-gw-gw_b-alone-'))
  assert.equal((await panel('POST', 'gateway-workers/gw_b/instance-key/revoke', {})).status, 200)
  await allowBootstrap('gw_b')
  await startWorker('gw_b', { port, dataDir: wipedAgain })
  const restored = await waitFor(
    async () => {
      const response = await fetch(
        `http://127.0.0.1:${port}/internal/v1/accounts/${encodeURIComponent(runtimeId)}/projection`,
        {
          headers: workerHeaders(
            'gw_b',
            '',
            'GET',
            `/internal/v1/accounts/${encodeURIComponent(runtimeId)}/projection`,
          ),
        },
      ).catch(() => null)
      if (!response) return false
      const body = await response.json().catch(() => null)
      return (
        response.status === 200 &&
        Number(body?.credential_revision) >= revisions[0] &&
        body?.account?.enabled === true &&
        body
      )
    },
    { timeoutMs: 90_000 },
  ).catch((error) => assert.fail(`${error.message}\n${logs()}`))
  assert.equal(restored.account.email, 'multi@example.test')
  assert.ok(
    query(
      'SELECT projection_status FROM gateway_worker_account_bindings WHERE gateway_instance_id=? AND account_resource_id=?',
      'gw_b',
      account.id,
    )[0]?.projection_status === 'synced',
  )
  const refreshesBefore = oauth.state.refreshes
  const tunnelsBefore = proxy.tunnelCount()
  const again = await refresh('gw_b')
  assert.equal(again.status, 200, JSON.stringify(again) + logs())
  assert.equal(oauth.state.refreshes, refreshesBefore + 1)
  assert.equal(oauth.state.reused, 0, 'the vault projected the latest refresh token, not a rotated-out one')
  // 账号带着控制面的代理导入（代理在凭据包里，导入即生效）：刷新经账号代理发出
  assert.ok(proxy.tunnelCount() > tunnelsBefore, 'the restored account uses the control-plane proxy')
})
