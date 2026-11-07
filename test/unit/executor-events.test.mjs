import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { GatewayWorkerRepo } from '../../src/lib/gateway-worker/gateway-repo.mjs'
import { bodyHash } from '../../src/lib/gateway-worker/gateway-auth.mjs'
import crypto from 'node:crypto'
import { EXECUTOR_EVENT_TYPES, executorPayloadHash, validateExecutorEvent } from '../../src/lib/executor/contract.mjs'
import { RequestAttemptsRepo } from '../../src/lib/db/repos/request-attempts-repo.mjs'
import { armWriteBehind, flushWrites, pendingWrites } from '../../src/lib/db/write-behind.mjs'
import { recordGatewayAttempts } from '../../src/lib/gateway-worker/gateway-execution.mjs'
import { createExecutorEventIngest, POISON_RETRIES } from '../../src/lib/executor/event-ingest.mjs'
import { diffDatabase } from '../../scripts/executor-replay-diff.mjs'

const fixture = JSON.parse(
  fs.readFileSync(new URL('../fixtures/executor-contract/events.json', import.meta.url), 'utf8'),
)

function withDb(fn) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'executor-events-'))
    const db = createDatabase({ dataDir: dir })
    try {
      await fn(db)
    } finally {
      db.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
}

function makeEvent(stream, seq, type, payload, extra = {}) {
  return {
    event_id: `evt_${stream}_${seq}`,
    stream_id: stream,
    instance_id: 'gw-1',
    seq,
    type,
    version: 1,
    occurred_at: new Date(1_800_000_000_000 + seq * 1000).toISOString(),
    payload,
    payload_sha256: executorPayloadHash(payload),
    ...extra,
  }
}

function signedReceipt(dispatch, extra = {}) {
  const unsigned = {
    receipt_id: `receipt_${dispatch}`,
    dispatch_id: dispatch,
    request_id: `req_${dispatch}`,
    gateway_instance_id: 'gw-1',
    terminal_state: 'completed',
    usage_confidence: 'complete',
    usage: { input_tokens: 5, output_tokens: 2 },
    ...extra,
  }
  return { ...unsigned, payload_hash: bodyHash(unsigned) }
}

// 假 Worker：按流保存事件，记录拉取与确认
function fakeWorker(streams) {
  const calls = { read: [], ack: [], receiptAcks: [] }
  let active = Object.keys(streams)[0]
  return {
    calls,
    switchTo(stream) {
      active = stream
    },
    client: {
      async readEvents(instanceId, { after, streamId, limit }) {
        calls.read.push({ instanceId, after, streamId })
        if (streamId && streamId !== active) return { ok: false, status: 409, data: { stream_id: active } }
        const events = streams[active].filter((event) => event.seq > after).slice(0, limit)
        return { ok: true, status: 200, data: { stream_id: active, events } }
      },
      async ackEvents(instanceId, streamId, seq) {
        calls.ack.push({ instanceId, streamId, seq })
        return { ok: true, status: 200, data: { acked: seq } }
      },
      async ackReceipt(instanceId, dispatchId) {
        calls.receiptAcks.push(dispatchId)
        return { ok: true }
      },
    },
  }
}

async function setup(db) {
  const repo = new GatewayWorkerRepo(db)
  await repo.upsertInstance({ id: 'gw-1', name: 'gw', base_url: 'http://127.0.0.1:1', health_state: 'healthy' })
  return repo
}

test('contract fixture shared with the Worker validates and covers every event type', () => {
  for (const event of fixture.events) assert.deepEqual(validateExecutorEvent(event), { ok: true }, event.type)
  assert.deepEqual([...new Set(fixture.events.map((event) => event.type))].sort(), [...EXECUTOR_EVENT_TYPES].sort())
  const tampered = { ...fixture.events[0], payload: { ...fixture.events[0].payload, usage: { input_tokens: 999 } } }
  assert.equal(validateExecutorEvent(tampered).code, 'payload_hash_mismatch')
  assert.equal(validateExecutorEvent({ ...fixture.events[0], event_id: 'evt_other_1' }).code, 'invalid_event_id')
  assert.equal(validateExecutorEvent({ ...fixture.events[0], type: 'nope' }).code, 'unknown_event_type')
  assert.equal(validateExecutorEvent(fixture.events[0], { instanceId: 'gw-2' }).code, 'instance_mismatch')
})

test(
  'events are applied through the receipt, account-state and quota writers',
  withDb(async (db) => {
    const repo = await setup(db)
    const calls = { credentials: [], quotas: [] }
    repo.recordRuntimeCredentials = (instance, items) => calls.credentials.push([instance, items])
    repo.recordRuntimeQuotas = (instance, items) => calls.quotas.push([instance, items])
    const receipt = signedReceipt('d_primary')
    const worker = fakeWorker({
      s1: [
        makeEvent('s1', 1, 'request.finalized', receipt),
        makeEvent('s1', 2, 'account.state', { items: [{ account_id: 'a', credential_state: 'expired' }] }),
        makeEvent('s1', 3, 'account.quota', { items: [{ account_id: 'a', quota: { primary_used_percent: 3 } }] }),
        makeEvent('s1', 4, 'request.finalized', receipt),
      ],
    })
    const ingest = createExecutorEventIngest({ db, repo, client: worker.client })
    await ingest.tick()
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM gateway_worker_receipts WHERE dispatch_id='d_primary'").get().n,
      1,
    )
    // 回执只经事件入库，不再通知 Worker 清理回执目录（2026-11-07 S2）
    assert.deepEqual(worker.calls.receiptAcks, [])
    assert.deepEqual(calls.credentials, [['gw-1', [{ account_id: 'a', credential_state: 'expired' }]]])
    assert.deepEqual(calls.quotas, [['gw-1', [{ account_id: 'a', quota: { primary_used_percent: 3 } }]]])
    const rows = db.prepare('SELECT event_id,status,detail FROM executor_event_inbox ORDER BY seq').all()
    assert.deepEqual(
      rows.map((row) => row.status),
      ['applied', 'applied', 'applied', 'applied'],
    )
    assert.equal(rows[3].detail, 'duplicate')
    // 重复拉取（确认丢失）不会重复处理
    db.prepare("UPDATE executor_event_cursors SET last_seq=0 WHERE stream_id='s1'").run()
    await ingest.tick()
    assert.equal(calls.credentials.length, 1)
    // 事件里的回执实例与拉取实例不一致时拒绝
    const foreign = makeEvent('s1', 5, 'request.finalized', signedReceipt('d_foreign', { gateway_instance_id: 'gw-9' }))
    worker.client.readEvents = async () => ({ ok: true, status: 200, data: { stream_id: 's1', events: [foreign] } })
    await ingest.tick()
    assert.equal(db.prepare("SELECT status FROM executor_event_inbox WHERE event_id='evt_s1_5'").get().status, 'diff')
  }),
)

test(
  'stream changes restart from zero, failures keep the cursor, invalid events are skipped with a warning',
  withDb(async (db) => {
    const repo = await setup(db)
    const worker = fakeWorker({
      s1: [makeEvent('s1', 1, 'account.state', { items: [] })],
      s2: [makeEvent('s2', 1, 'account.state', { items: [] }), makeEvent('s2', 2, 'account.state', { items: [] })],
    })
    let failNext = false
    const warnings = []
    const recordRuntimeCredentials = repo.recordRuntimeCredentials.bind(repo)
    repo.recordRuntimeCredentials = async (...args) => {
      if (failNext) {
        failNext = false
        throw new Error('boom')
      }
      return recordRuntimeCredentials(...args)
    }
    const ingest = createExecutorEventIngest({
      db,
      repo,
      client: worker.client,
      log: { warn: (message) => warnings.push(message) },
    })
    await ingest.tick()
    worker.switchTo('s2')
    failNext = true
    await ingest.tick()
    const cursors = db.prepare('SELECT stream_id,last_seq FROM executor_event_cursors ORDER BY stream_id').all()
    assert.deepEqual(
      cursors.map((row) => ({ ...row })),
      [{ stream_id: 's1', last_seq: 1 }],
      'a stream stuck on a failing event does not refresh its cursor (heartbeat falls back)',
    )
    assert.equal(db.prepare("SELECT status FROM executor_event_inbox WHERE event_id='evt_s2_1'").get().status, 'failed')
    await ingest.tick()
    assert.equal(db.prepare("SELECT last_seq FROM executor_event_cursors WHERE stream_id='s2'").get().last_seq, 2)
    assert.equal(
      db.prepare("SELECT status FROM executor_event_inbox WHERE event_id='evt_s2_1'").get().status,
      'applied',
    )
    // 信封无效：记为 invalid 并跳过，后续事件照常处理，同时告警
    const bad = { ...makeEvent('s2', 3, 'account.state', { items: [] }), payload_sha256: 'bad' }
    const good = makeEvent('s2', 4, 'account.state', { items: [] })
    worker.client.readEvents = async () => ({ ok: true, status: 200, data: { stream_id: 's2', events: [bad, good] } })
    const summary = await ingest.tick()
    assert.equal(summary.invalid, 1)
    assert.equal(db.prepare("SELECT last_seq FROM executor_event_cursors WHERE stream_id='s2'").get().last_seq, 4)
    const badRow = db.prepare("SELECT status,detail FROM executor_event_inbox WHERE event_id='evt_s2_3'").get()
    assert.deepEqual({ ...badRow }, { status: 'invalid', detail: 'payload_hash_mismatch' })
    assert.equal(
      db.prepare("SELECT status FROM executor_event_inbox WHERE event_id='evt_s2_4'").get().status,
      'applied',
    )
    assert.ok(warnings.some((message) => message.includes('invalid event')))
  }),
)

test('payload hash matches the Worker for U+2028/U+2029 (Go escapes them)', () => {
  const payload = { last_error: 'a\u2028b\u2029c' }
  // Go encoding/json 的输出：两个字符被转义
  const goBytes = '{"last_error":"a\\u2028b\\u2029c"}'
  const event = makeEvent('s1', 1, 'account.state', payload)
  event.payload_sha256 = crypto.createHash('sha256').update(goBytes).digest('hex')
  assert.equal(executorPayloadHash(payload), event.payload_sha256)
  assert.deepEqual(validateExecutorEvent(event), { ok: true })
})

test(
  'cursor starts after what the Worker already acknowledged; stale account snapshots are not applied',
  withDb(async (db) => {
    const repo = await setup(db)
    const applied = []
    repo.recordRuntimeCredentials = (instance, items) => applied.push(items)
    const newer = makeEvent('s1', 3, 'account.state', { items: [{ account_id: 'new' }] })
    const older = {
      ...makeEvent('s1', 4, 'account.state', { items: [{ account_id: 'old' }] }),
      occurred_at: '2020-01-01T00:00:00.000Z',
    }
    const events = [
      makeEvent('s1', 1, 'account.state', { items: [{ account_id: 'ancient' }] }),
      makeEvent('s1', 2, 'account.state', { items: [{ account_id: 'ancient2' }] }),
      newer,
      older,
    ]
    const client = {
      async readEvents(instanceId, { after }) {
        return {
          ok: true,
          status: 200,
          data: { stream_id: 's1', acked: 2, events: events.filter((e) => e.seq > after) },
        }
      },
      async ackEvents() {
        return { ok: true }
      },
      async ackReceipt() {},
    }
    const ingest = createExecutorEventIngest({ db, repo, client })
    await ingest.tick()
    assert.deepEqual(applied, [[{ account_id: 'new' }]], 'events the Worker already acknowledged must be skipped')
    assert.equal(db.prepare("SELECT status FROM executor_event_inbox WHERE event_id='evt_s1_4'").get().status, 'stale')
    assert.equal(db.prepare('SELECT last_seq FROM executor_event_cursors').get().last_seq, 4)
  }),
)

test(
  'primary mode completes missing request attempts from request.finalized after the real-time window',
  withDb(async (db) => {
    const repo = await setup(db)
    const attemptsRepo = new RequestAttemptsRepo(db)
    let clock = 1_900_000_000_000
    const receipt = signedReceipt('d_attempts', {
      attempts: [{ account: 'a', status: 200, send_state: 'sent' }],
    })
    const worker = fakeWorker({ s1: [makeEvent('s1', 1, 'request.finalized', receipt)] })
    // 客户端请求有使用记录；只有这样的请求才补齐尝试（终审 A7）
    db.prepare(
      "INSERT INTO usage_logs(request_id,created_at,model,status,execution_kind,dispatch_id) VALUES('req_d_attempts',datetime('now'),'gpt-5.5',200,'gateway_worker','d_attempts')",
    ).run()
    const ingest = createExecutorEventIngest({
      db,
      repo,
      client: worker.client,
      attemptsRepo,
      now: () => clock,
    })
    await ingest.tick()
    assert.equal((await attemptsRepo.list('req_d_attempts')).length, 0, 'attempts wait for the real-time writer first')
    clock += 61_000
    const summary = await ingest.tick()
    assert.deepEqual(summary.attempts, { processed: 1, done: 1, skipped: 0, failed: 0 })
    const [row] = await attemptsRepo.list('req_d_attempts')
    assert.equal(row.route, 'native')
    assert.equal(row.terminal_state, 'verified')
    assert.equal(
      db.prepare("SELECT attempts_state FROM executor_event_inbox WHERE event_id='evt_s1_1'").get().attempts_state,
      'done',
    )
  }),
)

test(
  'a row that fails midway is rolled back on its own and retried (placeholder kept)',
  withDb(async (db) => {
    const repo = await setup(db)
    const real = new RequestAttemptsRepo(db)
    let clock = 1_900_000_000_000
    await real.record({
      requestId: 'req_d_fail',
      attemptNo: 1,
      accountId: null,
      selectionReason: 'gateway_worker_observed',
      upstreamStatus: 503,
      terminalState: 'cancelled',
      downstreamCommitted: true,
      action: 'client_closed',
      route: null,
    })
    let calls = 0
    const flaky = Object.create(real)
    flaky.record = (input) => {
      if (++calls === 2) throw new Error('disk hiccup')
      return real.record(input)
    }
    const receipt = signedReceipt('d_fail', {
      attempts: [
        { account: 'a', status: 429, category: 'rate_limited' },
        { account: 'a', status: 200, route: 'native' },
      ],
    })
    const worker = fakeWorker({ s1: [makeEvent('s1', 1, 'request.finalized', receipt)] })
    const ingest = createExecutorEventIngest({
      db,
      repo,
      client: worker.client,
      attemptsRepo: flaky,
      now: () => clock,
    })
    await ingest.tick()
    clock += 61_000
    const first = await ingest.tick()
    assert.equal(first.attempts.failed, 1)
    const kept = await real.list('req_d_fail')
    assert.equal(kept.length, 1, 'the partial rewrite is rolled back')
    assert.equal(kept[0].terminal_state, 'cancelled')
    clock += 5_000
    assert.equal((await ingest.tick()).attempts.processed, 0, 'retries back off')
    clock += 60_000
    const second = await ingest.tick()
    assert.equal(second.attempts.done, 1)
    const rows = await real.list('req_d_fail')
    assert.equal(rows.length, 2)
    assert.equal(rows[1].terminal_state, 'cancelled', 'the control-plane view survives the retry')
    assert.equal(rows[1].action, 'client_closed')
  }),
)

test(
  'retries end in failed after three backoffs; completion queries use the partial indexes',
  withDb(async (db) => {
    const repo = await setup(db)
    const real = new RequestAttemptsRepo(db)
    let clock = 1_900_000_000_000
    const broken = Object.create(real)
    broken.list = () => {
      throw new Error('always broken')
    }
    const worker = fakeWorker({
      s1: [
        makeEvent(
          's1',
          1,
          'request.finalized',
          signedReceipt('d_broken', { attempts: [{ account: 'a', status: 200 }] }),
        ),
      ],
    })
    const ingest = createExecutorEventIngest({
      db,
      repo,
      client: worker.client,
      attemptsRepo: broken,
      now: () => clock,
    })
    await ingest.tick()
    const state = () =>
      db.prepare("SELECT attempts_state FROM executor_event_inbox WHERE event_id='evt_s1_1'").get().attempts_state
    for (const wait of [61_000, 60_000, 5 * 60_000, 15 * 60_000]) {
      clock += wait
      await ingest.tick()
    }
    assert.equal(state(), 'failed')
    assert.deepEqual(
      (await ingest.stats({ since: 365 * 24 * 3600_000 })).attempts.map((row) => [row.state, row.n]),
      [['failed', 1]],
    )
    const plan = (sql) =>
      db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all()
        .map((row) => row.detail)
        .join(' ')
    assert.match(
      plan(
        "SELECT event_id FROM executor_event_inbox INDEXED BY idx_executor_inbox_attempts_todo WHERE attempts_state IS NULL AND type = 'request.finalized' AND mode = 'primary' AND status = 'applied' AND received_at < '9'",
      ),
      /idx_executor_inbox_attempts_todo/,
    )
    assert.equal(
      db.prepare("SELECT 1 FROM sqlite_master WHERE name='idx_executor_event_inbox_attempts_pending'").get(),
      undefined,
      'the unusable 103 index is dropped',
    )
  }),
)

test(
  'through ingest.tick, queued real-time rows are flushed first and never duplicated',
  withDb(async (db) => {
    const repo = await setup(db)
    const attemptsRepo = new RequestAttemptsRepo(db)
    let clock = 1_900_000_000_000
    const attempts = [
      { account: 'a', status: 429, category: 'rate_limited', duration_ms: 50 },
      { account: 'a', status: 200, route: 'native', duration_ms: 70 },
    ]
    const receipt = signedReceipt('d_chain', { attempts })
    armWriteBehind(db)
    try {
      await recordGatewayAttempts(attemptsRepo, {
        requestId: 'req_d_chain',
        model: 'gpt-5.5',
        result: { status: 200, headers: { 'x-kin-gateway-attempts': JSON.stringify(attempts) } },
        accountId: 'a',
        final: { terminalState: 'verified', downstreamCommitted: true },
      })
      assert.ok(pendingWrites() > 0)
      const worker = fakeWorker({ s2: [makeEvent('s2', 1, 'request.finalized', receipt)] })
      db.prepare('DELETE FROM executor_event_cursors').run()
      const primary = createExecutorEventIngest({
        db,
        repo,
        client: worker.client,
        attemptsRepo,
        now: () => clock,
      })
      await primary.tick()
      clock += 61_000
      const summary = await primary.tick()
      assert.equal(summary.attempts.done, 1)
      await flushWrites()
      const rows = await attemptsRepo.list('req_d_chain')
      assert.equal(rows.length, 2, 'no duplicate rows')
      assert.deepEqual(
        rows.map((row) => row.latency_ms),
        [50, 70],
      )
      assert.equal(rows[1].downstream_committed, true)
    } finally {
      armWriteBehind(null)
    }
  }),
)

test(
  'receipts with U+2028 hash like the Worker; warnings are throttled',
  withDb(async (db) => {
    const repo = await setup(db)
    // N4：回执 payload_hash 按 Go 口径（转义 U+2028/U+2029）
    const unsigned = {
      receipt_id: 'receipt_sep',
      dispatch_id: 'd_sep',
      request_id: 'req_sep',
      gateway_instance_id: 'gw-1',
      terminal_state: 'upstream_error',
      error_message: 'line\u2028break',
    }
    const goHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(Object.fromEntries(Object.entries(unsigned).sort())).replace(/\u2028/g, '\\u2028'))
      .digest('hex')
    assert.equal((await repo.ingestReceipt({ ...unsigned, payload_hash: goHash })).rejected, undefined)
    assert.equal(executorPayloadHash(unsigned), goHash)
    // N3：同类告警 5 分钟内只输出一次
    const warnings = []
    let clock = 1_900_000_000_000
    let seq = 100
    const client = {
      async readEvents() {
        seq++
        const bad = { ...makeEvent('s9', seq, 'account.state', { items: [] }), payload_sha256: 'bad' }
        return { ok: true, status: 200, data: { stream_id: 's9', events: [bad] } }
      },
      async ackEvents() {},
      async ackReceipt() {},
    }
    const ingest = createExecutorEventIngest({
      db,
      repo,
      client,
      now: () => clock,
      log: { warn: (message) => warnings.push(message) },
    })
    await ingest.tick()
    await ingest.tick()
    assert.equal(warnings.filter((message) => message.includes('invalid event')).length, 1)
    clock += 6 * 60_000
    await ingest.tick()
    assert.equal(warnings.filter((message) => message.includes('invalid event')).length, 2)
  }),
)

// 终审 A3：Worker 数据目录从旧快照恢复（流标识不变、序号回退）后，复用序号的新事件不能被跳过
test(
  'a Worker event log restored from an old snapshot is detected and its new events are processed',
  withDb(async (db) => {
    const repo = await setup(db)
    const receipts = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'].map((id) => signedReceipt(id))
    let stream = receipts.slice(0, 3).map((receipt, i) => makeEvent('s1', i + 1, 'request.finalized', receipt))
    let acked = 0
    const reads = []
    const client = {
      async readEvents(instanceId, { after }) {
        reads.push(after)
        const head = stream.at(-1)?.seq || 0
        return {
          ok: true,
          status: 200,
          data: { stream_id: 's1', head, acked, events: stream.filter((e) => e.seq > after) },
        }
      },
      async ackEvents(instanceId, streamId, seq) {
        acked = seq
        return { ok: true, status: 200, data: { acked: seq } }
      },
      async ackReceipt() {
        return { ok: true }
      },
    }
    const warnings = []
    const ingest = createExecutorEventIngest({
      db,
      repo,
      client,
      log: { warn: (m) => warnings.push(m) },
    })
    await ingest.tick()
    const ingested = () =>
      db
        .prepare('SELECT dispatch_id FROM gateway_worker_receipts ORDER BY dispatch_id')
        .all()
        .map((row) => row.dispatch_id)
    assert.deepEqual(ingested(), ['d1', 'd2', 'd3'])
    // 恢复到只有第 1 条、已确认 1 的快照，随后写入了 3 条新事件（序号 2–4，与已处理的 2、3 撞号）
    acked = 1
    stream = [stream[0], ...receipts.slice(3).map((receipt, i) => makeEvent('s1', i + 2, 'request.finalized', receipt))]
    await ingest.tick()
    assert.deepEqual(ingested(), ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'])
    assert.ok(warnings.some((line) => line.includes('went back')))
    // 之后正常拉取不再误判
    warnings.length = 0
    await ingest.tick()
    assert.equal(warnings.filter((line) => line.includes('went back')).length, 0)
    assert.equal(acked, 4)
  }),
)

// 终审 A4：Go 的 RFC3339Nano 小数位数可变，按数值比较时间
test(
  'account snapshots compare times numerically across variable fraction digits',
  withDb(async (db) => {
    const repo = await setup(db)
    const applied = []
    repo.recordRuntimeCredentials = (instance, items) => applied.push(items[0].account_id)
    const at = (seq, occurredAt, stream = 's1') => ({
      ...makeEvent(stream, seq, 'account.state', { items: [{ account_id: `a${seq}${stream}` }] }),
      occurred_at: occurredAt,
    })
    let events = [at(1, '2026-11-05T01:02:03.4Z'), at(2, '2026-11-05T01:02:03.456Z')]
    let active = 's1'
    const client = {
      async readEvents(instanceId, { after, streamId }) {
        if (streamId && streamId !== active) return { ok: false, status: 409, data: { stream_id: active } }
        return { ok: true, status: 200, data: { stream_id: active, events: events.filter((e) => e.seq > after) } }
      },
      async ackEvents() {
        return { ok: true }
      },
      async ackReceipt() {},
    }
    const ingest = createExecutorEventIngest({ db, repo, client })
    await ingest.tick()
    // 新流里更早（03.42 < 03.456）的快照被判为过时
    active = 's2'
    events = [at(1, '2026-11-05T01:02:03.42Z', 's2'), at(2, '2026-11-05T01:02:03.5Z', 's2')]
    await ingest.tick()
    assert.deepEqual(applied, ['a1s1', 'a2s1', 'a2s2'])
  }),
)

// 终审 A5：一直处理失败的事件重试有上限，之后跳过，后续事件照常处理
test(
  'a poison event is skipped after repeated failures instead of stalling the stream',
  withDb(async (db) => {
    const repo = await setup(db)
    const good = signedReceipt('d_after')
    const events = [
      makeEvent('s1', 1, 'account.state', { items: [{ account_id: 'boom' }] }),
      makeEvent('s1', 2, 'request.finalized', good),
    ]
    repo.recordRuntimeCredentials = () => {
      throw new Error('handler bug')
    }
    const worker = fakeWorker({ s1: events })
    const ingest = createExecutorEventIngest({ db, repo, client: worker.client, log: { warn() {} } })
    for (let i = 1; i < POISON_RETRIES; i++) {
      await ingest.tick()
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM gateway_worker_receipts').get().n, 0, `stuck on try ${i}`)
    }
    await ingest.tick()
    assert.equal(db.prepare("SELECT status FROM executor_event_inbox WHERE event_id='evt_s1_1'").get().status, 'failed')
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM gateway_worker_receipts WHERE dispatch_id='d_after'").get().n, 1)
  }),
)

// 降级演练 M3：控制面数据库写不进去（写锁被占、只读、磁盘满）不算事件本身的问题：不计入毒事件次数、不推进游标、
// 不写 failed，恢复后照常处理
test(
  'database unavailability does not turn an event into a poison event',
  withDb(async (db) => {
    const repo = await setup(db)
    const events = [makeEvent('s1', 1, 'request.finalized', signedReceipt('d_db_down'))]
    const ingestReceipt = repo.ingestReceipt.bind(repo)
    let down = true
    repo.ingestReceipt = async (receipt) => {
      if (down) throw Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 })
      return ingestReceipt(receipt)
    }
    const worker = fakeWorker({ s1: events })
    const ingest = createExecutorEventIngest({ db, repo, client: worker.client, log: { warn() {} } })
    for (let i = 0; i < POISON_RETRIES + 2; i++) await ingest.tick()
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM executor_event_inbox').get().n, 0, 'no failed row is written')
    assert.equal(worker.calls.ack.length, 0, 'nothing is acknowledged while the database is down')
    down = false
    await ingest.tick()
    assert.equal(
      db.prepare("SELECT status FROM executor_event_inbox WHERE event_id='evt_s1_1'").get().status,
      'applied',
    )
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM gateway_worker_receipts WHERE dispatch_id='d_db_down'").get().n,
      1,
    )
    assert.equal(worker.calls.ack.at(-1).seq, 1)
  }),
)

// 终审 B3：序号缺口先不确认、下一轮重试；连续多轮仍是同一缺口才接受
test(
  'a sequence gap is retried before it is accepted and acknowledged',
  withDb(async (db) => {
    const repo = await setup(db)
    const events = [
      makeEvent('s1', 1, 'request.finalized', signedReceipt('g1')),
      makeEvent('s1', 3, 'request.finalized', signedReceipt('g3')),
    ]
    const worker = fakeWorker({ s1: events })
    const ingest = createExecutorEventIngest({ db, repo, client: worker.client, log: { warn() {} } })
    for (let i = 1; i < POISON_RETRIES; i++) {
      await ingest.tick()
      assert.equal(worker.calls.ack.at(-1)?.seq, 1, `the gap is not acknowledged on try ${i}`)
    }
    await ingest.tick()
    assert.equal(worker.calls.ack.at(-1).seq, 3)
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM gateway_worker_receipts WHERE dispatch_id='g3'").get().n, 1)
  }),
)

// 旧版 Worker 的事件仍带 usage.attribution：收件箱不保存它；同一事件重发不被误判为数据目录回滚；比对工具不报 usage 差异
test(
  'inbox payloads drop usage attribution from older Workers without breaking duplicate detection',
  withDb(async (db) => {
    const repo = await setup(db)
    const attribution = { items: { msg_1: { input_tokens: 3 }, msg_2: { input_tokens: 4 } } }
    const receipt = signedReceipt('d_attr', { usage: { input_tokens: 5, output_tokens: 2, attribution } })
    const stream = [makeEvent('s1', 1, 'request.finalized', receipt)]
    let acked = 0
    const client = {
      async readEvents(instanceId, { after }) {
        return {
          ok: true,
          status: 200,
          data: { stream_id: 's1', head: 1, acked, events: stream.filter((e) => e.seq > after) },
        }
      },
      async ackEvents(instanceId, streamId, seq) {
        acked = seq
        return { ok: true, status: 200, data: { acked: seq } }
      },
      async ackReceipt() {
        return { ok: true }
      },
    }
    const warnings = []
    const ingest = createExecutorEventIngest({
      db,
      repo,
      client,
      log: { warn: (m) => warnings.push(m) },
    })
    await ingest.tick()
    const rows = () => db.prepare('SELECT event_id,payload_json FROM executor_event_inbox').all()
    assert.equal(rows().length, 1)
    assert.equal(JSON.parse(rows()[0].payload_json).usage.attribution, undefined, 'the inbox must not keep attribution')
    assert.equal(JSON.parse(rows()[0].payload_json).usage.input_tokens, 5)
    const stored = db.prepare("SELECT usage_json FROM gateway_worker_receipts WHERE dispatch_id='d_attr'").get()
    assert.equal(JSON.parse(stored.usage_json).attribution, undefined)
    // 同一事件再次送达（例如 Worker 的确认位置回退）：内容相同，不是回滚，不生成派生 ID 的重复行
    acked = 0
    await ingest.tick()
    assert.equal(rows().length, 1)
    assert.ok(!rows()[0].event_id.includes('~'))
    assert.equal(warnings.filter((line) => line.includes('went back')).length, 0)
    const report = diffDatabase(db)
    assert.deepEqual(
      report.differing.filter((item) => item.dispatch_id === 'd_attr'),
      [],
    )
  }),
)
