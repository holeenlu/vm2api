// 中期技术债 M3 复审：推理收口写不进库时的重试、停机落盘与补写（P1-3、P2-2、P2-3、P2-4）
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { closeDatabase, openDatabase } from '../../src/lib/db/database.mjs'
import { dbClient } from '../../src/lib/db/db-client.mjs'
import { armWriteBehind, flushWrites, pendingWrites } from '../../src/lib/db/write-behind.mjs'
import { armWriteHealth, noteWriteFailure, probeOnce, RECOVERY_PROBES } from '../../src/lib/db/write-health.mjs'
import {
  MAX_OTHER_FAILURES,
  PENDING_COMMITS_FILE,
  commitRetryStats,
  flushCommitRetries,
  reportPendingCommitsFile,
  retryCommit,
} from '../../src/lib/db/commit-retry.mjs'
import { RelayBilling, previewSettlement } from '../../src/lib/admin/relay-billing.mjs'
import { PanelUserStore } from '../../src/lib/admin/panel-users.mjs'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
import { GroupsRepo } from '../../src/lib/db/repos/groups-repo.mjs'
import { RequestLogStore } from '../../src/lib/admin/request-log.mjs'
import { PENDING_COMMIT_VERSION, replayPendingCommit } from '../../src/lib/admin/settlement-replay.mjs'
import { replayPendingCommits } from '../../scripts/replay-pending-commits.mjs'

const MODEL = 'gpt-5.5'
const USAGE = { input_tokens: 20000, output_tokens: 4000 }

function quiet(t) {
  const { warn, error } = console
  const lines = []
  console.warn = (...args) => lines.push(args.join(' '))
  console.error = (...args) => lines.push(args.join(' '))
  t.after(() => {
    console.warn = warn
    console.error = error
  })
  return lines
}

async function fixture(t) {
  await closeDatabase()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-retry-'))
  const db = openDatabase({ dataDir: dir })
  t.after(async () => {
    armWriteBehind(null)
    armWriteHealth(null)
    await closeDatabase()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const users = new PanelUserStore({ db })
  const user = await users.create({ username: 'customer', password: 'customer-pass' })
  const groups = new GroupsRepo(db)
  const group = await groups.create({ name: 'codex', platform: 'openai' })
  await groups.setGrants(user.id, [group.id])
  const keys = new ApiKeyStore({ db })
  const key = await keys.create({ user_id: user.id, group_id: group.id })
  const billing = new RelayBilling(db)
  await billing.adjust(user.id, { amount: 10, reason: 'test credit', idempotency_key: 'credit-1' }, 'test-admin')
  const store = new RequestLogStore({ dataDir: dir, db, mode: 'normal' })
  const file = path.join(store.root, PENDING_COMMITS_FILE)
  const balance = async () => (await billing.balance(user.id)).balance
  const charges = (requestId) =>
    db.prepare('SELECT COUNT(*) AS n FROM billing_charges WHERE request_id=?').get(requestId).n
  const requests = () => db.prepare('SELECT requests FROM api_keys WHERE id=?').get(key.id).requests
  return { dir, db, user, group, key, keys, billing, store, file, balance, charges, requests }
}

// 与 handle-protocol 收口失败时交给重试的条目同形：冻结的结算上下文、计费用量与使用记录摘要（原始完成时刻）
async function pendingEntry(f, requestId, finishedAt = Date.parse('2026-11-06T10:00:00.000Z')) {
  const context = await f.billing.authorize(f.key, requestId, MODEL, { model: MODEL })
  const preview = previewSettlement(context, USAGE, MODEL)
  const ctx = { ...f.store.start({ headers: {}, socket: {} }, { protocol: 'openai.responses' }), request_id: requestId }
  ctx.t0 = finishedAt - 1500
  const summary = await f.store.finish(
    ctx,
    {
      status: 200,
      model: MODEL,
      usage: USAGE,
      user_id: f.user.id,
      api_key_id: f.key.id,
      group_id: f.group.id,
      rate_multiplier: preview.rate_multiplier,
      billing_status: preview.status,
      actual_cost_micros: preview.actual_micros,
    },
    { now: finishedAt, persist: false },
  )
  return {
    version: PENDING_COMMIT_VERSION,
    request_id: requestId,
    plan: {
      settle: { context, usage: USAGE, model: MODEL, api_key_id: f.key.id, actual_micros: preview.actual_micros },
    },
    summary,
  }
}

const deps = (f) => ({ apiKeys: f.keys, usageLogs: f.store.repo })

test('replaying a pending commit settles once, writes the usage row once and keeps the original completion time', async (t) => {
  const f = await fixture(t)
  const entry = await pendingEntry(f, 'req_replay_once')
  assert.ok(entry.plan.settle.actual_micros > 0)
  const before = await f.balance()
  const first = await replayPendingCommit(f.db, entry, deps(f))
  const second = await replayPendingCommit(f.db, entry, deps(f))
  assert.deepEqual(first, { request_id: 'req_replay_once', settled: 'settled', inserted: true })
  assert.equal(second.inserted, false)
  assert.equal(f.charges('req_replay_once'), 1)
  assert.equal(Math.round((before - (await f.balance())) * 1e6), entry.plan.settle.actual_micros)
  assert.equal(f.requests(), 1, 'key usage is recorded once')
  const row = await f.store.repo.getByRequestId('req_replay_once')
  assert.equal(row.billing_status, 'settled')
  assert.equal(row.actual_cost_micros, entry.plan.settle.actual_micros)
  assert.equal(row.ts, '2026-11-06T10:00:00.000Z')
  assert.equal(row.duration_ms, 1500)
})

test('the replay script previews read-only and applies idempotently, keeping invalid lines', async (t) => {
  const f = await fixture(t)
  const entry = await pendingEntry(f, 'req_script')
  fs.mkdirSync(path.dirname(f.file), { recursive: true })
  const line = (e) => JSON.stringify({ at: new Date().toISOString(), reason: 'shutdown', entry: e })
  fs.writeFileSync(f.file, `${line(entry)}\n${line(entry)}\nnot json\n`, { mode: 0o600 })
  const preview = await replayPendingCommits({ db: f.db, file: f.file })
  assert.deepEqual(preview.request_ids, ['req_script', 'req_script'])
  assert.equal(preview.invalid, 1)
  assert.equal(f.charges('req_script'), 0, 'preview writes nothing')
  const report = await replayPendingCommits({ db: f.db, file: f.file, apply: true })
  assert.equal(report.replayed, 2)
  assert.equal(report.inserted, 1)
  assert.equal(report.existing, 1)
  assert.equal(f.charges('req_script'), 1)
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'not json\n', 'only the invalid line is left')
})

test('retries run one at a time, stop at the first database error, and wait for recovery', async (t) => {
  const f = await fixture(t)
  quiet(t)
  armWriteHealth(f.db)
  const order = []
  const replay = async (entry) => {
    order.push(entry.request_id)
    return dbClient(f.db).run('INSERT INTO settings(key,value,updated_at) VALUES (?,?,?)', entry.request_id, '1', 'x')
  }
  const before = commitRetryStats()
  noteWriteFailure(f.db, { errcode: 5, message: 'database is locked' })
  for (const id of ['r1', 'r2', 'r3']) assert.equal(retryCommit({ request_id: id }, { replay }), true)
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.deepEqual(order, [], 'nothing is replayed while the database is not writable')
  for (let i = 0; i < RECOVERY_PROBES; i++) await probeOnce()
  for (let i = 0; i < 50 && commitRetryStats().pending > before.pending; i++)
    await new Promise((resolve) => setTimeout(resolve, 5))
  assert.deepEqual(order, ['r1', 'r2', 'r3'])
  assert.equal(commitRetryStats().recovered, before.recovered + 3)

  // 第一笔遇到数据库错误：本轮其余条目不执行，停机时全部落盘
  const tried = []
  const busy = async (entry) => {
    tried.push(entry.request_id)
    throw Object.assign(new Error('database is locked'), { errcode: 5 })
  }
  retryCommit({ request_id: 'b1' }, { replay: busy, file: f.file })
  retryCommit({ request_id: 'b2' }, { replay: busy, file: f.file })
  const report = await flushCommitRetries()
  assert.deepEqual(tried, ['b1'])
  assert.equal(report.left, 2)
  assert.equal(report.persisted, 2)
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600)
  const saved = fs
    .readFileSync(f.file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.deepEqual(
    saved.map((line) => [line.entry.request_id, line.reason]),
    [
      ['b1', 'shutdown'],
      ['b2', 'shutdown'],
    ],
  )
  assert.equal(reportPendingCommitsFile(f.file), 2)
})

test('a non-database failure is retried a bounded number of times, then saved for replay with an alert', async (t) => {
  const f = await fixture(t)
  const lines = quiet(t)
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
  let calls = 0
  const broken = async () => {
    calls++
    throw new Error('constraint failed')
  }
  const before = commitRetryStats()
  retryCommit({ request_id: 'bad_1' }, { replay: broken, file: f.file })
  for (let i = 0; i < MAX_OTHER_FAILURES + 2; i++) {
    t.mock.timers.tick(60_000)
    for (let j = 0; j < 5; j++) await Promise.resolve()
  }
  assert.equal(calls, MAX_OTHER_FAILURES)
  assert.equal(commitRetryStats().pending, before.pending)
  assert.equal(commitRetryStats().persisted, before.persisted + 1)
  const saved = JSON.parse(fs.readFileSync(f.file, 'utf8').trim())
  assert.equal(saved.entry.request_id, 'bad_1')
  assert.equal(saved.reason, 'failed')
  assert.equal(saved.attempts, MAX_OTHER_FAILURES)
  assert.ok(lines.some((line) => /bad_1 failed 5 times/.test(line)))
})

test('a usage row queued from a settlement transaction that rolled back is not written (M3 review P2-4)', async (t) => {
  const f = await fixture(t)
  armWriteBehind(f.db)
  const finish = (requestId) => {
    const ctx = {
      ...f.store.start({ headers: {}, socket: {} }, { protocol: 'openai.responses' }),
      request_id: requestId,
    }
    return f.store.finish(ctx, { status: 200, model: MODEL, billing_status: 'settled' })
  }
  await assert.rejects(
    dbClient(f.db).tx(async () => {
      await finish('req_rolled_back')
      throw new Error('settlement failed')
    }),
    /settlement failed/,
  )
  await dbClient(f.db).tx(() => finish('req_committed'))
  assert.equal(pendingWrites(), 2)
  await flushWrites()
  assert.equal(await f.store.repo.getByRequestId('req_rolled_back'), null)
  assert.equal((await f.store.repo.getByRequestId('req_committed'))?.status, 200)
})
