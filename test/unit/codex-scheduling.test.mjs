import test from 'node:test'
import assert from 'node:assert/strict'
import { createDatabase, applyMigrations } from '../../src/lib/db/database.mjs'
import { CodexResponseOwnersRepo, codexClientScope } from '../../src/lib/db/repos/codex-response-owners-repo.mjs'
import { AccountRuntimeRepo } from '../../src/lib/db/repos/account-runtime-repo.mjs'
import { SettingsRepo } from '../../src/lib/db/repos/settings-repo.mjs'
import { CodexAccountProtection } from '../../src/lib/pool/codex-account-protection.mjs'
import { canReplayCodex, codexFeedbackKind } from '../../src/lib/pool/codex-replay.mjs'
import { codexAccountCandidate, orderCodexSessionSlots } from '../../src/lib/pool/codex-slot-pool.mjs'
import { normalizeCodexScheduling, CODEX_SMART_WEIGHTS } from '../../src/lib/pool/codex-scheduling-policy.mjs'
import { selectOpenAIAccount } from '../../src/lib/pool/openai-account-selector.mjs'
import * as rt from '../../src/lib/pool/openai-account-runtime.mjs'

const vm = (id, patch = {}) => ({ id, platform: 'openai', has_token: true, status: 'running', ...patch })

test('missing, null and expired quota stay unknown; observed zero is full', () => {
  const now = Date.now()
  for (const patch of [
    {},
    { utilization_5h: null, utilization_7d: null },
    { utilization_5h: 0.9, reset_5h: new Date(now - 1).toISOString() },
  ]) {
    assert.equal(codexAccountCandidate(vm('a', patch), now).quotaRemainingRank, null)
  }
  assert.equal(codexAccountCandidate(vm('a', { utilization_5h: 0 })).quotaRemainingRank, 10000)
  assert.equal(codexAccountCandidate(vm('a', { utilization_5h: 0.1, utilization_7d: 0.9 })).quotaRemainingRank, 1000)
})

test('ambiguous, unproven sent and external effects block replay; explicit rejection does not', () => {
  assert.equal(canReplayCodex({ status: 503, sendState: 'ambiguous', replaySafe: true }), false)
  assert.equal(canReplayCodex({ status: 500, sendState: 'sent' }), false)
  assert.equal(canReplayCodex({ status: 0, sendState: 'not_sent' }), true)
  assert.equal(canReplayCodex({ status: 429, sendState: 'sent' }), true)
  assert.equal(canReplayCodex({ status: 429, sendState: 'sent', executionEffectObserved: true }), false)
  assert.equal(codexFeedbackKind({ status: 0, sendState: 'ambiguous', transportError: true }), null)
  assert.equal(codexFeedbackKind({ status: 400, sendState: 'sent' }), null)
  assert.equal(codexFeedbackKind({ status: 429, sendState: 'sent' }), 'capacity_rejected')
})

test('queued grant fences newcomers and cancellation returns it', async () => {
  rt.resetOpenAIAccountRuntime()
  const holder = rt.tryAcquireOpenAISlot('a')
  const ac = new AbortController()
  const waiting = rt.waitForOpenAICapacity({ accounts: ['a'], deadline: Date.now() + 1000, signal: ac.signal })
  holder.release()
  assert.equal(rt.tryAcquireOpenAISlot('a'), null)
  const turn = await waiting
  const claim = rt.tryAcquireOpenAISlot('a', { ticket: turn.ticket })
  assert.ok(claim)
  claim.release()
  const holder2 = rt.tryAcquireOpenAISlot('a')
  const waiting2 = rt.waitForOpenAICapacity({ accounts: ['a'], deadline: Date.now() + 1000, signal: ac.signal })
  holder2.release()
  await waiting2
  ac.abort()
  assert.ok(rt.tryAcquireOpenAISlot('a'))
  rt.resetOpenAIAccountRuntime()
})

test('scheduling modes keep continuity owner separate from policy; weights validate and scale', () => {
  rt.resetOpenAIAccountRuntime()
  const holder = rt.tryAcquireOpenAISlot('a', { concurrency: 2 })
  const holder2 = rt.tryAcquireOpenAISlot('a', { concurrency: 2 })
  const list = [vm('a'), vm('b')]
  assert.equal(orderCodexSessionSlots(list, { boundVmId: 'a', affinity: 'strict' }).error, 'capacity_unavailable')
  assert.deepEqual(orderCodexSessionSlots(list, { boundVmId: 'a', affinity: 'preferred' }).ids, ['b'])
  holder.release()
  holder2.release()
  const candidates = [
    { id: 'a', concurrency: 2, status: 'normal', quotaRemainingRank: 5000 },
    { id: 'b', concurrency: 2, status: 'normal', quotaRemainingRank: 5050 },
  ]
  const doubled = Object.fromEntries(Object.entries(CODEX_SMART_WEIGHTS).map(([k, v]) => [k, v * 2]))
  assert.equal(
    selectOpenAIAccount(candidates, { roundRobinCursor: 1 }).candidate.id,
    selectOpenAIAccount(candidates, { roundRobinCursor: 1, smartWeights: doubled }).candidate.id,
  )
  assert.throws(() => normalizeCodexScheduling({ smart_weights: { quota: NaN } }, { strict: true }))
  assert.throws(() => normalizeCodexScheduling({ affinity: 'anything' }, { strict: true }))
  rt.resetOpenAIAccountRuntime()
})

test('response ownership is client scoped, immutable, expiring and migration-idempotent', () => {
  const db = createDatabase({ dbPath: ':memory:' })
  try {
    const repo = new CodexResponseOwnersRepo(db)
    const a = codexClientScope({ apiKeyRecord: { id: 'key-a', user_id: 'u' } })
    const b = codexClientScope({ apiKeyRecord: { id: 'key-b', user_id: 'u' } })
    assert.ok(repo.remember(a, 'resp_private', { vmId: 'vm-a', identity: 'identity', sessionId: 's' }, 1000))
    assert.equal(repo.resolve(b, 'resp_private', 1001), null)
    assert.equal(repo.remember(a, 'resp_private', { vmId: 'vm-b', identity: 'identity' }, 1001), false)
    assert.equal(repo.resolve(a, 'resp_private', 1001).vm_id, 'vm-a')
    assert.equal(repo.resolve(a, 'resp_private', 1000 + 24 * 3600_000), null)
    assert.deepEqual(applyMigrations(db), [])
    assert.equal(
      JSON.stringify(db.prepare('SELECT * FROM codex_response_owners').all()).includes('resp_private'),
      false,
    )
  } finally {
    db.close()
  }
})

test('GPT protection persists, ignores late recovery, and changes epoch on credentials and policy', () => {
  const db = createDatabase({ dbPath: ':memory:' })
  try {
    const settings = new SettingsRepo(db)
    settings.set('account_error_protection', {
      enabled: true,
      threshold: 2,
      windowMs: 60000,
      durationMs: 300000,
      rules: [
        {
          id: 'auth',
          name: 'auth',
          conditions: [
            { field: 'provider', operator: 'equals', values: ['openai'] },
            { field: 'status', operator: 'equals', values: ['401'] },
          ],
        },
      ],
    })
    const service = new CodexAccountProtection(db)
    const failure = { ok: false, status: 401, sendState: 'sent' }
    service.observe('a', failure, service.capture('a', 7))
    const stale = service.capture('a', 7)
    service.observe('a', failure, stale)
    assert.ok(service.until('a', 7) > Date.now())
    service.observe('a', { ok: true, status: 200, sendState: 'sent' }, stale)
    assert.ok(service.until('a', 7) > Date.now())
    const repo = new AccountRuntimeRepo(db)
    const row = repo.getProtectionState('a')
    repo.clearProtectionState('a', {
      expectedGeneration: row.generation,
      state: { ...row.state, generation: row.state.generation + 1, frozenUntil: 0 },
    })
    service.observe('a', failure, stale)
    assert.equal(service.until('a', 7), 0)
    const newer = service.capture('a', 8)
    service.observe('a', failure, newer)
    assert.equal(repo.getProtectionState('a').state.count, 1)
  } finally {
    db.close()
  }
})

test('071 upgrades an existing database without changing history or usage', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-owner-upgrade-'))
  const old = path.join(root, 'migrations')
  fs.mkdirSync(old)
  const source = path.resolve('src/lib/db/migrations')
  for (const name of fs.readdirSync(source))
    if (name < '071') fs.copyFileSync(path.join(source, name), path.join(old, name))
  const file = path.join(root, 'db.sqlite')
  let db = createDatabase({ dbPath: file, migrationsDir: old })
  db.exec("INSERT INTO usage_logs(id,request_id,created_at) VALUES('old','old','2026-10-01')")
  const history = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all()
  db.close()
  try {
    db = createDatabase({ dbPath: file })
    assert.deepEqual(
      db.prepare("SELECT * FROM schema_migrations WHERE version < '071' ORDER BY version").all(),
      history,
    )
    assert.equal(db.prepare("SELECT request_id FROM usage_logs WHERE id='old'").get().request_id, 'old')
    assert.equal(db.prepare('SELECT count(*) AS count FROM codex_response_owners').get().count, 0)
    assert.deepEqual(applyMigrations(db), [])
  } finally {
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('queue pressure chooses a less occupied queue and retries spend RPM', async () => {
  rt.resetOpenAIAccountRuntime()
  const heldA = rt.tryAcquireOpenAISlot('a')
  const heldB = rt.tryAcquireOpenAISlot('b')
  const first = rt.waitForOpenAICapacity({ accounts: ['a'], deadline: Date.now() + 1000 })
  const pressure = rt.waitForOpenAICapacity({
    accounts: ['a', 'b'],
    deadline: Date.now() + 1000,
    scores: { a: 1, b: 1 },
    queueWeight: 1,
  })
  heldB.release()
  const turn = await pressure
  assert.equal(turn.accountId, 'b')
  const granted = rt.tryAcquireOpenAISlot('b', { ticket: turn.ticket, maxRpm: 2 })
  assert.ok(granted)
  assert.equal(rt.tryConsumeOpenAIRpm('b', 2), false)
  granted.release()
  heldA.release()
  const old = await first
  old.ticket.releaseTurn()
  rt.resetOpenAIAccountRuntime()
})
