import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { dbClient } from '../../src/lib/db/db-client.mjs'
import { UsageLogsRepo } from '../../src/lib/db/repos/usage-logs-repo.mjs'
import { UsageLogsView } from '../../src/lib/db/repos/usage-logs-view.mjs'

let seq = 0

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-ulview-'))
  const db = createDatabase({ dbPath: path.join(dir, 'logs.db') })
  db.exec(`
    INSERT INTO users (id, email, username, password_hash) VALUES ('u1', 'a@x', 'alice', 'x'), ('u2', 'b@x', 'bob', 'x');
    INSERT INTO api_keys (id, name, key, user_id) VALUES ('k1', 'alice-key', 'sk-1', 'u1'), ('k2', 'bob-key', 'sk-2', 'u2');
    INSERT INTO vms (id, name, vm_json) VALUES ('vm-a', 'Slot A', '{}'), ('vm-b', 'Slot B', '{}');
    INSERT INTO accounts (id, vm_id, email, name) VALUES ('acc-a', 'vm-a', 'a@pool', 'A'), ('acc-b', 'vm-b', NULL, 'Bee');
  `)
  return db
}

/** Insert rows newest-last; created_at defaults to a strictly increasing clock. */
async function seed(db, rows) {
  const repo = new UsageLogsRepo(db)
  const out = []
  // 一个 async 事务里批量写入（R6 B8：insertSummary 经 DbClient，在事务内嵌套为 SAVEPOINT）
  await dbClient(db).tx(async () => {
    for (const r of rows) {
      seq++
      const rec = {
        id: `log_${String(seq).padStart(8, '0')}`,
        request_id: `req-${seq}`,
        created_at: new Date(Date.UTC(2026, 0, 1) + seq * 1000).toISOString(),
        log_mode: 'normal',
        method: 'POST',
        path: '/v1/messages',
        protocol: 'anthropic.messages',
        model: 'claude-sonnet-4',
        status: 200,
        vm_id: 'vm-a',
        actual_cost: r.total_cost ?? null,
        user_id: r.api_key_id === 'k1' ? 'u1' : r.api_key_id === 'k2' ? 'u2' : null,
        ...r,
      }
      await repo.insertSummary(rec)
      out.push(rec)
    }
  })
  return out
}

async function pageAll(view, filters) {
  const seen = []
  let cursor = null
  for (let i = 0; i < 50; i++) {
    const page = await view.listBatch({
      ...filters,
      cursor_created_at: cursor?.createdAt,
      cursor_id: cursor?.id,
    })
    seen.push(...page.logs)
    if (!page.hasMore) return { seen, pages: i + 1 }
    assert.ok(page.nextCursor, 'hasMore without cursor')
    cursor = page.nextCursor
  }
  throw new Error('paging did not terminate')
}

test('keyset paging returns every row once, newest first', async () => {
  const db = freshDb()
  const rows = await seed(
    db,
    Array.from({ length: 5 }, () => ({})),
  )
  const view = new UsageLogsView(db)
  const first = await view.listBatch({ limit: 2 })
  assert.deepEqual(
    first.logs.map((r) => r.id),
    [rows[4].id, rows[3].id],
  )
  assert.equal(first.hasMore, true)
  const { seen, pages } = await pageAll(view, { limit: 2 })
  assert.equal(pages, 3)
  assert.deepEqual(
    seen.map((r) => r.id),
    rows.map((r) => r.id).reverse(),
  )
})

test('JS-filtered paging hands back the scan cursor instead of ending early', async () => {
  const db = freshDb()
  const old = await seed(db, [
    { status: 504, error_code: 'upstream_timeout' },
    { status: 504, error_code: 'upstream_timeout' },
    { status: 504, error_code: 'upstream_timeout' },
  ])
  // 2100 newer errors of another class: more than one call's scan budget.
  await seed(
    db,
    Array.from({ length: 2100 }, () => ({ status: 500, error_code: 'upstream_error' })),
  )
  const view = new UsageLogsView(db)
  const first = await view.listBatch({ error_class: 'timeout', limit: 50 })
  assert.equal(first.logs.length, 0)
  assert.equal(first.hasMore, true)
  assert.ok(first.nextCursor)
  const { seen } = await pageAll(view, { error_class: 'timeout', limit: 50 })
  assert.deepEqual(
    seen.map((r) => r.id),
    old.map((r) => r.id).reverse(),
  )
  assert.ok(seen.every((r) => r.errorClass === 'timeout'))
})

test('caller snapshot excludes unattributed rows even when their current key is owned', async () => {
  const db = freshDb()
  await seed(db, [
    { user_id: 'u1', api_key_id: 'k1' },
    { user_id: null, api_key_id: 'k1' },
    { user_id: 'u2', api_key_id: 'k2' },
  ])
  const view = new UsageLogsView(db)
  const mine = (await view.listBatch({ owner_user_id: 'u1' })).logs
  assert.equal(mine.length, 1)
  assert.ok(mine.every((r) => r.keyId === 'k1'))
  assert.equal((await view.summary({ owner_user_id: 'u1' })).totalRequests, 1)
  const opts = await view.filterOptions({ owner_user_id: 'u1' })
  assert.deepEqual(opts.users, [{ id: 'u1', name: 'alice' }])
  assert.deepEqual(opts.keys, [{ id: 'k1', name: 'alice-key', userId: 'u1' }])
  assert.equal((await view.listBatch({ user_id: 'u2' })).logs.length, 1)
})

test('muting follows RequestLogStore: settings default, explicit list, include_muted, error_class override', async () => {
  const db = freshDb()
  await seed(db, [
    { status: 401, error_code: 'invalid_api_key', vm_id: null },
    { status: 429, error_code: 'quota_5h_safety' },
    { status: 200 },
  ])
  const classes = async (view, f = {}) => (await view.listBatch(f)).logs.map((r) => r.errorClass ?? 'ok').sort()
  const byDefault = new UsageLogsView(db)
  assert.deepEqual(await classes(byDefault), ['ok', 'quota'])
  const settings = new UsageLogsView(db, { mutedErrorClasses: ['auth', 'quota'] })
  assert.deepEqual(await classes(settings), ['ok'])
  assert.equal((await settings.summary({})).totalRequests, 1)
  assert.deepEqual(await classes(settings, { include_muted: true }), ['auth', 'ok', 'quota'])
  assert.deepEqual(await classes(settings, { error_class: 'auth' }), ['auth'])
  assert.deepEqual(await classes(settings, { exclude_error_class: 'quota' }), ['auth', 'ok'])
})

test('summary cache hit rate counts Claude writes and Codex disjoint input on both summary paths', async () => {
  const db = freshDb()
  await seed(db, [
    { input_tokens: 20, cache_read_tokens: 80_000, cache_creation_tokens: 20_000 },
    { via: 'codex-kernel', model: 'gpt-5.4', input_tokens: 20, cache_read_tokens: 80 },
  ])
  const want = 80_080 / 100_120
  const sqlPath = await new UsageLogsView(db).summary({})
  const scanPath = await new UsageLogsView(db, { mutedErrorClasses: ['auth', 'quota'] }).summary({})
  for (const summary of [sqlPath, scanPath]) {
    assert.equal(summary.totalRequests, 2)
    assert.ok(Math.abs(summary.cacheHitRate - want) < 1e-9, String(summary.cacheHitRate))
  }
})

test('provider chains for a page come from one request_attempts query, ordered by attempt', async () => {
  const db = freshDb()
  const [a, b, c] = await seed(db, [
    { account_id: 'acc-a' },
    { final_account_id: 'acc-b', vm_id: 'vm-b', duration_ms: 2000 },
    {},
  ])
  const before = (row, ms) => new Date(Date.parse(row.created_at) - ms).toISOString()
  const ins = db.prepare(
    'INSERT INTO request_attempts (request_id, attempt_no, vm_id, account_id, started_at, selection_reason, downstream_committed) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
  ins.run(a.request_id, 2, 'vm-b', 'acc-b', before(a, 200), 'failover', 1)
  ins.run(a.request_id, 1, 'vm-a', 'acc-a', before(a, 500), 'sticky', 0)
  ins.run(b.request_id, 1, 'vm-b', 'acc-b', before(b, 1500), 'roundrobin', 1)
  // Client-chosen x-request-id reused by later / earlier requests: their attempts
  // fall outside the row's own lifetime and must not be attached.
  ins.run(b.request_id, 2, 'vm-a', 'acc-a', before(b, 60_000), 'sticky', 1)
  ins.run(c.request_id, 1, 'vm-b', 'acc-b', before(c, -3600_000), 'sticky', 1)

  const attemptQueries = []
  const spy = {
    prepare(sql) {
      if (/request_attempts/.test(sql)) attemptQueries.push(sql)
      return db.prepare(sql)
    },
  }
  const logs = (await new UsageLogsView(spy).listBatch({})).logs
  assert.equal(attemptQueries.length, 1)
  const rowA = logs.find((r) => r.requestId === a.request_id)
  assert.deepEqual(
    rowA.providerChain.map((c) => [
      c.attemptNumber,
      c.vmName,
      c.providerName,
      c.selectionReason,
      c.downstreamCommitted,
    ]),
    [
      [1, 'Slot A', 'a@pool', 'sticky', false],
      [2, 'Slot B', 'Bee', 'failover', true],
    ],
  )
  assert.equal(rowA.providerName, 'a@pool')
  // 执行通道与 BPS 阶段（迁移 101）原样透传；历史行为 null
  assert.deepEqual(
    rowA.providerChain.map((c) => [c.route, c.stage]),
    [
      [null, null],
      [null, null],
    ],
  )
  db.prepare(
    "UPDATE request_attempts SET route='bps',stage='attachments',error_message='blocked by our usage policy' WHERE request_id=? AND attempt_no=1",
  ).run(a.request_id)
  const routed = (await new UsageLogsView(db).listBatch({})).logs.find((r) => r.requestId === a.request_id)
  // 上游错误原文（迁移 117）透传到尝试链；历史行为 null
  assert.deepEqual(
    routed.providerChain.map((c) => [c.route, c.stage, c.errorMessage]),
    [
      ['bps', 'attachments', 'blocked by our usage policy'],
      [null, null, null],
    ],
  )
  const rowB = logs.find((r) => r.requestId === b.request_id)
  assert.equal(rowB.providerName, 'Bee')
  assert.equal(rowB.vmName, 'Slot B')
  assert.deepEqual(
    rowB.providerChain.map((c) => c.attemptNumber),
    [1],
  )
  assert.deepEqual(logs.find((r) => r.requestId === c.request_id).providerChain, [])
})

test('account display falls back from a VM to its current account when the log lacks account_id', async () => {
  const db = freshDb()
  const [row] = await seed(db, [{ vm_id: 'vm-a', account_id: null, final_account_id: null }])
  const listed = (await new UsageLogsView(db).listBatch({})).logs
  const result = listed.find((item) => item.requestId === row.request_id)
  assert.equal(result.accountId, 'acc-a')
  assert.equal(result.providerName, 'a@pool')
})

test('filters: model/requested_model, status, attempts, session, time, q', async () => {
  const db = freshDb()
  const rows = await seed(db, [
    { model: 'claude-opus-4', requested_model: 'opus-alias', session_id: 's-1', outbound_session_id: 'out-1' },
    { status: 500, error_code: 'upstream_error', attempt_count: 3, session_id: 's-2', outbound_session_id: 'out-2' },
    { status: 204, log_mode: 'debug', path: '/v1/chat/completions' },
    { status: 200, error_message: 'needle here', attempt_count: 1 },
  ])
  const view = new UsageLogsView(db)
  const ids = async (f) => (await view.listBatch(f)).logs.map((r) => r.id).sort()
  assert.deepEqual(await ids({ model: 'opus-alias' }), [rows[0].id])
  assert.deepEqual(await ids({ status_code: '500' }), [rows[1].id])
  assert.deepEqual(await ids({ exclude_status_200: true }), [rows[1].id])
  assert.deepEqual(await ids({ exclude_status_200: true, status_code: '204' }), [rows[2].id])
  assert.deepEqual(await ids({ min_attempt_count: '2' }), [rows[1].id])
  // Either the caller's id or the id the gateway sent upstream finds the row.
  assert.deepEqual(await ids({ session_id: 's-2' }), [rows[1].id])
  assert.deepEqual(await ids({ session_id: 'out-2' }), [rows[1].id])
  const [first] = (await view.listBatch({ session_id: 'out-1' })).logs
  assert.equal(first.sessionId, 'out-1')
  assert.equal(first.clientSessionId, 's-1')
  assert.deepEqual(await ids({ q: 'needle' }), [rows[3].id])
  assert.deepEqual(await ids({ start_time: rows[1].created_at, end_time: rows[3].created_at }), [
    rows[1].id,
    rows[2].id,
  ])
})

test('row badges: via only when non-default, context1m from long_context, fast/priority', async () => {
  const db = freshDb()
  const [plain, special] = await seed(db, [
    { via: 'go-worker-pool', stream: true },
    {
      via: 'api-kernel',
      long_context: 1,
      speed: 'fast',
      service_tier: 'priority',
      requested_model: 'a',
      upstream_model: 'b',
      model_mismatch: 1,
      workspace: 'client',
    },
  ])
  const logs = (await new UsageLogsView(db).listBatch({})).logs
  const keys = (id) =>
    logs
      .find((r) => r.id === id)
      .specialSettings.map((s) => s.key)
      .sort()
  assert.deepEqual(keys(plain.id), ['stream'])
  assert.deepEqual(keys(special.id), ['context1m', 'fast', 'mismatch', 'priority', 'via'])
  assert.equal(logs.find((r) => r.id === special.id).context1mApplied, true)
  assert.equal(logs.find((r) => r.id === plain.id).context1mApplied, null)
})

test('#777 badge: sent priority with a non-priority upstream echo is a Fast downgrade', async () => {
  const db = freshDb()
  const [downgraded, honored, unechoed] = await seed(db, [
    { protocol: 'openai.responses', service_tier: 'priority', upstream_service_tier: 'default' },
    { protocol: 'openai.responses', service_tier: 'priority', upstream_service_tier: 'priority' },
    { protocol: 'openai.responses', service_tier: 'priority' },
  ])
  const logs = (await new UsageLogsView(db).listBatch({})).logs
  const row = (id) => logs.find((r) => r.id === id)
  const downgrade = (id) => row(id).specialSettings.find((s) => s.key === 'tier_downgrade')
  assert.equal(downgrade(downgraded.id)?.value, 'priority → default')
  assert.equal(row(downgraded.id).upstreamServiceTier, 'default')
  assert.equal(downgrade(honored.id), undefined)
  assert.equal(downgrade(unechoed.id), undefined)
})

test('overview splits today/yesterday-same-time in UTC+8 regardless of client zone', async () => {
  const db = freshDb()
  const now = Date.parse('2026-03-10T04:00:00Z') // 12:00 in Shanghai
  await seed(db, [
    { created_at: '2026-03-09T02:00:00.000Z', total_cost: 1 }, // yesterday 10:00 local
    { created_at: '2026-03-09T06:00:00.000Z', total_cost: 2 }, // yesterday 14:00 local, after same-time
    { created_at: '2026-03-09T17:00:00.000Z', total_cost: 4, status: 500, error_code: 'upstream_error' },
    { created_at: '2026-03-10T03:59:30.000Z', total_cost: 8, session_id: 's-live', outbound_session_id: 'out-live' },
  ])
  const view = new UsageLogsView(db)
  const sh = await view.overview({ tz: 'Asia/Shanghai', now })
  assert.equal(sh.todayRequests, 2)
  assert.equal(sh.todayCost, 12)
  assert.equal(sh.todayErrors, 1)
  assert.equal(sh.yesterdayRequests, 1)
  assert.equal(sh.yesterdayCost, 1)
  assert.equal(sh.rpm, 1)
  assert.equal(sh.activeSessions, 1)
  // Client timezone cannot change the system business day.
  const utc = await view.overview({ tz: 'Not/AZone', now })
  assert.equal(utc.todayRequests, 2)
  assert.equal(utc.yesterdayRequests, 1)
})

test('active sessions and session suggestions group by outbound session, owner-scoped, newest first', async () => {
  const db = freshDb()
  const now = Date.now()
  const iso = (ago) => new Date(now - ago).toISOString()
  // One client session that the gateway rebuilt into two upstream sessions (abc-1 / abc-1b).
  await seed(db, [
    {
      created_at: iso(60_000),
      session_id: 'client-1',
      outbound_session_id: 'abc-1',
      api_key_id: 'k1',
      status: 500,
      error_code: 'upstream_error',
    },
    {
      created_at: iso(30_000),
      session_id: 'client-1',
      outbound_session_id: 'abc-1',
      api_key_id: 'k1',
      status: 200,
      input_tokens: 10,
    },
    { created_at: iso(25_000), session_id: 'client-1', outbound_session_id: 'abc-1b', api_key_id: 'k1' },
    { created_at: iso(20_000), session_id: 'client-2', outbound_session_id: 'abc-2', api_key_id: 'k2' },
    { created_at: iso(10 * 60_000), session_id: 'client-3', outbound_session_id: 'abc-3', api_key_id: 'k1' },
    { created_at: iso(5_000), session_id: 'client-legacy', api_key_id: 'k1' },
  ])
  const view = new UsageLogsView(db)
  const active = await view.activeSessions({ owner_user_id: 'u1', now })
  assert.equal(active.total, 2)
  assert.deepEqual(
    active.sessions.map((s) => [s.sessionId, s.clientSessionId, s.requests]),
    [
      ['abc-1b', 'client-1', 1],
      ['abc-1', 'client-1', 2],
    ],
  )
  assert.equal(active.sessions[1].lastStatus, 200)
  assert.equal(active.sessions[1].keyName, 'alice-key')
  assert.equal((await view.activeSessions({ now })).total, 3)
  assert.equal((await view.overview({ now })).activeSessions, 3)
})

test('active sessions never resolve the last row from another tenant sharing the session id', async () => {
  const db = freshDb()
  const now = Date.now()
  const at = new Date(now - 30_000).toISOString()
  // Same client-chosen session id and completion instant; bob's row sorts later by id.
  await seed(db, [
    {
      created_at: at,
      session_id: 'shared',
      outbound_session_id: 'shared',
      api_key_id: 'k1',
      vm_id: 'vm-a',
      status: 200,
    },
    {
      created_at: at,
      session_id: 'shared',
      outbound_session_id: 'shared',
      api_key_id: 'k2',
      vm_id: 'vm-b',
      status: 500,
      error_code: 'upstream_error',
    },
  ])
  const [s] = (await new UsageLogsView(db).activeSessions({ owner_user_id: 'u1', now })).sessions
  assert.equal(s.keyName, 'alice-key')
  assert.equal(s.vmId, 'vm-a')
  assert.equal(s.lastStatus, 200)
})

test('tenant error collection hides other users and anonymous ingress failures', async () => {
  const db = freshDb()
  await seed(db, [
    {
      user_id: 'u2',
      api_key_id: 'k2',
      vm_id: null,
      ip: '198.51.100.7',
      status: 403,
      error_code: 'distill_blocked',
      error_message: '不允许蒸馏: secret prompt',
    },
    { vm_id: null, ip: '203.0.113.9', status: 401, error_code: 'invalid_api_key', api_key_presented: 'sk-bad' },
    { user_id: 'u1', api_key_id: 'k1', status: 500, error_code: 'upstream_error', error_message: 'boom' },
  ])
  const repo = new UsageLogsRepo(db)
  const mine = (await repo.windowStats({ owner_user_id: 'u1' })).error_collection
  assert.deepEqual(
    mine.recent.map((r) => r.error_code),
    ['upstream_error'],
  )
  assert.deepEqual(mine.ingress_hits, [])
  const all = (await repo.windowStats()).error_collection
  assert.equal(all.recent.length, 3)
  assert.deepEqual(all.ingress_hits.map((h) => h.ip).sort(), ['198.51.100.7', '203.0.113.9'])
})

test('legacy Codex outbound models are not presented as observed responses', async () => {
  const db = freshDb()
  const [legacy, observed, other] = await seed(db, [
    { via: 'codex-kernel', requested_model: 'alias', upstream_model: 'gpt-6-astra', model_mismatch: 1 },
    {
      via: 'codex-kernel',
      requested_model: 'gpt-6-astra',
      upstream_model: 'gpt-6-astra',
      response_model: 'gpt-5.6-luna',
      model_mismatch: 1,
    },
    { via: 'api-kernel', requested_model: 'alias', upstream_model: 'claude-sonnet-4', model_mismatch: 1 },
  ])
  const view = new UsageLogsView(db)
  const logs = (await view.listBatch({})).logs
  assert.equal(logs.find((r) => r.id === legacy.id).actualResponseModel, null)
  assert.equal(logs.find((r) => r.id === legacy.id).modelMismatch, null)
  assert.equal(
    logs.find((r) => r.id === legacy.id).specialSettings.some((s) => s.key === 'mismatch'),
    false,
  )
  assert.equal(logs.find((r) => r.id === observed.id).actualResponseModel, 'gpt-5.6-luna')
  assert.equal(logs.find((r) => r.id === other.id).actualResponseModel, 'claude-sonnet-4')
  // 上游模型审计筛选：旧 Codex 出站模型不算观测到的不一致
  assert.deepEqual(
    (await view.listBatch({ model_mismatch: true })).logs.map((r) => r.id),
    [other.id, observed.id],
  )
})

test('Gateway Worker rows and the upstream-account filter show the account name, not the runtime id', async () => {
  const db = freshDb()
  db.exec(`
    INSERT INTO vendor_resources (id, vendor_id, resource_type, name, status, config_json, created_by, created_at, updated_at)
      VALUES ('res_gw', NULL, 'account', 'codex-cn-5', 'active', '{"platform":"openai","execution_kind":"gateway_worker"}', 't', 'now', 'now'),
             ('res_pending', NULL, 'account', 'codex-new', 'active', '{"platform":"openai","execution_kind":"gateway_worker"}', 't', 'now', 'now');
    INSERT INTO gateway_worker_instances (id, name, base_url, created_at, updated_at) VALUES ('gw_1', 'gw_1', 'http://127.0.0.1:8790', 'now', 'now');
    INSERT INTO gateway_worker_account_bindings (id, account_resource_id, gateway_instance_id, runtime_account_id, created_at, updated_at)
      VALUES ('bind_1', 'res_gw', 'gw_1', 'gwacct_account_x', 'now', 'now');
  `)
  const [bound, pending] = await seed(db, [
    { vm_id: 'gateway:res_gw', account_id: 'gwacct_account_x', final_account_id: 'gwacct_account_x' },
    { vm_id: 'gateway:res_pending', account_id: 'gwacct_res_pending', final_account_id: 'gwacct_res_pending' },
  ])
  const view = new UsageLogsView(db)
  const listed = (await view.listBatch({})).logs
  assert.equal(listed.find((item) => item.requestId === bound.request_id).providerName, 'codex-cn-5')
  assert.equal(listed.find((item) => item.requestId === pending.request_id).providerName, 'codex-new')
  // 搜索、图片等没有决策链的行由前端取 vmName 展示，也必须是账号名称而非 gateway:<资源 ID>
  assert.equal(listed.find((item) => item.requestId === bound.request_id).vmName, 'codex-cn-5')
  assert.equal(listed.find((item) => item.requestId === pending.request_id).vmName, 'codex-new')
  const option = (await view.filterOptions()).accounts.find((item) => item.id === 'gwacct_account_x')
  assert.deepEqual(option, { id: 'gwacct_account_x', name: 'codex-cn-5', platform: 'openai', groupIds: [] })
  const filtered = (await view.listBatch({ account_id: 'gwacct_account_x' })).logs
  assert.deepEqual(
    filtered.map((item) => item.requestId),
    [bound.request_id],
  )
})

test('account options skip rows left by deleted slots and label same-email accounts with their slot', async () => {
  const db = freshDb()
  db.exec(`
    INSERT INTO vms (id, name, vm_json) VALUES ('vm-c', 'claude-cc-7', '{}'), ('vm-d', 'claude-cc-8', '{}');
    INSERT INTO accounts (id, vm_id, email, name) VALUES
      ('acc-c', 'vm-c', 'dup@pool', 'C'), ('acc-d', 'vm-d', 'dup@pool', 'D'), ('vm-gone', 'vm-gone', 'dup@pool', 'G');
  `)
  const names = new Map((await new UsageLogsView(db).filterOptions()).accounts.map((a) => [a.id, a.name]))
  assert.equal(names.has('vm-gone'), false)
  assert.equal(names.get('acc-c'), 'dup@pool · claude-cc-7')
  assert.equal(names.get('acc-d'), 'dup@pool · claude-cc-8')
  assert.equal(names.get('acc-a'), 'a@pool')
})

test('upstream API rows show the API name; platform filter follows account, then model, then protocol', async () => {
  const db = freshDb()
  db.exec(`
    UPDATE accounts SET platform = 'claude';
    INSERT INTO api_endpoints (id, name, base_url, kind, protocol, created_at, updated_at)
      VALUES ('ep_oa', 'OpenAI API Key', 'https://api.openai.com', 'openai', 'openai', 'now', 'now'),
             ('ep_cl', 'claude-cc-7', 'https://api.anthropic.com', 'claude', 'anthropic', 'now', 'now');
    INSERT INTO api_endpoint_keys (id, endpoint_id, api_key, created_at)
      VALUES ('ek_oa1', 'ep_oa', 'sk-a', 'now'), ('ek_oa2', 'ep_oa', 'sk-b', 'now'), ('ek_cl1', 'ep_cl', 'sk-c', 'now');
  `)
  const rows = await seed(db, [
    { account_id: 'ek_oa1', final_account_id: 'ek_oa1', model: 'gpt-6-astra', protocol: 'openai.responses' },
    { account_id: 'ek_cl1', final_account_id: 'ek_cl1', model: 'claude-opus-5-5', protocol: 'anthropic.messages' },
    // Chat Completions 入站但落到 Claude 账号：按账号归 Anthropic
    { account_id: 'acc-a', final_account_id: 'acc-a', model: 'claude-opus-5-5', protocol: 'openai.chat' },
    // 未路由：按模型
    { vm_id: null, account_id: null, final_account_id: null, model: 'gpt-6.1-sol', protocol: 'anthropic.messages' },
    // 模型也缺失：按入站协议族
    { vm_id: null, account_id: null, final_account_id: null, model: null, protocol: 'openai.responses' },
  ])
  const view = new UsageLogsView(db)
  const listed = (await view.listBatch({})).logs
  const byId = (id) => listed.find((r) => r.id === id)
  assert.equal(byId(rows[0].id).providerName, 'OpenAI API Key')
  assert.equal(byId(rows[1].id).providerName, 'claude-cc-7')
  const ids = async (f) => (await view.listBatch(f)).logs.map((r) => r.id).sort()
  assert.deepEqual(await ids({ platform: 'openai' }), [rows[0].id, rows[3].id, rows[4].id].sort())
  assert.deepEqual(await ids({ platform: 'anthropic' }), [rows[1].id, rows[2].id].sort())
  assert.equal((await view.summary({ platform: 'anthropic' })).totalRequests, 2)

  const options = await view.filterOptions()
  const account = (id) => options.accounts.find((a) => a.id === id)
  assert.deepEqual(account('ek_cl1'), { id: 'ek_cl1', name: 'claude-cc-7', platform: 'anthropic', groupIds: [] })
  assert.deepEqual(account('ek_oa1'), {
    id: 'ek_oa1',
    name: 'OpenAI API Key · ek_oa1',
    platform: 'openai',
    groupIds: [],
  })
  assert.equal(account('acc-a').platform, 'anthropic')
  assert.deepEqual(
    options.models.filter((m) => m.id === 'gpt-6-astra' || m.id === 'claude-opus-5-5'),
    [
      { id: 'claude-opus-5-5', platform: 'anthropic' },
      { id: 'gpt-6-astra', platform: 'openai' },
    ],
  )
  assert.equal('endpoints' in options, false)
  assert.equal('protocols' in options, false)
})

test('rows expose inbound/upstream endpoints and transports for the super-admin columns', async () => {
  const db = freshDb()
  const [ws, legacy] = await seed(db, [
    {
      path: '/v1/responses',
      protocol: 'openai.responses',
      stream: true,
      inbound_transport: 'websocket',
      upstream_path: '/basispoints/api/responses',
      upstream_transport: 'http',
    },
    { path: '/v1/messages' },
  ])
  const logs = (await new UsageLogsView(db).listBatch({})).logs
  const row = (id) => logs.find((r) => r.id === id)
  assert.deepEqual(
    [row(ws.id).endpoint, row(ws.id).inboundTransport, row(ws.id).upstreamEndpoint, row(ws.id).upstreamTransport],
    ['/v1/responses', 'websocket', '/basispoints/api/responses', 'http'],
  )
  // 099 之前的历史行没有这些事实
  assert.deepEqual(
    [row(legacy.id).inboundTransport, row(legacy.id).upstreamEndpoint, row(legacy.id).upstreamTransport],
    [null, null, null],
  )
})

test('filter options carry group platform/models and resource membership for cascading dropdowns', async () => {
  const db = freshDb()
  db.exec(`
    UPDATE accounts SET platform = 'claude';
    INSERT INTO accounts (id, vm_id, email, name, platform) VALUES ('acc-codex', 'vm-codex', 'codex@pool', 'X', 'claude');
    INSERT INTO vms (id, name, vm_json) VALUES ('vm-codex', 'Codex Slot', '{}');
    INSERT INTO groups (id, name, platform, models_json) VALUES (31, 'Claude · API', 'anthropic', '["claude-opus-5-5"]'),
      (32, 'OpenAI', 'openai', '[]'), (33, 'Mixed', 'mixed', '[]');
    INSERT INTO api_endpoints (id, name, base_url, kind, protocol, created_at, updated_at)
      VALUES ('ep_cl', 'claude-cc-7', 'https://api.anthropic.com', 'claude', 'anthropic', 'now', 'now');
    INSERT INTO api_endpoint_keys (id, endpoint_id, api_key, created_at) VALUES ('ek_cl1', 'ep_cl', 'sk-c', 'now');
    INSERT INTO group_resources (group_id, resource_kind, resource_id, priority)
      VALUES (31, 'api_endpoint', 'ep_cl', 50), (31, 'vm', 'vm-a', 50), (32, 'vm', 'vm-codex', 50), (33, 'vm', 'vm-a', 50);
  `)
  const rows = await seed(db, [
    { billing_group_id: 31, account_id: 'acc-a', final_account_id: 'acc-a', model: 'claude-opus-5-5' },
    {
      billing_group_id: 32,
      vm_id: 'vm-codex',
      account_id: 'acc-codex',
      final_account_id: 'acc-codex',
      model: 'gpt-6-astra',
    },
    {
      billing_group_id: 33,
      vm_id: 'vm-codex',
      account_id: 'vm-codex',
      final_account_id: 'vm-codex',
      model: 'mystery-model',
    },
  ])
  const view = new UsageLogsView(db)
  // 控制面按已解密注册表告知槽位平台；账号表对 Codex 槽位误标 claude 时以槽位为准
  const vmPlatforms = { 'vm-a': 'anthropic', 'vm-b': 'anthropic', 'vm-codex': 'openai' }
  const options = await view.filterOptions({ vm_platforms: vmPlatforms })
  const group = (id) => options.groups.find((g) => g.id === id)
  assert.deepEqual(group('31'), { id: '31', name: 'Claude · API', platform: 'anthropic', models: ['claude-opus-5-5'] })
  assert.deepEqual(group('32'), { id: '32', name: 'OpenAI', platform: 'openai', models: [] })
  assert.equal(group('33').platform, 'mixed')
  const account = (id) => options.accounts.find((a) => a.id === id)
  assert.deepEqual([account('acc-a').platform, account('acc-a').groupIds.sort()], ['anthropic', ['31', '33']])
  assert.deepEqual([account('acc-codex').platform, account('acc-codex').groupIds], ['openai', ['32']])
  assert.deepEqual(account('ek_cl1').groupIds, ['31'])
  const vm = (id) => options.vms.find((v) => v.id === id)
  assert.deepEqual(vm('vm-codex'), { id: 'vm-codex', name: 'Codex Slot', platform: 'openai', groupIds: ['32'] })
  assert.deepEqual(vm('vm-a').groupIds.sort(), ['31', '33'])
  const ids = async (f) => (await view.listBatch(f)).logs.map((r) => r.id).sort()
  // 槽位直连行（账号 ID = 槽位 ID）与误标账号都按槽位平台归类
  assert.deepEqual(await ids({ platform: 'openai', vm_platforms: vmPlatforms }), [rows[1].id, rows[2].id].sort())
  assert.deepEqual(await ids({ platform: 'anthropic', vm_platforms: vmPlatforms }), [rows[0].id])
})

// 数据访问分层 R4：游标条件先给 created_at 范围下界，带筛选的深翻页也从游标处开始扫，而不是每页从最新一条扫起
test('keyset cursor queries search the created_at index from the cursor', async () => {
  const db = freshDb()
  const statements = []
  const prepare = db.prepare.bind(db)
  db.prepare = (sql) => {
    statements.push(sql)
    return prepare(sql)
  }
  await new UsageLogsView(db).listBatch({
    model: 'model-3',
    cursor_created_at: '2026-11-05T00:00:00.000Z',
    cursor_id: 'log_x',
    limit: 5,
  })
  const sql = statements.find((text) => /FROM usage_logs .*created_at <= \?/s.test(text))
  assert.ok(sql, 'the cursor query bounds created_at')
  const plan = prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...Array.from({ length: (sql.match(/\?/g) || []).length }, () => 'x'))
    .map((row) => row.detail)
  assert.ok(
    plan.some((detail) => /^SEARCH usage_logs USING INDEX \w+ \(created_at<\?\)/.test(detail)),
    plan.join('\n'),
  )
})
