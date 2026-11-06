import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { UsageLogsRepo } from '../../src/lib/db/repos/usage-logs-repo.mjs'
import { UsageStatsWorker } from '../../src/lib/admin/usage-stats-worker.mjs'
import { RequestLogStore } from '../../src/lib/admin/request-log.mjs'

function fixture(t, options) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-stats-worker-'))
  const db = createDatabase({ dbPath: path.join(dir, 'kin.db') })
  const repo = new UsageLogsRepo(db)
  const worker = new UsageStatsWorker(db, options)
  t.after(async () => {
    await worker.close()
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const add = (id) =>
    repo.insertSummary({
      id,
      request_id: id,
      created_at: new Date().toISOString(),
      status: 200,
      account_id: 'a',
      vm_id: 'vm-a',
      model: 'claude-opus-5',
      input_tokens: 1000,
      total_cost: 0.005,
      pricing_model: 'claude-opus-5',
    })
  return { db, repo, worker, add }
}

test('worker matches billing semantics and sees writes, deletes, and changed quota windows', async (t) => {
  const { db, repo, worker, add } = fixture(t)
  await add('first')
  const opts = { accountWindows: [{ account_id: 'a', vm_id: 'vm-a' }] }
  const at = { ...opts, now: Date.now() }
  assert.deepEqual(await worker.billingStats(at), await repo.billingStats(at))
  await add('second')
  assert.equal((await worker.billingStats(opts)).total.requests, 2)
  db.prepare('DELETE FROM usage_logs WHERE id = ?').run('first')
  assert.equal((await worker.billingStats(opts)).total.requests, 1)
  const rolled = {
    accountWindows: [{ account_id: 'a', vm_id: 'vm-a', reset_5h: new Date(Date.now() + 1).toISOString() }],
    now: Date.now() + 2,
  }
  assert.equal((await worker.billingStats(rolled)).accounts[0].window_5h_requests, 0)
})

test('refreshes coalesce, post-write calls get a new snapshot, and the queue is bounded', async (t) => {
  const { worker, add } = fixture(t)
  await add('first')
  const first = worker.billingStats()
  assert.equal(worker.billingStats(), first)
  await add('second')
  const afterWrite = worker.billingStats()
  assert.notEqual(afterWrite, first)
  await add('third')
  assert.equal(worker.billingStats(), afterWrite, 'queued work includes all writes before dispatch')
  await first
  assert.equal((await afterWrite).total.requests, 3)

  const requests = Array.from({ length: 18 }, (_, now) => worker.billingStats({ now }))
  const results = Promise.allSettled(requests)
  await worker.close()
  const settled = await results
  assert.ok(settled.some((result) => result.reason?.code === 'stats_busy'))
  assert.ok(settled.every((result) => result.status === 'rejected'))
})

test('a warm worker computes a large real SQLite snapshot while the main thread keeps ticking', async (t) => {
  const { db, worker } = fixture(t)
  await worker.billingStats()
  // Whole hours come from the rollup; the hour a quota window starts in is read row by row.
  // Put every row in that edge hour so the worker still has a large real scan to do.
  const hour = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 2 * 3_600_000
  const at = new Date(hour + 30 * 60_000).toISOString()
  db.exec(`WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n < 30000)
    INSERT INTO usage_logs(id, request_id, created_at, status, account_id, vm_id, input_tokens, total_cost, pricing_model)
    SELECT 'log-' || n, 'req-' || n, '${at}', 200,
      'a', 'vm-a', 1000, 0.005, 'claude-opus-5' FROM seq`)
  const reset5h = new Date(hour + 10 * 60_000 + 5 * 3_600_000).toISOString()
  let ticks = 0
  const timer = setInterval(() => ticks++, 2)
  try {
    const bill = await worker.billingStats({ accountWindows: [{ account_id: 'a', vm_id: 'vm-a', reset_5h: reset5h }] })
    assert.equal(bill.total.requests, 30000)
    assert.equal(bill.total.total_cost, 150)
    assert.equal(bill.accounts[0].window_5h_requests, 30000)
    assert.equal(bill.accounts[0].window_5h_cost, 150)
    assert.ok(ticks > 2, `main-thread ticks during warm query: ${ticks}`)
  } finally {
    clearInterval(timer)
  }
})

test('worker failure rejects in-flight work and a subsequent call restarts it', async (t) => {
  const { worker, add } = fixture(t)
  await add('first')
  const failed = assert.rejects(worker.billingStats(), /worker exited/)
  await worker.worker.terminate()
  await failed
  assert.equal((await worker.billingStats()).total.requests, 1)
})

test('read-only diagnostics skip repair; normal reporting retains historical cost repair', async (t) => {
  const { db, worker } = fixture(t, { readOnly: true })
  db.exec(`INSERT INTO usage_logs(id, request_id, created_at, status, model, input_tokens)
    VALUES('old', 'old', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 200, 'claude-opus-5', 1000000)`)
  await worker.billingStats()
  assert.equal(db.prepare('SELECT pricing_model FROM usage_logs').get().pricing_model, null)
  const repair = new UsageStatsWorker(db)
  try {
    assert.equal((await repair.billingStats()).total.total_cost, 5)
    assert.equal(db.prepare('SELECT actual_cost FROM usage_logs').get().actual_cost, 5)
  } finally {
    await repair.close()
  }
})

test('store pause drains old readers and rebind uses the new database', async (t) => {
  const old = fixture(t)
  const next = fixture(t)
  old.add('old')
  next.add('new-1')
  next.add('new-2')
  const store = new RequestLogStore({ db: old.db })
  t.after(() => store.pauseStatistics())
  assert.equal((await store.billingStats()).total.requests, 1)
  await store.pauseStatistics()
  await assert.rejects(store.billingStats(), /paused/)
  store.rebind(next.db)
  store.resumeStatistics()
  assert.equal((await store.billingStats()).total.requests, 2)
})
