import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { refreshAccountProfile } from '../../src/lib/oauth/account-profile.mjs'
import { createImportCommit } from '../../src/lib/oauth/import-commit.mjs'

function fixture(t, patch = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'account-profile-'))
  fs.mkdirSync(path.join(root, 'vms'))
  const file = path.join(root, 'vms', 'vm-01.json')
  const vm = {
    id: 'vm-01',
    status: 'running',
    policy: { maxConcurrency: 2 },
    claude: {
      account_uuid: 'account-1',
      org_uuid: 'org-1',
      email: 'old@example.test',
      scope: 'user:inference user:profile',
      mode: 'setup-token',
      has_access: true,
      subscription_type: 'pro',
      billing_type: 'old-channel',
      _token_version: 10,
      ...patch,
    },
  }
  fs.writeFileSync(file, JSON.stringify(vm))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return { root, file, vm, read: () => JSON.parse(fs.readFileSync(file, 'utf8')) }
}
const profile = {
  account: { uuid: 'account-1', email_address: 'current@example.test', has_claude_max: true },
  organization: { uuid: 'org-1', rate_limit_tier: 'default_claude_max_20x', billing_type: 'apple_subscription' },
}

test('refresh uses the scoped slot worker and caches only observed account metadata', async (t) => {
  const f = fixture(t)
  const result = await refreshAccountProfile(f.root, 'vm-01', {
    slotOauth: async (exec, op) => {
      assert.equal(exec.vmId, 'vm-01')
      assert.equal(op, 'profile')
      return { ok: true, body: { ...profile, access_token: 'do-not-store', card: { last4: '9999' } } }
    },
  })
  assert.equal(result.ok, true)
  const saved = f.read()
  assert.equal(saved.claude.subscription_type, 'max')
  assert.equal(saved.claude.billing_type, 'apple_subscription')
  assert.equal(saved.claude.rate_limit_tier, 'default_claude_max_20x')
  assert.equal(saved.claude.email, 'current@example.test')
  assert.ok(saved.claude.subscription_updated_at)
  assert.deepEqual(saved.policy, f.vm.policy)
  assert.equal(saved.claude._token_version, 10)
  assert.doesNotMatch(JSON.stringify(saved), /do-not-store|9999/)
})

test('missing profile permission and inference-only credentials never query the provider', async (t) => {
  for (const patch of [
    { scope: 'user:inference' },
    { scope: '' },
    { mode: 'official-setup-token' },
    { mode: 'apikey' },
    { has_access: false },
  ]) {
    const f = fixture(t, patch)
    const result = await refreshAccountProfile(f.root, 'vm-01', { slotOauth: () => assert.fail('must not call') })
    assert.equal(result.ok, false)
    assert.equal(f.read().claude.billing_type, 'old-channel')
  }
})

test('403, throttling, transport failures and empty profiles preserve the previous snapshot', async (t) => {
  for (const slotOauth of [
    async () => ({ ok: false, status: 403 }),
    async () => ({ ok: false, status: 429 }),
    async () => {
      throw new Error('transport failure')
    },
    async () => ({ ok: true, body: {} }),
  ]) {
    const f = fixture(t)
    const result = await refreshAccountProfile(f.root, 'vm-01', { slotOauth })
    assert.equal(result.ok, false)
    assert.deepEqual(f.read(), f.vm)
  }
})

test('an in-flight response cannot overwrite a reauthorized account or a different organization', async (t) => {
  const f = fixture(t)
  const result = await refreshAccountProfile(f.root, 'vm-01', {
    slotOauth: async () => {
      const vm = f.read()
      vm.claude._token_version = 11
      vm.claude.billing_type = 'new-channel'
      fs.writeFileSync(f.file, JSON.stringify(vm))
      return { ok: true, body: profile }
    },
  })
  assert.equal(result.reason, 'credential_changed')
  assert.equal(f.read().claude.billing_type, 'new-channel')
  const mismatch = await refreshAccountProfile(f.root, 'vm-01', {
    slotOauth: async () => ({
      ok: true,
      body: { ...profile, organization: { uuid: 'different-org' } },
    }),
  })
  assert.equal(mismatch.reason, 'profile_identity_mismatch')
})

test('a successful new profile clears previously reported fields that are no longer supplied', async (t) => {
  const f = fixture(t, { rate_limit_tier: 'default_claude_max_20x' })
  const result = await refreshAccountProfile(f.root, 'vm-01', {
    slotOauth: async () => ({
      ok: true,
      body: { account: { uuid: 'account-1', has_claude_pro: true }, organization: { uuid: 'org-1' } },
    }),
  })
  assert.equal(result.ok, true)
  assert.equal(f.read().claude.subscription_type, 'pro')
  assert.equal(f.read().claude.billing_type, undefined)
  assert.equal(f.read().claude.rate_limit_tier, undefined)
})

test('authorization collects subscription data even with complete identity; failures do not fail the grant', async (t) => {
  const previous = process.env.KIN_CRS_MOCK
  process.env.KIN_CRS_MOCK = '1'
  t.after(() => {
    if (previous === undefined) delete process.env.KIN_CRS_MOCK
    else process.env.KIN_CRS_MOCK = previous
  })
  for (const success of [true, false]) {
    const f = fixture(t)
    let reads = 0
    const { commitImportedOauth } = createImportCommit({
      cfg: { paths: { project: f.root } },
      routingConfig: {},
      importWorkerCredential: async () => ({ ok: true }),
      refreshAccountProfile: (root, id) =>
        refreshAccountProfile(root, id, {
          slotOauth: async () => {
            reads++
            return { ok: success, body: profile, status: success ? 200 : 403 }
          },
        }),
    })
    const result = await commitImportedOauth({
      vmId: 'vm-01',
      vmPath: f.file,
      existing: f.vm,
      oauth: {
        type: 'setup-token',
        access_token: 'new-access',
        refresh_token: 'refresh',
        account_uuid: 'account-1',
        org_uuid: 'org-1',
        email: 'current@example.test',
        scope: 'user:profile user:inference',
      },
    })
    assert.equal(result.ok, true)
    assert.equal(reads, 1)
    assert.equal(result.subscription_profile.ok, success)
    assert.equal(f.read().claude.billing_type, success ? 'apple_subscription' : undefined)
    assert.equal(f.read().claude.subscription_type, success ? 'max' : undefined)
    assert.equal(f.read().claude.has_access, true)
  }
})
