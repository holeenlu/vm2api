import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { RequestAttemptsRepo } from '../../src/lib/db/repos/request-attempts-repo.mjs'
import { armWriteBehind, flushWrites, pendingWrites } from '../../src/lib/db/write-behind.mjs'
import { recordGatewayAttempts } from '../../src/lib/gateway-worker/gateway-execution.mjs'
import { applyFinalizedAttempts, attemptsFromFinalized } from '../../src/lib/executor/result-writer.mjs'

const finalized = {
  request_id: 'req_1',
  runtime_account_id: 'acct_b',
  send_state: 'sent',
  terminal_state: 'completed',
  upstream_status: 200,
  upstream_model: 'gpt-5.5',
  usage: { input_tokens: 9, output_tokens: 4 },
  attempts: [
    {
      account: 'acct_a',
      status: 429,
      category: 'rate_limited',
      send_state: 'sent',
      route: 'bps',
      stage: 'attachments',
      credential_revision: 3,
      duration_ms: 120,
      upstream_request_id: 'up_1',
      message: '  Too many attachment uploads  ',
    },
    { account: 'acct_b', status: 200, send_state: 'sent', credential_revision: 7, duration_ms: 900, cf_ray: 'ray_2' },
  ],
}

async function withDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'result-writer-'))
  const db = createDatabase({ dataDir: dir })
  try {
    await fn(db, new RequestAttemptsRepo(db))
  } finally {
    armWriteBehind(null)
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const shape = (rows) =>
  rows.map((row) => [
    row.attempt_no,
    row.account_id,
    row.route,
    row.stage,
    row.terminal_state,
    row.downstream_committed,
    row.credential_revision,
  ])

test('finalized attempts map Worker facts onto request_attempts', () => {
  const [first, last] = attemptsFromFinalized(finalized)
  assert.equal(first.terminalState, 'upstream_error')
  assert.equal(first.action, 'rate_limited')
  assert.equal(first.route, 'bps')
  assert.equal(first.stage, 'attachments')
  assert.equal(last.terminalState, 'verified')
  assert.equal(last.errorMessage, null)
  // Worker 的 sent 指已发往上游，不能证明已交付调用方
  assert.equal(last.downstreamCommitted, false)
  assert.deepEqual(last.usage, { input_tokens: 9, output_tokens: 4 })
  assert.equal(last.route, 'native')
  assert.equal(last.credentialRevision, 7)
  assert.equal(attemptsFromFinalized({ ...finalized, terminal_state: 'incomplete' }).at(-1).terminalState, 'incomplete')
  assert.deepEqual(attemptsFromFinalized({}), [])
})

test('missing real-time attempts are inserted; existing ones only gain Worker fields', () =>
  withDb(async (db, repo) => {
    db.prepare(
      "INSERT INTO usage_logs(request_id,created_at,model,status,execution_kind) VALUES('req_1',datetime('now'),'gpt-5.5',200,'gateway_worker')",
    ).run()
    assert.deepEqual(await applyFinalizedAttempts(db, repo, finalized), { inserted: 2, annotated: 0, replaced: 0 })
    assert.deepEqual(shape(repo.list('req_1')), [
      [1, 'acct_a', 'bps', 'attachments', 'upstream_error', false, 3],
      [2, 'acct_b', 'native', null, 'verified', false, 7],
    ])
    // 上游错误原文去首尾空白入库（迁移 117）
    assert.deepEqual(
      repo.list('req_1').map((row) => row.error_message),
      ['Too many attachment uploads', null],
    )
    // 重复事件：字段已齐全，不写
    assert.deepEqual(await applyFinalizedAttempts(db, repo, finalized), { inserted: 0, annotated: 0, replaced: 0 })
    assert.equal(repo.list('req_1').length, 2)
    // 实时记录已存在（控制面视角：调用方中途断开）：保留终态与交付事实，只补 Worker 侧字段
    repo.record({
      requestId: 'req_2',
      attemptNo: 1,
      accountId: 'acct_a',
      selectionReason: 'gateway_worker',
      route: 'bps',
      terminalState: 'cancelled',
      downstreamCommitted: true,
    })
    const second = { ...finalized, request_id: 'req_2', attempts: [finalized.attempts[0]] }
    assert.deepEqual(await applyFinalizedAttempts(db, repo, second), { inserted: 0, annotated: 1, replaced: 0 })
    const [kept] = repo.list('req_2')
    assert.deepEqual(
      [
        kept.terminal_state,
        kept.downstream_committed,
        kept.route,
        kept.credential_revision,
        kept.latency_ms,
        kept.error_message,
      ],
      ['cancelled', true, 'bps', 3, 120, 'Too many attachment uploads'],
    )
    assert.deepEqual(await applyFinalizedAttempts(db, repo, { attempts: finalized.attempts }), {
      inserted: 0,
      annotated: 0,
      replaced: 0,
    })
  }))

test('a real-time placeholder row (no Worker attempts header) is replaced by the event attempts', () =>
  withDb(async (db, repo) => {
    // 请求已发出但连接中断：控制面只写一行观察（route 为空），交付给调用方的是 503
    recordGatewayAttempts(repo, {
      requestId: 'req_1',
      model: 'gpt-5.5',
      result: { status: 503, headers: {} },
      accountId: null,
      final: { terminalState: 'upstream_error', downstreamCommitted: false, errorCode: 'gateway_stream_error' },
    })
    assert.equal(repo.list('req_1')[0].selection_reason, 'gateway_worker_observed')
    assert.deepEqual(await applyFinalizedAttempts(db, repo, finalized), { inserted: 2, annotated: 0, replaced: 1 })
    const rows = repo.list('req_1')
    assert.deepEqual(shape(rows), [
      [1, 'acct_a', 'bps', 'attachments', 'upstream_error', false, 3],
      [2, 'acct_b', 'native', null, 'upstream_error', false, 7],
    ])
    assert.equal(rows[1].action, 'gateway_stream_error', 'the control-plane outcome is kept on the last attempt')
  }))

test('a legacy single row with no route (written before migration 101) is annotated, not replaced', () =>
  withDb(async (db, repo) => {
    repo.record({
      requestId: 'req_1',
      attemptNo: 1,
      accountId: 'acct_b',
      selectionReason: 'gateway_worker',
      upstreamStatus: 200,
      terminalState: 'verified',
      downstreamCommitted: true,
    })
    const result = await applyFinalizedAttempts(db, repo, { ...finalized, attempts: [finalized.attempts[1]] })
    assert.equal(result.replaced, 0)
    const rows = repo.list('req_1')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].downstream_committed, true)
    assert.equal(rows[0].latency_ms, 900)
  }))

test('real-time rows still queued in write-behind are flushed before completion (no duplicates)', () =>
  withDb(async (db, repo) => {
    armWriteBehind(db)
    recordGatewayAttempts(repo, {
      requestId: 'req_1',
      model: 'gpt-5.5',
      result: { status: 200, headers: { 'x-kin-gateway-attempts': JSON.stringify(finalized.attempts) } },
      accountId: 'acct_b',
      final: { terminalState: 'verified', downstreamCommitted: true },
      settingsRevision: 3,
    })
    assert.ok(pendingWrites() > 0, 'the real-time write is still queued')
    flushWrites()
    // 实时行没有耗时：只补耗时，不插入重复行
    assert.deepEqual(await applyFinalizedAttempts(db, repo, finalized), { inserted: 0, annotated: 2, replaced: 0 })
    const rows = repo.list('req_1')
    assert.equal(rows.length, 2)
    assert.deepEqual(
      rows.map((row) => row.latency_ms),
      [120, 900],
    )
    assert.equal(rows[1].downstream_committed, true)
    assert.equal(rows[1].credential_revision, 7, 'real-time writes take the credential revision from the header')
    assert.equal(rows[1].settings_revision, 3, 'real-time writes record the settings revision the request ran under')
  }))

// 终审 A7：没有使用记录的分发（账号测试对话等）不生成尝试行；回退到 VM 的请求不把 Worker 尝试写到 VM 尝试上
test('event attempts only complete client requests and never touch VM attempt rows', () =>
  withDb(async (db, repo) => {
    assert.deepEqual(await applyFinalizedAttempts(db, repo, finalized), {
      inserted: 0,
      annotated: 0,
      replaced: 0,
      skipped: 'not_client',
    })
    assert.equal(repo.list('req_1').length, 0)
    repo.record({
      requestId: 'req_vm',
      attemptNo: 1,
      accountId: 'vm-slot',
      selectionReason: 'sticky',
      terminalState: 'verified',
    })
    db.prepare(
      "INSERT INTO usage_logs(request_id,created_at,model,status) VALUES('req_vm',datetime('now'),'gpt-5.5',200)",
    ).run()
    assert.deepEqual(await applyFinalizedAttempts(db, repo, { ...finalized, request_id: 'req_vm' }), {
      inserted: 0,
      annotated: 0,
      replaced: 0,
      skipped: 'vm_attempts',
    })
    const [row] = repo.list('req_vm')
    assert.equal(row.route, null)
    assert.equal(repo.list('req_vm').length, 1)
  }))
