import test from 'node:test'
import assert from 'node:assert/strict'
import { credentialFactsFromOauth, credentialFactsOfVm } from '../../src/lib/oauth/credential-facts.mjs'

test('credential facts keep profile and refresh policy together', () => {
  const facts = credentialFactsOfVm({ claude: { has_access: true, has_refresh: true, scope: 'user:profile' } })
  assert.equal(facts.access, true)
  assert.equal(facts.refresh, true)
  assert.equal(facts.profileAllowed, true)
  assert.equal(facts.refreshAllowed, true)
})

test('credential facts classify inference-only OAuth grants', () => {
  const facts = credentialFactsFromOauth({ access_token: 'sk-ant-oat01-test', scope: 'user:inference' })
  assert.equal(facts.inferenceOnly, true)
  assert.equal(facts.profileAllowed, false)
  assert.equal(facts.refreshAllowed, false)
})
