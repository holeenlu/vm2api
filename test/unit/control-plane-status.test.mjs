import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase, openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { controlPlaneStatus, logRetiredSwitches } from '../../src/lib/executor/control-plane-status.mjs'
import { GatewayWorkerRepo } from '../../src/lib/gateway-worker/gateway-repo.mjs'
import { dbClient } from '../../src/lib/db/db-client.mjs'
import { eventInboxRepo } from '../../src/lib/executor/repos/event-inbox-repo.mjs'
import { createGatewayWorkerRoutes } from '../../src/lib/gateway-worker/gateway-routes.mjs'

// 统一控制面的开关已全部移除（2026-11-07 S1b–S4）：仍写在 .env 里时启动提示一次（不打印取值）
test('retired switches still configured are warned about once without echoing their values', () => {
  const lines = []
  const log = { warn: (m) => lines.push(m) }
  const env = {
    KIN_EXECUTOR_EVENTS: 'primary',
    KIN_REDIS_URL: 'redis://:secret@127.0.0.1:6379/0',
    KIN_CODEX_GATEWAY_INSTANCE_KEYS: 'required',
    KIN_REFRESH_LEASE: 'on',
  }
  logRetiredSwitches({ env, log, once: false })
  logRetiredSwitches({ env, log })
  assert.equal(lines.length, 4)
  for (const name of Object.keys(env))
    assert.ok(
      lines.some((line) => line.includes(`${name} has been removed`)),
      name,
    )
  assert.equal(lines.join('\n').includes('secret'), false)
  logRetiredSwitches({ env: {}, log, once: false })
  assert.equal(lines.length, 4)
})

test('status summarises the event inbox and caches it for a minute', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'control-plane-status-'))
  const db = createDatabase({ dataDir: dir })
  try {
    const now = new Date().toISOString()
    const insert = db.prepare(
      "INSERT INTO executor_event_inbox(event_id,instance_id,stream_id,seq,type,occurred_at,mode,status,payload_json,received_at,checked_at) VALUES(?,?,?,?,'request.finalized',?,'shadow',?,'{}',?,?)",
    )
    insert.run('evt_s_1', 'gw-1', 's', 1, now, 'matched', now, now)
    insert.run('evt_s_2', 'gw-1', 's', 2, now, 'diff', now, now)
    insert.run('evt_s_3', 'gw-1', 's', 3, now, 'pending', now, now)
    const repo = new GatewayWorkerRepo(db)
    const status = await controlPlaneStatus({ db, repo, cache: false })
    assert.deepEqual(
      [status.events.by_status.matched, status.events.by_status.diff, status.events.by_status.pending],
      [1, 1, 1],
    )
    assert.equal(status.refresh_leases, undefined)
    // 汇总缓存 60 秒（复核 O1）：缓存期内不再查库，开关仍实时
    const t0 = Date.now()
    const first = await controlPlaneStatus({ db, repo, now: t0 })
    insert.run('evt_s_4', 'gw-1', 's', 4, now, 'matched', now, now)
    const cachedStatus = await controlPlaneStatus({
      db,
      repo,
      now: t0 + 30_000,
    })
    assert.deepEqual(cachedStatus.events.by_status, first.events.by_status)
    const refreshed = await controlPlaneStatus({ db, repo, now: t0 + 70_000 })
    assert.equal(refreshed.events.by_status.matched, 2)
    // 读取失败时为 null
    db.exec('ALTER TABLE executor_event_inbox RENAME TO inbox_hidden')
    const partial = await controlPlaneStatus({ db, repo, cache: false })
    assert.equal(partial.events, null)
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the Gateway Worker list carries the control-plane status for super admins', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'control-plane-route-'))
  openDatabase({ dataDir: dir })
  try {
    let reply
    const handler = createGatewayWorkerRoutes({
      json: (_res, status, body) => {
        reply = { status, body }
      },
      readBody: async () => ({}),
    })
    await handler({ method: 'GET', panelRole: 'super_admin' }, {}, { pathname: '/api/panel/gateway-workers' })
    assert.equal(reply.status, 200)
    assert.ok(reply.body.control_plane.events)
    await handler({ method: 'GET', panelRole: 'admin' }, {}, { pathname: '/api/panel/gateway-workers' })
    assert.equal(reply.status, 403)
  } finally {
    await closeDatabase()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// 审计 U8 余项：收件箱近 24 小时统计的两条查询只走迁移 121 的覆盖索引（范围扫描、不回表、不扫表），结果不变
test('the event inbox statistics read only the covering index', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'control-plane-inbox-plan-'))
  const db = createDatabase({ dataDir: dir })
  try {
    const insert = db.prepare(
      `INSERT INTO executor_event_inbox(event_id,instance_id,stream_id,seq,type,occurred_at,payload_json,mode,status,received_at,attempts_state)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    )
    const rows = [
      ['e1', 'request.finalized', 'primary', 'applied', '2026-11-06T00:00:00.000Z', null],
      ['e2', 'request.finalized', 'primary', 'applied', '2026-11-06T00:00:01.000Z', 'retry:2'],
      ['e3', 'request.finalized', 'primary', 'applied', '2026-11-06T00:00:02.000Z', 'done'],
      ['e4', 'account.state', 'shadow', 'matched', '2026-11-06T00:00:03.000Z', null],
      ['e5', 'request.finalized', 'primary', 'applied', '2026-11-01T00:00:00.000Z', null],
    ]
    rows.forEach(([id, type, mode, status, at, state], index) =>
      insert.run(id, 'gw-1', 's1', index + 1, type, at, '{}', mode, status, at, state),
    )
    const client = dbClient(db)
    const captured = []
    const many = client.many
    client.many = (sql, ...params) => {
      captured.push(sql)
      return many.call(client, sql, ...params)
    }
    const inbox = eventInboxRepo(db)
    const since = '2026-11-05T12:00:00.000Z'
    try {
      assert.deepEqual(
        (await inbox.countsSince(since)).map((row) => [row.type, row.mode, row.status, Number(row.n)]),
        [
          ['account.state', 'shadow', 'matched', 1],
          ['request.finalized', 'primary', 'applied', 3],
        ],
      )
      assert.deepEqual(
        Object.fromEntries((await inbox.attemptStatesSince(since)).map((row) => [row.state, Number(row.n)])),
        { done: 1, pending: 1, retry: 1 },
      )
    } finally {
      client.many = many
    }
    assert.equal(captured.length, 2)
    for (const sql of captured) {
      const plan = db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(since)
        .map((row) => row.detail)
      assert.ok(
        plan.some((detail) =>
          detail.startsWith(
            'SEARCH executor_event_inbox USING COVERING INDEX idx_executor_event_inbox_stats (received_at>?)',
          ),
        ),
        plan.join(' | '),
      )
      assert.ok(!plan.some((detail) => /^SCAN executor_event_inbox\b/.test(detail)), plan.join(' | '))
    }
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
