import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { AccountRuntimeRepo } from '../../src/lib/db/repos/account-runtime-repo.mjs'
import { RequestAttemptsRepo } from '../../src/lib/db/repos/request-attempts-repo.mjs'

test('account runtime state persists account and model cooldowns', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-runtime-repo-'))
  const db = createDatabase({ dataDir: dir })
  try {
    const repo = new AccountRuntimeRepo(db)
    repo.upsert({
      account_id: 'account-1',
      vm_id: 'vm-01',
      status: 'ready',
      priority: 3,
      weight: 5,
      worker_heartbeat_at: Date.now(),
      worker_status: { ok: true },
    })
    const until = Date.now() + 60_000
    repo.markCooldown('account-1', {
      vmId: 'vm-01',
      model: 'claude-test',
      until,
      reason: 'model_rate_limit',
    })
    const state = repo.get('account-1')
    assert.equal(state.priority, 3)
    assert.equal(state.weight, 5)
    assert.equal(state.model_states['claude-test'].reason, 'model_rate_limit')
    assert.equal(state.model_states['claude-test'].cooldown_until, until)
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('account cooldown mirrors structured rate-limit columns (sub2api style)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-runtime-repo-'))
  const db = createDatabase({ dataDir: dir })
  try {
    const repo = new AccountRuntimeRepo(db)
    const until = Date.now() + 300_000
    repo.markCooldown('account-rl', {
      vmId: 'vm-01',
      until,
      reason: 'account_quota_exhausted',
    })
    let state = repo.get('account-rl')
    assert.equal(state.rate_limit_reset_at, until)
    assert.ok(state.rate_limited_at <= Date.now())
    assert.equal(state.overload_until, null)

    repo.markCooldown('account-rl', { vmId: 'vm-01', until: until + 1000, reason: 'provider_overloaded' })
    state = repo.get('account-rl')
    assert.equal(state.overload_until, null)
    assert.equal(state.cooldown_until, until + 1000)
    assert.equal(state.cooldown_reason, 'provider_overloaded')
    assert.equal(state.rate_limit_reset_at, until)
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('updateWindow persists session window without touching cooldowns', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-runtime-repo-'))
  const db = createDatabase({ dataDir: dir })
  try {
    const repo = new AccountRuntimeRepo(db)
    const end = Date.now() + 3600_000
    repo.updateWindow('account-w', {
      vmId: 'vm-02',
      sessionWindowStart: end - 5 * 3600_000,
      sessionWindowEnd: end,
      sessionWindowStatus: 'allowed_warning',
    })
    const state = repo.get('account-w')
    assert.equal(state.session_window_end, end)
    assert.equal(state.session_window_start, end - 5 * 3600_000)
    assert.equal(state.session_window_status, 'allowed_warning')
    assert.equal(state.cooldown_until, null)
    // partial update keeps prior fields
    repo.updateWindow('account-w', { sessionWindowStatus: 'rejected' })
    assert.equal(repo.get('account-w').session_window_end, end)
    assert.equal(repo.get('account-w').session_window_status, 'rejected')
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('account error protection state round trips through CAS revisions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-runtime-protection-'))
  const db = createDatabase({ dataDir: dir })
  try {
    const columns = new Set(
      db
        .prepare('PRAGMA table_info(account_runtime)')
        .all()
        .map((row) => row.name),
    )
    assert.equal(columns.has('protection_state_json'), true)
    assert.equal(columns.has('protection_generation'), true)

    const repo = new AccountRuntimeRepo(db)
    repo.upsert({ account_id: 'protected-1', vm_id: 'vm-protected', status: 'ready' })
    assert.deepEqual(repo.getProtectionState('protected-1'), { state: null, generation: 0 })

    const frozen = {
      policyFingerprint: 'policy-a',
      credentialGeneration: 2,
      windowStartedAt: 10,
      count: 12,
      frozenUntil: 20,
      matchedRules: [{ id: 'auth-expired', name: '凭据失效' }],
      generation: 1,
      probePending: true,
      lastProbeAt: 0,
    }
    assert.equal(repo.compareAndSwapProtectionState('protected-1', { expectedGeneration: 0, state: frozen }), 1)
    assert.deepEqual(repo.getProtectionState('protected-1'), { state: frozen, generation: 1 })
    assert.deepEqual(repo.get('protected-1').protection_state, frozen)
    assert.equal(repo.get('protected-1').protection_generation, 1)

    // A stale scheduler write must not revert a newer CAS state merely
    // because it also writes the shared runtime row.
    repo.upsert({
      ...repo.get('protected-1'),
      protection_state: { count: 1 },
      protection_generation: 0,
    })
    assert.deepEqual(repo.getProtectionState('protected-1'), { state: frozen, generation: 1 })

    assert.equal(repo.compareAndSwapProtectionState('protected-1', { expectedGeneration: 0, state: {} }), null)
    assert.deepEqual(repo.getProtectionState('protected-1'), { state: frozen, generation: 1 })

    const cleared = { ...frozen, count: 0, frozenUntil: 0, probePending: false, generation: 2 }
    assert.equal(repo.clearProtectionState('protected-1', { expectedGeneration: 1, state: cleared }), 2)
    assert.deepEqual(repo.getProtectionState('protected-1'), { state: cleared, generation: 2 })
    assert.equal(repo.clearProtectionState('protected-1', { expectedGeneration: 1 }), null)
    assert.deepEqual(repo.getProtectionState('protected-1'), { state: cleared, generation: 2 })

    assert.equal(repo.clearProtectionState('protected-1', { expectedGeneration: 2 }), 3)
    assert.deepEqual(repo.getProtectionState('protected-1'), { state: null, generation: 3 })
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('clearAuthCooldown drops 401 leftover and keeps quota cools', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-runtime-auth-'))
  const db = createDatabase({ dataDir: dir })
  try {
    const repo = new AccountRuntimeRepo(db)
    const until = Date.now() + 600_000
    repo.markCooldown('auth-1', {
      vmId: 'vm-11',
      until,
      reason: 'authentication_failed_after_refresh',
    })
    repo.markCooldown('quota-1', {
      vmId: 'vm-12',
      until,
      reason: 'account_quota_exhausted',
    })
    assert.equal(repo.clearAuthCooldown('auth-1', { vmId: 'vm-11' }), true)
    assert.equal(repo.get('auth-1').cooldown_reason, null)
    assert.equal(repo.get('auth-1').cooldown_until, null)
    assert.equal(repo.clearAuthCooldown('quota-1', { vmId: 'vm-12' }), false)
    assert.equal(repo.get('quota-1').cooldown_reason, 'account_quota_exhausted')
    repo.markCooldown('revoked-1', {
      vmId: 'vm-100',
      until: Number.MAX_SAFE_INTEGER,
      reason: 'oauth_revoked',
      status: 'disabled',
    })
    assert.equal(repo.clearAuthCooldown('revoked-1', { vmId: 'vm-100' }), false)
    assert.equal(repo.get('revoked-1').cooldown_reason, 'oauth_revoked')
    assert.equal(repo.clearGrantRevokeCooldown('revoked-1', { vmId: 'vm-100' }), true)
    assert.equal(repo.get('revoked-1').cooldown_reason, null)
    assert.equal(repo.get('revoked-1').status, 'ready')
    repo.markCooldown('setup-1', {
      vmId: 'vm-05',
      until: Number.MAX_SAFE_INTEGER,
      reason: 'oauth_no_refresh',
      status: 'disabled',
    })
    assert.equal(repo.clearGrantRevokeCooldown('setup-1', { vmId: 'vm-05' }), true)
    assert.equal(repo.get('setup-1').cooldown_reason, null)
    assert.equal(repo.get('setup-1').status, 'ready')
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('request attempt ledger records final state and commit boundary', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-attempt-repo-'))
  const db = createDatabase({ dataDir: dir })
  try {
    const repo = new RequestAttemptsRepo(db)
    repo.begin({
      requestId: 'req-1',
      attemptNo: 1,
      vmId: 'vm-01',
      accountId: 'account-1',
      model: 'claude-test',
      selectionReason: 'balanced',
      waitMs: 4,
    })
    repo.complete('req-1', 1, {
      upstreamStatus: 429,
      errorScope: 'account',
      action: 'continue-and-cooldown',
      cooldownUntil: Date.now() + 60_000,
      terminalState: 'rejected',
      latencyMs: 12,
    })
    repo.begin({
      requestId: 'req-1',
      attemptNo: 2,
      vmId: 'vm-02',
      accountId: 'account-2',
      model: 'claude-test',
      selectionReason: 'failover',
    })
    repo.complete('req-1', 2, {
      upstreamStatus: 200,
      downstreamCommitted: true,
      terminalState: 'verified',
      usage: { input_tokens: 2, output_tokens: 3 },
      ttftMs: 20,
      latencyMs: 40,
    })
    const attempts = repo.list('req-1')
    assert.equal(attempts.length, 2)
    assert.equal(attempts[0].action, 'continue-and-cooldown')
    assert.equal(attempts[1].terminal_state, 'verified')
    assert.equal(attempts[1].downstream_committed, true)
    assert.equal(attempts[1].send_state, 'sent')
    assert.deepEqual(attempts[1].usage, { input_tokens: 2, output_tokens: 3 })
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('request attempt send state is monotonic across duplicate completion writers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-attempt-send-state-'))
  const db = createDatabase({ dataDir: dir })
  try {
    const repo = new RequestAttemptsRepo(db)
    const started = repo.begin({ requestId: 'req-send-state', attemptNo: 1, vmId: 'vm-01' })
    assert.equal(started.send_state, 'not_sent')

    assert.equal(repo.complete('req-send-state', 1, { sendState: 'ambiguous' }).send_state, 'ambiguous')
    assert.equal(repo.complete('req-send-state', 1, { sendState: 'not_sent' }).send_state, 'ambiguous')
    const sent = repo.complete('req-send-state', 1, { sendState: 'not_sent', downstreamCommitted: true })
    assert.equal(sent.send_state, 'sent')
    assert.equal(sent.downstream_committed, true)

    const duplicate = repo.complete('req-send-state', 1, { sendState: 'ambiguous', downstreamCommitted: false })
    assert.equal(duplicate.send_state, 'sent')
    assert.equal(duplicate.downstream_committed, true)
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
