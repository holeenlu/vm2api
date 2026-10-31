import test from 'node:test'
import assert from 'node:assert/strict'
import { FailoverRunner } from '../../src/lib/pool/failover-runner.mjs'
import { compileAccountErrorProtection } from '../../src/lib/pool/account-error-protection.mjs'

const selected = {
  accountId: 'account-1',
  vmId: 'vm-01',
  provider: 'anthropic',
  state: { credential_generation: 3, status: 'ready' },
}

const failed = {
  ok: false,
  status: 401,
  committed: false,
  body: { error: { type: 'authentication_error', code: 'invalid_grant', message: 'token expired' } },
}

function protectionPolicy() {
  return compileAccountErrorProtection({
    enabled: true,
    threshold: 2,
    windowMs: 60_000,
    durationMs: 300_000,
    rules: [
      {
        id: 'auth',
        name: 'auth',
        conditions: [
          { field: 'provider', operator: 'equals', values: ['anthropic'] },
          { field: 'status', operator: 'equals', values: ['401'] },
        ],
      },
    ],
  })
}

test('account protection counts account failures and converts threshold hit to cooldown', () => {
  let stored = null
  let revision = 0
  const runtimeRepo = {
    getProtectionState() {
      return { state: stored, generation: revision }
    },
    compareAndSwapProtectionState(_accountId, { expectedGeneration, state }) {
      if (expectedGeneration !== revision) return null
      stored = state
      revision += 1
      return revision
    },
  }
  const runner = new FailoverRunner({ accountRuntimeRepo: runtimeRepo, accountErrorProtection: protectionPolicy() })
  const base = { scope: 'account', action: 'continue-and-cooldown', reason: 'oauth_revoked', cooldownUntil: null }

  const first = runner.accountProtection(selected, failed, base)
  assert.equal(first.reason, 'oauth_revoked')
  assert.equal(stored.count, 1)

  const second = runner.accountProtection(selected, failed, base)
  assert.equal(second.reason, 'account_error_protected')
  assert.equal(second.scope, 'account')
  assert.equal(second.action, 'continue-and-cooldown')
  assert.ok(second.cooldownUntil > Date.now())
  assert.equal(second.circuit, false)
  assert.deepEqual(second.detail.protection_rules, [{ id: 'auth', name: 'auth' }])
  assert.equal(stored.count, 0)
})

test('account protection never changes a committed or provider-circuit failure', () => {
  const runner = new FailoverRunner({
    accountErrorProtection: protectionPolicy(),
    accountRuntimeRepo: {
      getProtectionState() {
        throw new Error('should not read')
      },
    },
  })
  const provider = { scope: 'provider', action: 'continue', reason: 'provider_overloaded', circuit: true }
  assert.deepEqual(runner.accountProtection(selected, failed, provider), provider)
  assert.deepEqual(runner.accountProtection(selected, { ...failed, committed: true }, provider), provider)
})
