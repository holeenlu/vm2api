import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, openDatabase } from '../../src/lib/db/database.mjs'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { STATS_BUDGET_DEFAULTS, createStatsBudget, statsBudgetConfig } from '../../src/lib/admin/route-budget.mjs'
import { ROUTES } from '../../src/lib/admin/route-table.mjs'

// 技术债 M5：路由表类别为 stats 的接口在面板分发入口统一套用并发上限与超时（数据访问文档第 3 节 D 类）。

function fakeRes() {
  const res = {
    headers: {},
    writes: [],
    headersSent: false,
    setHeader(name, value) {
      res.headers[name.toLowerCase()] = value
    },
    writeHead(status, headers = {}) {
      res.headersSent = true
      res.writes.push({ status, headers: { ...res.headers, ...headers } })
      return res
    },
    end(body) {
      res.writes.at(-1).body = body
      return res
    },
  }
  return res
}

const reply = (res) => (status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function deferred() {
  let resolve
  const promise = new Promise((r) => (resolve = r))
  return { promise, resolve }
}

test('config: routing panel_stats overrides env, env overrides defaults, invalid values are ignored', () => {
  assert.deepEqual(statsBudgetConfig(null, {}), { ...STATS_BUDGET_DEFAULTS })
  assert.deepEqual(statsBudgetConfig(null, { KIN_STATS_ROUTE_CONCURRENCY: '2', KIN_STATS_TIMEOUT_MS: '5000' }), {
    route_concurrency: 2,
    concurrency: STATS_BUDGET_DEFAULTS.concurrency,
    timeout_ms: 5000,
  })
  assert.deepEqual(
    statsBudgetConfig(
      { panel_stats: { route_concurrency: 8, concurrency: 'x', timeout_ms: 0 } },
      { KIN_STATS_ROUTE_CONCURRENCY: '2', KIN_STATS_CONCURRENCY: '-1' },
    ),
    { route_concurrency: 8, concurrency: STATS_BUDGET_DEFAULTS.concurrency, timeout_ms: 0 },
  )
})

test('over the per-route limit a stats request is rejected at once with 503 + Retry-After; slots free on completion', async () => {
  const budget = createStatsBudget({ config: () => ({ route_concurrency: 2, concurrency: 10, timeout_ms: 0 }) })
  const gates = [deferred(), deferred()]
  const running = gates.map((gate) => budget.run({ key: 'GET /a', res: fakeRes(), handler: () => gate.promise, reply }))
  const busy = fakeRes()
  assert.equal(await budget.run({ key: 'GET /a', res: busy, handler: () => 'never', reply: reply(busy) }), true)
  assert.equal(busy.writes[0].status, 503)
  assert.equal(busy.writes[0].headers['retry-after'], '2')
  assert.equal(JSON.parse(busy.writes[0].body).error.code, 'stats_busy')
  // 其他 stats 路由有自己的名额
  const other = fakeRes()
  assert.equal(await budget.run({ key: 'GET /b', res: other, handler: () => 'b', reply: reply(other) }), 'b')
  assert.deepEqual(budget.stats().running_by_route, { 'GET /a': 2 })
  gates[0].resolve('first')
  assert.equal(await running[0], 'first')
  const again = fakeRes()
  assert.equal(await budget.run({ key: 'GET /a', res: again, handler: () => 'ok', reply: reply(again) }), 'ok')
  gates[1].resolve('second')
  await running[1]
  const stats = budget.stats()
  assert.equal(stats.running, 0)
  assert.equal(stats.rejected_busy, 1)
  assert.equal(stats.admitted, 4)
})

test('the category-wide limit caps all stats routes together', async () => {
  const budget = createStatsBudget({ config: () => ({ route_concurrency: 4, concurrency: 2, timeout_ms: 0 }) })
  const gate = deferred()
  const held = [
    budget.run({ key: 'GET /a', res: fakeRes(), handler: () => gate.promise, reply }),
    budget.run({ key: 'GET /b', res: fakeRes(), handler: () => gate.promise, reply }),
  ]
  const res = fakeRes()
  assert.equal(await budget.run({ key: 'GET /c', res, handler: () => 'c', reply: reply(res) }), true)
  assert.equal(res.writes[0].status, 503)
  gate.resolve()
  await Promise.all(held)
  assert.equal(budget.stats().running, 0)
})

test('a slow stats handler gets a 503 timeout hint; its late writes are dropped and its slot is held until it ends', async () => {
  const budget = createStatsBudget({ config: () => ({ route_concurrency: 1, concurrency: 10, timeout_ms: 20 }) })
  const gate = deferred()
  const res = fakeRes()
  const out = await budget.run({
    key: 'GET /slow',
    res,
    handler: async () => {
      await gate.promise
      reply(res)(200, { ok: true })
      return true
    },
    reply: reply(res),
  })
  assert.equal(out, true)
  assert.equal(res.writes.length, 1)
  assert.equal(res.writes[0].status, 503)
  const body = JSON.parse(res.writes[0].body)
  assert.equal(body.error.code, 'stats_timeout')
  assert.match(body.error.message, /缩小时间范围/)
  // 底层查询还在跑：名额未释放，同一路由的新请求被拒
  const busy = fakeRes()
  await budget.run({ key: 'GET /slow', res: busy, handler: () => 'x', reply: reply(busy) })
  assert.equal(busy.writes[0].status, 503)
  gate.resolve()
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(res.writes.length, 1, 'late response is discarded')
  assert.equal(budget.stats().running, 0)
  assert.equal(budget.stats().timed_out, 1)
})

test('a handler that already started streaming is not cut off by the timeout', async () => {
  const budget = createStatsBudget({ config: () => ({ route_concurrency: 1, concurrency: 1, timeout_ms: 10 }) })
  const res = fakeRes()
  const out = await budget.run({
    key: 'GET /export',
    res,
    handler: async () => {
      res.writeHead(200, {})
      await new Promise((r) => setTimeout(r, 30))
      res.end('done')
      return 'finished'
    },
    reply: reply(res),
  })
  assert.equal(out, 'finished')
  assert.equal(res.writes.length, 1)
  assert.equal(res.writes[0].body, 'done')
  assert.equal(budget.stats().timed_out, 0)
})

test('panel dispatch applies the budget by route-table kind, not per route', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-route-budget-'))
  openDatabase({ dbPath: path.join(root, 'kin.db') })
  t.after(async () => {
    await closeDatabase()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const gate = deferred()
  let hold = true
  const handlePanel = createPanelHandler({
    cfg: { paths: { project: root }, vm: { id: null } },
    routingConfig: { panel_stats: { route_concurrency: 1, concurrency: 10, timeout_ms: 0 } },
    async requireAuth(req) {
      if (hold && req.url.startsWith('/api/panel/usage-logs/summary')) await gate.promise
      req.panelRole = 'super_admin'
      req.panelUser = 'root'
      req.panelUserId = null
      return true
    },
    json(res, status, payload) {
      res.writeHead(status, {})
      res.end(JSON.stringify(payload))
      return true
    },
    readBody: async () => ({}),
    proxyPool: { unbindVm() {} },
  })
  const call = async (url) => {
    const res = fakeRes()
    await handlePanel({ method: 'GET', url, headers: {} }, res, new URL(`http://localhost${url}`))
    return res
  }
  assert.equal(ROUTES.find((r) => r.path === '/api/panel/usage-logs/summary').kind, 'stats')
  const first = call('/api/panel/usage-logs/summary')
  const second = await call('/api/panel/usage-logs/summary?start_time=2026-11-01T00:00:00Z')
  assert.equal(second.writes[0].status, 503)
  assert.equal(JSON.parse(second.writes[0].body).error.code, 'stats_busy')
  // read 类不受 stats 名额影响
  const list = await call('/api/panel/usage-logs')
  assert.equal(list.writes[0].status, 200)
  hold = false
  gate.resolve()
  assert.equal((await first).writes[0].status, 200)
  assert.equal((await call('/api/panel/usage-logs/summary')).writes[0].status, 200)
})

test('per-route slots are counted per caller: one caller filling a route does not block another (M5 review P2-5)', async () => {
  const budget = createStatsBudget({ config: () => ({ route_concurrency: 1, concurrency: 10, timeout_ms: 0 }) })
  const gate = deferred()
  const resA = fakeRes()
  const first = budget.run({ key: 'GET /x callerA', res: resA, handler: () => gate.promise, reply: reply(resA) })
  const resA2 = fakeRes()
  assert.equal(
    await budget.run({ key: 'GET /x callerA', res: resA2, handler: () => 'late', reply: reply(resA2) }),
    true,
  )
  assert.equal(resA2.writes[0].status, 503)
  const resB = fakeRes()
  assert.equal(await budget.run({ key: 'GET /x callerB', res: resB, handler: () => 'ok', reply: reply(resB) }), 'ok')
  gate.resolve('done')
  assert.equal(await first, 'done')
})
