import assert from 'node:assert/strict'
import test from 'node:test'
import { defaultRedaction, normalizeRedaction } from '../../src/lib/redaction/policy.mjs'

test('redaction policy treats a missing block as off without inventing protection', () => {
  assert.deepEqual(normalizeRedaction(undefined), defaultRedaction())
})

test('redaction policy rejects coerced booleans and unknown fields', () => {
  assert.throws(() => normalizeRedaction({ enabled: 'false', secrets: true, personal: true }), /enabled/)
  assert.throws(() => normalizeRedaction({ enabled: false, secrets: true, personal: true, shape: true }), /unknown/)
})

test('redaction policy rejects an enabled policy with nothing to protect', () => {
  assert.throws(
    () => normalizeRedaction({ enabled: true, secrets: false, personal: false, words: ['  '], rules: [] }),
    /requires/,
  )
})

test('redaction policy keeps words when the switch is off and drops blanks', () => {
  assert.deepEqual(
    normalizeRedaction({
      enabled: false,
      secrets: true,
      personal: false,
      words: [' 夜莺 ', '夜莺', ''],
      rules: [],
    }),
    {
      enabled: false,
      secrets: true,
      personal: false,
      words: ['夜莺'],
      wordsAnyCase: false,
      rules: [],
      kinds: {},
      allow: [],
    },
  )
})

test('redaction policy keeps kind overrides, case folding, and the allow list', () => {
  const policy = normalizeRedaction({
    enabled: true,
    secrets: true,
    personal: true,
    words: ['Nightjar'],
    wordsAnyCase: true,
    rules: [{ kind: 'GATEWAY_KEY', prefix: 'oc_sk_' }],
    kinds: { ip: true, home: false },
    allow: [' build-01 '],
  })
  assert.equal(policy.wordsAnyCase, true)
  assert.deepEqual(policy.kinds, { ip: true, home: false })
  assert.deepEqual(policy.allow, ['build-01'])
  assert.deepEqual(policy.rules, [{ kind: 'GATEWAY_KEY', prefix: 'oc_sk_', regex: '' }])
})
