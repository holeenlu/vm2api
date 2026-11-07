import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { GatewayWorkerRepo } from '../../src/lib/gateway-worker/gateway-repo.mjs'
import { bodyHash } from '../../src/lib/gateway-worker/gateway-auth.mjs'
import { compareFinalized, diffDatabase } from '../../scripts/executor-replay-diff.mjs'

function receipt(dispatch, extra = {}) {
  const unsigned = {
    receipt_id: `receipt_${dispatch}`,
    dispatch_id: dispatch,
    request_id: `req_${dispatch}`,
    gateway_instance_id: 'gw-1',
    runtime_account_id: 'a',
    send_state: 'sent',
    terminal_state: 'completed',
    upstream_status: 200,
    upstream_model: 'gpt-5.5',
    usage_confidence: 'complete',
    usage: { input_tokens: 5, output_tokens: 2 },
    ...extra,
  }
  return { ...unsigned, payload_hash: bodyHash(unsigned) }
}

test('replay diff reports billing-field differences between events and receipts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-diff-'))
  const db = createDatabase({ dataDir: dir })
  try {
    const repo = new GatewayWorkerRepo(db)
    await repo.upsertInstance({ id: 'gw-1', name: 'gw', base_url: 'http://127.0.0.1:1', health_state: 'healthy' })
    const same = receipt('d_same')
    await repo.ingestReceipt(same)
    await repo.ingestReceipt(receipt('d_usage'))
    const insert = db.prepare(
      `INSERT INTO executor_event_inbox(event_id,instance_id,stream_id,seq,type,occurred_at,payload_json,mode,status,received_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
    )
    const at = new Date().toISOString()
    insert.run('evt_s_1', 'gw-1', 's', 1, 'request.finalized', at, JSON.stringify(same), 'shadow', 'matched', at)
    insert.run(
      'evt_s_2',
      'gw-1',
      's',
      2,
      'request.finalized',
      at,
      JSON.stringify(receipt('d_usage', { usage: { input_tokens: 6, output_tokens: 2 } })),
      'shadow',
      'diff',
      at,
    )
    insert.run(
      'evt_s_3',
      'gw-1',
      's',
      3,
      'request.finalized',
      at,
      JSON.stringify(receipt('d_missing')),
      'shadow',
      'missing',
      at,
    )
    // 请求尝试条数不一致也算差异
    insert.run(
      'evt_s_4',
      'gw-1',
      's',
      4,
      'request.finalized',
      at,
      JSON.stringify({ ...same, request_id: 'req_attempts', attempts: [{ account: 'a' }, { account: 'b' }] }),
      'primary',
      'applied',
      at,
    )
    db.prepare(
      "INSERT INTO request_attempts(request_id,attempt_no,selection_reason,started_at) VALUES('req_attempts',1,'gateway_worker',?)",
    ).run(at)
    // 交付时不写尝试的通道（实时语音 calls）：尚未由事件补齐前不算差异
    insert.run(
      'evt_s_5',
      'gw-1',
      's',
      5,
      'request.finalized',
      at,
      JSON.stringify({ ...same, request_id: 'req_realtime', operation: 'live', attempts: [{ account: 'a' }] }),
      'shadow',
      'matched',
      at,
    )
    // 其他通道一行都没有、primary 下补齐失败：都算差异（R2 第二轮复审 N6）
    insert.run(
      'evt_s_6',
      'gw-1',
      's',
      6,
      'request.finalized',
      at,
      JSON.stringify({ ...same, request_id: 'req_lost', operation: 'responses', attempts: [{ account: 'a' }] }),
      'shadow',
      'matched',
      at,
    )
    insert.run(
      'evt_s_7',
      'gw-1',
      's',
      7,
      'request.finalized',
      at,
      JSON.stringify({ ...same, request_id: 'req_failed', operation: 'live', attempts: [{ account: 'a' }] }),
      'primary',
      'applied',
      at,
    )
    db.prepare("UPDATE executor_event_inbox SET attempts_state='failed' WHERE event_id='evt_s_7'").run()
    // 这些都是客户端请求（有使用记录）；没有使用记录的请求不比较尝试条数（终审复核 N1）
    for (const id of ['req_attempts', 'req_realtime', 'req_lost', 'req_failed'])
      db.prepare("INSERT INTO usage_logs(request_id,created_at,model,status) VALUES(?,?,'gpt-5.5',200)").run(id, at)
    const report = diffDatabase(db)
    assert.equal(report.attempts_pending, 1)
    assert.deepEqual(
      report.differing.filter((item) => ['evt_s_6', 'evt_s_7'].includes(item.event_id)).map((item) => item.diffs),
      [[{ field: 'attempts', event: 1, receipt: 0 }], [{ field: 'attempts', event: 1, receipt: 0 }]],
    )
    report.differing = report.differing.filter((item) => !['evt_s_6', 'evt_s_7'].includes(item.event_id))
    report.checked -= 2
    const attemptDiff = report.differing.find((item) => item.event_id === 'evt_s_4')
    assert.deepEqual(attemptDiff.diffs, [{ field: 'attempts', event: 2, receipt: 1 }])
    report.differing = report.differing.filter((item) => item.event_id !== 'evt_s_4')
    report.checked--
    assert.equal(report.checked, 4)
    assert.equal(report.matched, 2)
    assert.deepEqual(
      report.differing.map((item) => [item.dispatch_id, item.diffs.map((diff) => diff.field)]),
      [
        ['d_usage', ['usage']],
        ['d_missing', ['*']],
      ],
    )
    assert.ok(report.statuses.some((row) => row.status === 'missing'))
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
  assert.deepEqual(compareFinalized({ upstream_status: '200' }, null), [{ field: '*', reason: 'receipt_missing' }])
})

// 终审 A1、A2：回执没有对应事件、账本与回执不一致、收件箱问题状态与信封无效的事件都要报出来，且不崩溃
test('replay diff finds receipts without events, ledger mismatches and invalid inbox rows', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-diff-reverse-'))
  const db = createDatabase({ dataDir: dir })
  try {
    const repo = new GatewayWorkerRepo(db)
    await repo.upsertInstance({ id: 'gw-1', name: 'gw', base_url: 'http://127.0.0.1:1', health_state: 'healthy' })
    const now = Date.now()
    const old = new Date(now - 20 * 60_000).toISOString()
    const recent = new Date(now - 60_000).toISOString()
    const insert = db.prepare(
      `INSERT INTO executor_event_inbox(event_id,instance_id,stream_id,seq,type,occurred_at,payload_json,mode,status,received_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
    )
    const ledger = db.prepare(
      "INSERT INTO usage_logs(request_id,created_at,model,status,execution_kind,dispatch_id,usage_confidence,input_tokens,output_tokens,total_cost) VALUES(?,?,'gpt-5.5',200,'gateway_worker',?,?,?,?,?)",
    )
    // 实例从 30 分钟前开始消费事件
    const start = new Date(now - 30 * 60_000).toISOString()
    const seen = receipt('d_seen')
    await repo.ingestReceipt(seen)
    insert.run('evt_r_1', 'gw-1', 's', 1, 'request.finalized', start, JSON.stringify(seen), 'shadow', 'matched', start)
    ledger.run('req_d_seen', start, 'd_seen', 'complete', 5, 2, 0.01)
    // 有回执、没有事件：超过 5 分钟算差异，最近的记为待到达
    await repo.ingestReceipt(receipt('d_lost'))
    await repo.ingestReceipt(receipt('d_recent'))
    // 账本 token 与回执不一致、缺成本
    await repo.ingestReceipt(receipt('d_ledger'))
    insert.run(
      'evt_r_2',
      'gw-1',
      's',
      2,
      'request.finalized',
      old,
      JSON.stringify(receipt('d_ledger')),
      'shadow',
      'matched',
      old,
    )
    ledger.run('req_d_ledger', old, 'd_ledger', 'complete', 4, 2, null)
    db.prepare("UPDATE usage_logs SET input_tokens=4,total_cost=NULL WHERE dispatch_id='d_ledger'").run()
    db.prepare('UPDATE gateway_worker_receipts SET received_at=? WHERE dispatch_id IN (?,?,?)').run(
      old,
      'd_lost',
      'd_ledger',
      'd_seen',
    )
    db.prepare('UPDATE gateway_worker_receipts SET received_at=? WHERE dispatch_id=?').run(recent, 'd_recent')
    // 信封无效的事件
    insert.run(
      'evt_r_3',
      'gw-1',
      's',
      3,
      'request.finalized',
      old,
      JSON.stringify({ event_id: 'evt_r_3', payload: { request_id: 'x' } }),
      'shadow',
      'invalid',
      old,
    )
    // 实例仍在消费事件（最近有收件）
    insert.run(
      'evt_r_4',
      'gw-1',
      's',
      4,
      'account.state',
      recent,
      JSON.stringify({ items: [] }),
      'shadow',
      'recorded',
      recent,
    )
    const report = diffDatabase(db, { now })
    const byDispatch = (id) => report.differing.find((item) => item.dispatch_id === id)?.diffs || []
    assert.deepEqual(byDispatch('d_lost'), [{ field: '*', reason: 'event_missing' }])
    assert.equal(byDispatch('d_recent').length, 0)
    assert.equal(report.events_pending, 1)
    assert.deepEqual(
      byDispatch('d_ledger').map((diff) => diff.field),
      ['ledger.input_tokens', 'ledger.total_cost'],
    )
    assert.equal(byDispatch('d_seen').length, 0)
    assert.ok(report.differing.some((item) => item.event_id === 'evt_r_3' && item.diffs[0].reason === 'invalid_event'))
    assert.equal(report.problems, 1)
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// 终审复核 N1：没有使用记录的分发（账号测试对话）与已回退到 VM 的请求，补写跳过后不报尝试差异
test('replay diff does not compare attempts for non-client dispatches or VM fallbacks', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-diff-n1-'))
  const db = createDatabase({ dataDir: dir })
  try {
    const repo = new GatewayWorkerRepo(db)
    await repo.upsertInstance({ id: 'gw-1', name: 'gw', base_url: 'http://127.0.0.1:1', health_state: 'healthy' })
    const at = new Date().toISOString()
    const chat = receipt('d_chat', { request_id: 'kin-test-1', attempts: [{ account: 'a' }] })
    const vm = receipt('d_vm', { request_id: 'req_vm', attempts: [{ account: 'a' }, { account: 'b' }] })
    await repo.ingestReceipt(chat)
    await repo.ingestReceipt(vm)
    db.prepare("INSERT INTO usage_logs(request_id,created_at,model,status) VALUES('req_vm',?,'gpt-5.5',200)").run(at)
    db.prepare(
      "INSERT INTO request_attempts(request_id,attempt_no,selection_reason,started_at) VALUES('req_vm',1,'sticky',?)",
    ).run(at)
    const insert = db.prepare(
      `INSERT INTO executor_event_inbox(event_id,instance_id,stream_id,seq,type,occurred_at,payload_json,mode,status,received_at,attempts_state)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    )
    insert.run(
      'evt_n1_1',
      'gw-1',
      's',
      1,
      'request.finalized',
      at,
      JSON.stringify(chat),
      'primary',
      'applied',
      at,
      'not_client',
    )
    insert.run(
      'evt_n1_2',
      'gw-1',
      's',
      2,
      'request.finalized',
      at,
      JSON.stringify(vm),
      'primary',
      'applied',
      at,
      'not_client',
    )
    const report = diffDatabase(db)
    assert.deepEqual(report.differing, [])
    assert.equal(report.attempts_not_client, 2)
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// 终审复核 A-N2：窗口终点取控制面最后一次成功拉取；仍在拉取但事件写不进日志时报缺事件，切回 off 后不报；结算差异
test('replay diff ends the consumption window at the last pull and reports settlement gaps', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-diff-window-'))
  const db = createDatabase({ dataDir: dir })
  try {
    const repo = new GatewayWorkerRepo(db)
    for (const id of ['gw-1', 'gw-2'])
      await repo.upsertInstance({ id, name: id, base_url: 'http://127.0.0.1:1', health_state: 'healthy' })
    const now = Date.now()
    const ago = (minutes) => new Date(now - minutes * 60_000).toISOString()
    const insert = db.prepare(
      `INSERT INTO executor_event_inbox(event_id,instance_id,stream_id,seq,type,occurred_at,payload_json,mode,status,received_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
    )
    const cursor = db.prepare(
      'INSERT INTO executor_event_cursors(instance_id,stream_id,last_seq,updated_at) VALUES(?,?,?,?)',
    )
    // gw-1：3 小时前开始消费，之后事件日志一直写不进去，但控制面 5 秒前仍成功拉取
    insert.run('w1', 'gw-1', 's', 1, 'account.state', ago(180), '{"items":[]}', 'shadow', 'recorded', ago(180))
    cursor.run('gw-1', 's', 1, new Date(now - 5000).toISOString())
    // gw-2：3 小时前消费过，2 小时前切回 off（之后不再拉取）
    insert.run('w2', 'gw-2', 's', 1, 'account.state', ago(180), '{"items":[]}', 'shadow', 'recorded', ago(180))
    cursor.run('gw-2', 's', 1, ago(120))
    const lost = receipt('d_tail', { gateway_instance_id: 'gw-1' })
    const off = receipt('d_off', { gateway_instance_id: 'gw-2' })
    await repo.ingestReceipt(lost)
    await repo.ingestReceipt(off)
    db.prepare('UPDATE gateway_worker_receipts SET received_at=? WHERE dispatch_id IN (?,?)').run(
      ago(30),
      'd_tail',
      'd_off',
    )
    // 结算：一条进入死信，一条 2 小时前到达仍待结算
    const dead = receipt('d_dead', { gateway_instance_id: 'gw-2' })
    const pending = receipt('d_pending', { gateway_instance_id: 'gw-2' })
    await repo.ingestReceipt(dead)
    await repo.ingestReceipt(pending)
    db.prepare('UPDATE gateway_worker_receipts SET received_at=? WHERE dispatch_id IN (?,?)').run(
      ago(150),
      'd_dead',
      'd_pending',
    )
    db.prepare(
      "INSERT INTO usage_logs(request_id,created_at,model,status,execution_kind,dispatch_id,billing_status) VALUES('req_d_pending',?,'gpt-5.5',200,'gateway_worker','d_pending','settlement_pending')",
    ).run(ago(150))
    db.prepare(`UPDATE gateway_worker_reconciliation_jobs SET status='dead_letter' WHERE dispatch_id='d_dead'`).run()
    if (!db.prepare("SELECT 1 FROM gateway_worker_reconciliation_jobs WHERE dispatch_id='d_dead'").get())
      db.prepare(
        "INSERT INTO gateway_worker_reconciliation_jobs(id,gateway_instance_id,dispatch_id,request_id,status,created_at,updated_at) VALUES('job_dead','gw-2','d_dead','req_d_dead','dead_letter',?,?)",
      ).run(ago(150), ago(150))
    const report = diffDatabase(db, { now })
    const byDispatch = (id) => report.differing.find((item) => item.dispatch_id === id)?.diffs || []
    assert.deepEqual(byDispatch('d_tail'), [{ field: '*', reason: 'event_missing' }])
    assert.deepEqual(byDispatch('d_off'), [])
    assert.deepEqual(
      byDispatch('d_dead')
        .filter((diff) => diff.field === 'ledger.settlement')
        .map((diff) => diff.ledger),
      ['dead_letter'],
    )
    assert.deepEqual(
      byDispatch('d_pending')
        .filter((diff) => diff.field === 'ledger.settlement')
        .map((diff) => diff.ledger),
      ['settlement_pending'],
    )
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
