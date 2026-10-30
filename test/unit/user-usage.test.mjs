import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildUsageView, handleUserUsage, resolveUsageWindows } from '../../src/lib/protocol/user-usage.mjs'
import { createUsageCache } from '../../src/lib/oauth/usage-cache.mjs'

function jsonCapture() {
  const calls = []
  return {
    calls,
    json(_res, status, body) {
      calls.push({ status, body })
      return body
    },
  }
}

test('buildUsageView converts Extra ratio to percent_used', () => {
  const view = buildUsageView(
    {
      '5h': { utilization: 0.85, status: 'active', reset: '2026-09-10T20:00:00Z' },
      '7d': { utilization: 0.34, status: 'ok', reset: '2026-09-16T00:00:00Z' },
    },
    'extra',
  )
  assert.equal(view.unit, 'percent_used')
  assert.equal(view.five_hour.utilization, 85)
  assert.equal(view.seven_day.utilization, 34)
  assert.equal(view.source, 'extra')
})

test('setup-token usage uses Extra and does not hop', async () => {
  const cap = jsonCapture()
  let probes = 0
  const unified = {
    headers: {
      '5h': { utilization: 0.12, status: 'active', reset: 'r5' },
      '7d': { utilization: 0.34, status: 'ok', reset: 'r7' },
    },
  }
  await handleUserUsage(
    {},
    {},
    {
      json: cap.json,
      requireAuth: () => true,
      stickyRouter: { extractPoolKey: () => null },
      accountQuota: { repo: { get: () => ({ unified }) } },
      getPoolScheduler: () => ({
        peekAccount: async () => ({
          ok: true,
          accountId: 'acc-1',
          vmId: 'vm-01',
          vm: { credential_mode: 'setup-token' },
          exec: {},
        }),
      }),
      probeAccount: async () => {
        probes += 1
        return { ok: true }
      },
    },
  )
  assert.equal(probes, 0)
  assert.equal(cap.calls[0].status, 200)
  assert.equal(cap.calls[0].body.source, 'extra')
})

test('oauth usage uses Extra and does not hop', async () => {
  const cap = jsonCapture()
  let probes = 0
  const unified = {
    headers: {
      '5h': { utilization: 0.12, status: 'active', reset: 'r5' },
      '7d': { utilization: 0.34, status: 'ok', reset: 'r7' },
    },
  }
  await handleUserUsage(
    {},
    {},
    {
      json: cap.json,
      requireAuth: () => true,
      stickyRouter: { extractPoolKey: () => null },
      accountQuota: { repo: { get: () => ({ unified }) } },
      getPoolScheduler: () => ({
        peekAccount: async () => ({
          ok: true,
          accountId: 'acc-1',
          vmId: 'vm-01',
          vm: { credential_mode: 'oauth' },
          exec: {},
        }),
      }),
      probeAccount: async () => {
        probes += 1
        return { ok: true }
      },
    },
  )
  assert.equal(probes, 0)
  assert.equal(cap.calls[0].status, 200)
  assert.equal(cap.calls[0].body.unit, 'percent_used')
  assert.equal(cap.calls[0].body.five_hour.utilization, 12)
  assert.equal(cap.calls[0].body.source, 'extra')
  assert.equal(cap.calls[0].body.account_id, undefined)
  assert.equal(cap.calls[0].body.vm_id, undefined)
})

test('empty Extra hops cached official usage once', async () => {
  let probes = 0
  const store = { unified: {} }
  const cache = createUsageCache({ jitter: false })
  const { listed, source } = await resolveUsageWindows({
    accountId: 'acc-1',
    accountQuota: {
      repo: { get: () => store },
      ingestOAuthUsage(_id, probe) {
        store.unified = {
          headers: {
            '5h': { utilization: (probe.five_hour.utilization || 0) / 100, status: 'active', reset: 'r5' },
            '7d': { utilization: (probe.seven_day.utilization || 0) / 100, status: 'ok', reset: 'r7' },
          },
        }
      },
    },
    usageCache: cache,
    probe: async () => {
      probes += 1
      return {
        ok: true,
        five_hour: { utilization: 21, resets_at: 'r5' },
        seven_day: { utilization: 40, resets_at: 'r7' },
      }
    },
  })
  assert.equal(probes, 1)
  assert.equal(source, 'oauth-usage')
  const view = buildUsageView(listed, source)
  assert.equal(view.five_hour.utilization, 21)
  const again = await resolveUsageWindows({
    accountId: 'acc-1',
    accountQuota: { repo: { get: () => store } },
    usageCache: cache,
    probe: async () => {
      probes += 1
      return { ok: true }
    },
  })
  assert.equal(probes, 1)
  assert.equal(again.source, 'extra')
})

function usageProject(t, vms) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-usage-pick-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  for (const vm of vms) fs.writeFileSync(path.join(root, 'vms', `${vm.id}.json`), JSON.stringify(vm))
  return root
}

const CLAUDE_UNIFIED = {
  headers: {
    '5h': { utilization: 0.2, status: 'active', reset: 'r5' },
    '7d': { utilization: 0.3, status: 'ok', reset: 'r7' },
  },
}

const CODEX_USAGE = {
  primary_used_percent: 40,
  primary_window_minutes: 300,
  secondary_used_percent: 10,
  secondary_window_minutes: 10080,
}

function usageDeps(root, overrides = {}) {
  const cap = jsonCapture()
  let peeks = 0
  return {
    cap,
    peeks: () => peeks,
    deps: {
      json: cap.json,
      requireAuth: () => true,
      projectRoot: root,
      accountQuota: { repo: { get: () => ({ unified: CLAUDE_UNIFIED }) } },
      getPoolScheduler: () => ({
        peekAccount: async () => {
          peeks += 1
          return { ok: false, code: 'no_eligible_accounts' }
        },
      }),
      probeAccount: async () => ({ ok: true }),
      ...overrides,
    },
  }
}

const platformReq = (extra = {}) => ({
  url: '/v1/usage',
  headers: {},
  apiKeyKind: 'managed',
  apiKeyRecord: { id: 'k1', user_id: 'admin1' },
  ...extra,
})
const platformUsers = { users: { getById: () => ({ role: 'super_admin' }) } }
const CODEX_VM = {
  owner_user_id: null,
  platform: 'openai',
  family: 'codex',
  codex: { has_access: true, usage: CODEX_USAGE },
}

test('usage keeps the next Claude account and tags its platform', async (t) => {
  const root = usageProject(t, [{ id: 'vm-x', ...CODEX_VM }])
  const { cap, deps, peeks } = usageDeps(root, {
    apiKeyStore: platformUsers,
    getPoolScheduler: () => ({
      peekAccount: async () => ({
        ok: true,
        accountId: 'acc-1',
        vmId: 'vm-c',
        vm: { claude: { mode: 'oauth' } },
        exec: {},
      }),
    }),
  })
  await handleUserUsage(platformReq(), {}, deps)
  assert.equal(cap.calls[0].status, 200, JSON.stringify(cap.calls[0].body))
  assert.equal(cap.calls[0].body.platform, 'anthropic')
  assert.equal(cap.calls[0].body.five_hour.utilization, 20)
  assert.equal(peeks(), 0)
})

test('usage reads Codex windows when the caller has no Claude account', async (t) => {
  const root = usageProject(t, [
    { id: 'vm-x', ...CODEX_VM },
    { id: 'vm-x-other', ...CODEX_VM, owner_user_id: 'u2' },
  ])
  const { cap, deps, peeks } = usageDeps(root, { apiKeyStore: platformUsers })
  await handleUserUsage(platformReq(), {}, deps)
  const body = cap.calls[0].body
  assert.equal(cap.calls[0].status, 200, JSON.stringify(body))
  assert.equal(peeks(), 1)
  assert.equal(body.platform, 'openai')
  assert.equal(body.source, 'codex')
  assert.equal(body.five_hour.utilization, 40)
  assert.equal(body.seven_day.utilization, 10)
})

test('platform usage never reads an unmigrated private Codex slot', async (t) => {
  const root = usageProject(t, [{ id: 'vm-x-other', ...CODEX_VM, owner_user_id: 'u2' }])
  const { cap, deps } = usageDeps(root, { apiKeyStore: platformUsers })
  await handleUserUsage(platformReq(), {}, deps)
  assert.equal(cap.calls[0].status, 503)
})

test('usage platform filter picks one side and rejects unknown values', async (t) => {
  const root = usageProject(t, [{ id: 'vm-x', ...CODEX_VM }])
  const { cap, deps, peeks } = usageDeps(root, {
    apiKeyStore: platformUsers,
    getPoolScheduler: () => ({
      peekAccount: async () => ({
        ok: true,
        accountId: 'acc-1',
        vmId: 'vm-c',
        vm: { claude: { mode: 'oauth' } },
        exec: {},
      }),
    }),
  })
  await handleUserUsage(platformReq({ url: '/v1/usage?platform=openai' }), {}, deps)
  assert.equal(cap.calls[0].body.platform, 'openai')
  await handleUserUsage(platformReq({ url: '/v1/usage?platform=claude' }), {}, deps)
  assert.equal(cap.calls[1].body.platform, 'anthropic')
  await handleUserUsage(platformReq({ url: '/v1/usage?platform=gemini' }), {}, deps)
  assert.equal(cap.calls[2].status, 400)
  assert.equal(cap.calls[2].body.error.code, 'invalid_platform')
  assert.equal(peeks(), 0)
})
