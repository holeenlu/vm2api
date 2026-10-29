import test from 'node:test'
import assert from 'node:assert/strict'
import {
  compileAccountErrorProtection,
  clearProtectionState,
  errorFactsFromResult,
  normalizeProtectionState,
  recordProtectionFailure,
  recordProtectionSuccess,
  validateAccountErrorProtection,
} from '../../src/lib/pool/account-error-protection.mjs'

const baseRule = {
  id: 'auth-expired',
  name: '凭据失效',
  conditions: [
    { field: 'provider', operator: 'equals', values: ['anthropic'] },
    { field: 'status', operator: 'equals', values: ['401'] },
  ],
}

function policy(overrides = {}) {
  return {
    enabled: true,
    threshold: 2,
    windowMs: 60_000,
    durationMs: 300_000,
    probeEnabled: true,
    rules: [baseRule],
    ...overrides,
  }
}

test('account error policy validates safe rule boundaries', () => {
  assert.equal(validateAccountErrorProtection({ enabled: false }).ok, true)
  assert.equal(validateAccountErrorProtection({ enabled: true }).code, 'rules_required')
  assert.equal(
    validateAccountErrorProtection({
      ...policy(),
      rules: [{ ...baseRule, conditions: [{ field: 'provider', operator: 'equals', values: ['anthropic'] }] }],
    }).code,
    'provider_only_rule',
  )
  assert.equal(
    validateAccountErrorProtection({
      ...policy(),
      rules: [{ ...baseRule, conditions: [{ field: 'status', operator: 'contains', values: ['401'] }] }],
    }).code,
    'contains_only_message',
  )
  assert.equal(
    validateAccountErrorProtection({
      ...policy(),
      rules: [{ ...baseRule, conditions: [{ field: 'status', operator: 'equals', values: ['099'] }] }],
    }).code,
    'invalid_status',
  )
  assert.equal(
    validateAccountErrorProtection({
      ...policy(),
      rules: [{ ...baseRule, id: 'bad\nrule' }],
    }).code,
    'invalid_rule_id',
  )
})

test('compiled matching supports equality, case folding, message contains, and multiple rules', () => {
  const compiled = compileAccountErrorProtection(
    policy({
      rules: [
        baseRule,
        {
          id: 'invalid-token',
          name: 'token 文案',
          conditions: [
            { field: 'provider', operator: 'equals', values: ['anthropic'], ignoreCase: true },
            { field: 'message', operator: 'contains', values: ['invalid token'], ignoreCase: true },
          ],
        },
      ],
    }),
  )
  const matched = compiled.matchingRules({
    provider: 'Anthropic',
    status: '401',
    message: 'The INVALID TOKEN was rejected',
  })
  assert.deepEqual(matched, [{ id: 'invalid-token', name: 'token 文案' }])

  const both = compileAccountErrorProtection(
    policy({
      rules: [
        baseRule,
        {
          id: 'same-status',
          name: '同状态',
          conditions: [
            { field: 'provider', operator: 'equals', values: ['anthropic'] },
            { field: 'status', operator: 'equals', values: ['401'] },
          ],
        },
      ],
    }),
  )
  assert.deepEqual(both.matchingRules({ provider: 'anthropic', status: '401' }), [
    { id: 'auth-expired', name: '凭据失效' },
    { id: 'same-status', name: '同状态' },
  ])
  assert.notEqual(compiled.fingerprint, both.fingerprint)
})

test('facts extraction keeps structured fields and bounded message source', () => {
  assert.deepEqual(
    errorFactsFromResult(
      { status: 401, body: { error: { code: 'invalid_grant', type: 'auth', message: 'expired' } } },
      { provider: 'anthropic' },
    ),
    { provider: 'anthropic', status: '401', code: 'invalid_grant', type: 'auth', message: 'expired' },
  )
  assert.deepEqual(errorFactsFromResult({ status: 429, body: 'quota exceeded' }), {
    provider: null,
    status: '429',
    code: null,
    type: null,
    message: 'quota exceeded',
  })
})

test('failure windows, threshold, freeze, success, and revision changes are deterministic', () => {
  const compiled = compileAccountErrorProtection(policy())
  const facts = { provider: 'anthropic', status: '401' }
  const start = 1_000_000

  let outcome = recordProtectionFailure(compiled, null, facts, { now: start, credentialGeneration: 7 })
  assert.equal(outcome.matched, true)
  assert.equal(outcome.frozen, false)
  assert.equal(outcome.state.count, 1)

  outcome = recordProtectionFailure(compiled, outcome.state, facts, { now: start + 10, credentialGeneration: 7 })
  assert.equal(outcome.frozen, true)
  assert.equal(outcome.state.count, 0)
  assert.equal(outcome.state.frozenUntil, start + 10 + 300_000)
  const frozenUntil = outcome.state.frozenUntil

  const repeated = recordProtectionFailure(compiled, outcome.state, facts, {
    now: start + 100,
    credentialGeneration: 7,
  })
  assert.equal(repeated.frozen, true)
  assert.equal(repeated.state.count, 0)
  assert.equal(repeated.state.frozenUntil, frozenUntil)
  assert.deepEqual(recordProtectionSuccess(outcome.state, { now: start + 200 }), outcome.state)

  const newPolicy = compileAccountErrorProtection(policy({ threshold: 3 }))
  const afterPolicyChange = recordProtectionFailure(newPolicy, outcome.state, facts, {
    now: start + 300,
    credentialGeneration: 7,
  })
  assert.equal(afterPolicyChange.frozen, false)
  assert.equal(afterPolicyChange.state.count, 1)
  assert.equal(afterPolicyChange.state.frozenUntil, 0)

  const afterCredentialChange = recordProtectionFailure(compiled, outcome.state, facts, {
    now: start + 400,
    credentialGeneration: 8,
  })
  assert.equal(afterCredentialChange.frozen, false)
  assert.equal(afterCredentialChange.state.count, 1)
  assert.equal(afterCredentialChange.state.frozenUntil, 0)

  const expired = recordProtectionSuccess(outcome.state, { now: frozenUntil })
  assert.equal(expired.count, 0)
  assert.equal(expired.frozenUntil, 0)
  assert.deepEqual(expired.matchedRules, [])

  const wrapped = normalizeProtectionState({ generation: 4, count: 2, frozen_until: 1_234 })
  assert.equal(clearProtectionState(wrapped, { expectedGeneration: 99 }), null)
  const cleared = clearProtectionState(wrapped, { expectedGeneration: 4 })
  assert.equal(cleared.count, 0)
  assert.equal(cleared.frozenUntil, 0)
  assert.equal(cleared.generation, 5)
})

test('window expiration starts a new counter', () => {
  const compiled = compileAccountErrorProtection(policy())
  const facts = { provider: 'anthropic', status: '401' }
  const first = recordProtectionFailure(compiled, null, facts, { now: 10_000, credentialGeneration: 1 })
  const next = recordProtectionFailure(compiled, first.state, facts, {
    now: 10_000 + 60_001,
    credentialGeneration: 1,
  })
  assert.equal(next.frozen, false)
  assert.equal(next.state.count, 1)
  assert.equal(next.state.windowStartedAt, 70_001)
})
