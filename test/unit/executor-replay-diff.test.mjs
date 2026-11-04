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

test('replay diff reports billing-field differences between events and receipts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-diff-'))
  const db = createDatabase({ dataDir: dir })
  try {
    const repo = new GatewayWorkerRepo(db)
    repo.upsertInstance({ id: 'gw-1', name: 'gw', base_url: 'http://127.0.0.1:1', health_state: 'healthy' })
    const same = receipt('d_same')
    repo.ingestReceipt(same)
    repo.ingestReceipt(receipt('d_usage'))
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
    db.prepare("INSERT INTO request_attempts(request_id,attempt_no,started_at) VALUES('req_attempts',1,?)").run(at)
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
