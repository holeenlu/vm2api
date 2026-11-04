import test from 'node:test'
import assert from 'node:assert/strict'
import {
  authorizeVendorAccountDraft,
  createVendorAccountDraft,
  finalizeVendorAccountDraft,
  getVendorAccountDraft,
  publicVendorAccountDraft,
  resetVendorAccountDrafts,
} from '../../src/lib/vendor/vendor-account-draft.mjs'

const identity = { user_id: 'user-1', vendor: { id: 'vendor-1' } }

test('vendor account drafts do not create a resource and are owner scoped', () => {
  resetVendorAccountDrafts()
  const draft = createVendorAccountDraft(identity, { platform: 'anthropic', authorization_kind: 'claude_oauth' })
  assert.equal(publicVendorAccountDraft(draft).state, 'awaiting_authorization')
  assert.equal(getVendorAccountDraft(identity, draft.id), draft)
  assert.equal(getVendorAccountDraft({ user_id: 'other', vendor: { id: 'vendor-1' } }, draft.id), null)
})

test('vendor draft changes to authorized and finalized only after credential verification', () => {
  resetVendorAccountDrafts()
  const draft = createVendorAccountDraft(identity, { platform: 'openai', authorization_kind: 'codex_oauth' })
  assert.equal(draft.credential, null)
  authorizeVendorAccountDraft(identity, draft.id, { access_token: 'at', refresh_token: 'rt' })
  assert.equal(draft.state, 'authorized')
  assert.equal(draft.credential.access_token, 'at')
  finalizeVendorAccountDraft(identity, draft.id, { provisioning: { state: 'normal' } })
  assert.equal(publicVendorAccountDraft(draft).state, 'finalized')
  assert.deepEqual(publicVendorAccountDraft(draft).result, { provisioning: { state: 'normal' } })
})
