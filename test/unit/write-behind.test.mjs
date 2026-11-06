import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { RequestLogStore } from '../../src/lib/admin/request-log.mjs'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { RequestAttemptsRepo } from '../../src/lib/db/repos/request-attempts-repo.mjs'
import {
  WRITE_KIND,
  armWriteBehind,
  enqueueWrite,
  flushWrites,
  pendingWrites,
  setWriteBehindLimit,
  writeBehindArmed,
  writeBehindStats,
} from '../../src/lib/db/write-behind.mjs'

test('finish returns before the usage row is written, and flush commits it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-write-behind-'))
  const db = createDatabase({ dataDir: dir })
  const store = new RequestLogStore({ dataDir: dir, db, mode: 'normal' })
  armWriteBehind(db)
  try {
    const ctx = store.start({ headers: {}, socket: {} }, { protocol: 'anthropic.messages', pathName: '/v1/messages' })
    const summary = await store.finish(ctx, {
      status: 200,
      model: 'claude-haiku-4-5',
      input_tokens: 3,
      output_tokens: 1,
    })
    assert.equal(pendingWrites() > 0, true)
    assert.equal(await store.repo.getByRequestId(summary.request_id), null)
    await flushWrites()
    assert.equal(pendingWrites(), 0)
    assert.equal((await store.repo.getByRequestId(summary.request_id))?.status, 200)
    assert.equal(writeBehindArmed(), true)
  } finally {
    armWriteBehind(null)
    await flushWrites()
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// 技术债 M5：有界写回队列。观测写入（请求尝试）满了丢弃并计数；计费写入（使用记录）满了直接落库，不丢。
test('a full queue drops observation writes with a count and writes billing rows directly', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-write-behind-cap-'))
  const db = createDatabase({ dataDir: dir })
  const store = new RequestLogStore({ dataDir: dir, db, mode: 'normal' })
  const attempts = new RequestAttemptsRepo(db)
  armWriteBehind(db)
  setWriteBehindLimit(2)
  const before = writeBehindStats()
  try {
    let ran = 0
    assert.equal(
      enqueueWrite(async () => ran++),
      true,
    )
    assert.equal(
      enqueueWrite(async () => ran++, { kind: WRITE_KIND.OBSERVATION }),
      true,
    )
    // 队列已满：观测写入被丢弃
    assert.equal(
      enqueueWrite(async () => ran++, { kind: WRITE_KIND.OBSERVATION }),
      false,
    )
    await attempts.begin({ requestId: 'req-dropped', attemptNo: 1, vmId: 'vm-1', accountId: 'a', model: 'm' })
    // 计费写入不入队，由调用方直接写：finish 返回时行已落库
    assert.equal(
      enqueueWrite(async () => ran++, { kind: WRITE_KIND.BILLING }),
      false,
    )
    const ctx = store.start({ headers: {}, socket: {} }, { protocol: 'anthropic.messages', pathName: '/v1/messages' })
    const summary = await store.finish(ctx, {
      status: 200,
      model: 'claude-haiku-4-5',
      input_tokens: 3,
      output_tokens: 1,
    })
    assert.equal((await store.repo.getByRequestId(summary.request_id))?.status, 200)
    const stats = writeBehindStats()
    assert.equal(stats.queued, 2)
    assert.equal(stats.max_queue, 2)
    assert.equal(stats.dropped_observation - before.dropped_observation, 2)
    assert.equal(stats.billing_direct - before.billing_direct, 2)
    await flushWrites()
    assert.equal(ran, 2)
    assert.deepEqual(await attempts.list('req-dropped'), [])
    // 有空位后观测写入照常入队并落库
    await attempts.begin({ requestId: 'req-kept', attemptNo: 1, vmId: 'vm-1', accountId: 'a', model: 'm' })
    await flushWrites()
    assert.equal((await attempts.list('req-kept')).length, 1)
  } finally {
    setWriteBehindLimit(null)
    armWriteBehind(null)
    await flushWrites()
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
