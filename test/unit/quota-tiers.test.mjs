import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DEFAULT_TIER_POLICIES,
  accountTierKey,
  mergeTierMaps,
  normalizeTiers,
  resolveTierKey,
  resolveTierPolicy,
} from '../../src/lib/pool/quota-tiers.mjs'
import { AccountQuota } from '../../src/lib/pool/account-quota.mjs'
import { buildRouting } from '../../src/lib/admin/panel-api.mjs'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kin-tiers-'))
}

test('normalizeTiers fills product defaults', () => {
  const tiers = normalizeTiers()
  assert.deepEqual(tiers.default, DEFAULT_TIER_POLICIES.default)
  assert.deepEqual(tiers.pro, DEFAULT_TIER_POLICIES.pro)
  assert.deepEqual(tiers.max, DEFAULT_TIER_POLICIES.max)
})

test('normalizeTiers reads limit_5h and aliases old safety_ratio', () => {
  const fromNew = normalizeTiers({
    pro: { max_concurrency: 3, limit_5h: 0.7, limit_7d: 0.6 },
  })
  assert.equal(fromNew.pro.limit_5h, 0.7)
  assert.equal(fromNew.pro.safety_ratio, 0.7)
  assert.equal(fromNew.pro.limit_7d, 0.6)
  assert.equal(fromNew.pro.weekly_safety_ratio, 0.6)

  const fromOld = normalizeTiers({
    pro: { max_concurrency: 3, safety_ratio: 0.7, weekly_safety_ratio: 0.6, warn_ratio: 0.55 },
  })
  assert.equal(fromOld.pro.limit_5h, 0.7)
  assert.equal(fromOld.pro.limit_7d, 0.6)
  const legacy = normalizeTiers({ pro: { max_sessions: 3, session_idle_min: 9 } })
  assert.equal(Object.hasOwn(legacy.pro, 'max_sessions'), false)
  assert.equal(Object.hasOwn(legacy.pro, 'session_idle_min'), false)
})

test('resolveTierKey maps unknown to default', () => {
  assert.equal(resolveTierKey('pro'), 'pro')
  assert.equal(resolveTierKey('MAX'), 'max')
  assert.equal(resolveTierKey('unknown'), 'default')
  assert.equal(accountTierKey({ unified: { account_tier: 'pro' } }), 'pro')
})

test('mergeTierMaps only overlays provided keys', () => {
  const merged = mergeTierMaps(
    { pro: { max_concurrency: 2, safety_ratio: 0.85 } },
    { pro: { weekly_safety_ratio: 0.6 }, max: { max_concurrency: 8 } },
  )
  assert.equal(merged.pro.max_concurrency, 2)
  assert.equal(merged.pro.weekly_safety_ratio, 0.6)
  assert.equal(merged.max.max_concurrency, 8)
})

test('buildRouting returns tiers so the panel can re-render a save', async () => {
  const data = (
    await buildRouting({
      routingConfig: { sticky: {}, quota: {}, concurrency: {} },
      stickyRouter: { activeCount: () => 0, stats: () => ({ active_sessions: 0 }) },
    })
  ).data
  assert.ok(data.tiers.pro)
  assert.equal(data.tiers.pro.max_concurrency, 2)
  assert.equal(data.tiers.pro.limit_5h, 0.85)
  assert.equal(data.tiers.pro.limit_7d, 0.8)
  assert.equal(data.tiers.pro.weekly_safety_ratio, 0.8)
  assert.equal(data.tiers.max.max_concurrency, 4)
})

test('buildRouting returns normalized vm defaults', async () => {
  const data = (
    await buildRouting({
      routingConfig: { sticky: {}, quota: {}, concurrency: {} },
      stickyRouter: { activeCount: () => 0, stats: () => ({ active_sessions: 0 }) },
    })
  ).data
  assert.equal(data.vm.default_runtime, 'docker')
  assert.equal(data.vm.memory, '4g')
  assert.equal(data.vm.vcpus, 4)
  assert.equal(data.vm.disk_gb, 20)
  assert.equal(data.vm.allow_tcg, false)
})

test('buildRouting defaults a missing thinking display to summarized', async () => {
  const data = (
    await buildRouting({
      routingConfig: { sticky: {}, quota: {}, concurrency: {} },
      stickyRouter: { activeCount: () => 0, stats: () => ({ active_sessions: 0 }) },
    })
  ).data
  assert.equal(data.compatibility.thinking_display, 'summarized')
  const pinned = (
    await buildRouting({
      routingConfig: { compatibility: { thinking_display: 'passthrough' } },
      stickyRouter: { activeCount: () => 0, stats: () => ({ active_sessions: 0 }) },
    })
  ).data
  assert.equal(pinned.compatibility.thinking_display, 'passthrough')
})

test('buildRouting exposes effective Codex routing to the panel', async () => {
  const data = (
    await buildRouting({
      routingConfig: { codex: { clients: { official_codex: 'allow' } } },
      stickyRouter: { activeCount: () => 0, stats: () => ({ active_sessions: 0 }) },
    })
  ).data
  assert.equal(data.codex.clients.official_codex, 'allow')
  assert.equal(data.codex.clients.openai_compatible, 'allow')
  assert.equal(data.codex.protocols['openai.responses'].enabled, true)
})

test('canAccept uses per-tier 5h and weekly lines', async () => {
  const q = new AccountQuota({
    dataDir: tmpDir(),
    config: {
      quota: { block_on_5h: true, block_on_7d: true, gate_overshoot: 0 },
      tiers: {
        default: { max_concurrency: 2, safety_ratio: 0.85, weekly_safety_ratio: 0.8, warn_ratio: 0.75 },
        pro: { max_concurrency: 2, safety_ratio: 0.85, weekly_safety_ratio: 0.8, warn_ratio: 0.75 },
        max: { max_concurrency: 4, safety_ratio: 0.95, weekly_safety_ratio: 0.95, warn_ratio: 0.85 },
      },
    },
  })
  await q.ensure({ account_id: 'pro-1' })
  await q.setAccountTier('pro-1', 'pro')
  await q.ingestHeaders('pro-1', { 'anthropic-ratelimit-unified-5h-utilization': '0.86' })
  assert.equal((await q.canAccept('pro-1')).reason, 'quota_5h_safety')

  await q.ensure({ account_id: 'max-1' })
  await q.setAccountTier('max-1', 'max')
  await q.ingestHeaders('max-1', {
    'anthropic-ratelimit-unified-5h-utilization': '0.86',
    'anthropic-ratelimit-unified-7d-utilization': '0.90',
  })
  assert.equal((await q.canAccept('max-1')).ok, true, 'Max 5h/7d stay under 95%')

  await q.ingestHeaders('max-1', { 'anthropic-ratelimit-unified-7d-utilization': '0.96' })
  assert.equal((await q.canAccept('max-1')).reason, 'quota_7d_safety')
})

test('reloadConfig picks up saved weekly line without process restart shape', async () => {
  const q = new AccountQuota({ dataDir: tmpDir(), config: {} })
  await q.ensure({ account_id: 'p' })
  await q.setAccountTier('p', 'pro')
  // Pro default 7d line 0.80 + default 0.05 overshoot.
  await q.ingestHeaders('p', { 'anthropic-ratelimit-unified-7d-utilization': '0.86' })
  assert.equal((await q.canAccept('p')).reason, 'quota_7d_safety')
  q.reloadConfig({
    quota: { block_on_5h: true, block_on_7d: true },
    tiers: { pro: { max_concurrency: 2, safety_ratio: 0.85, weekly_safety_ratio: 0.9, warn_ratio: 0.75 } },
  })
  assert.equal((await q.canAccept('p')).ok, true)
})

test('applyTierConcurrency writes only the matching tier', async () => {
  const q = await AccountQuota.create({
    dataDir: tmpDir(),
    config: { concurrency: { default_max_per_account: 20 } },
    accounts: [
      { account_id: 'a-pro', vm_id: 'vm-1', max_concurrency: 20 },
      { account_id: 'a-max', vm_id: 'vm-2', max_concurrency: 20 },
    ],
  })
  await q.setAccountTier('a-pro', 'pro')
  await q.setAccountTier('a-max', 'max')
  await q.applyTierConcurrency({
    default: { max_concurrency: 2 },
    pro: { max_concurrency: 2 },
    max: { max_concurrency: 4 },
  })
  assert.equal((await q.repo.get('a-pro')).max_concurrency, 2)
  assert.equal((await q.repo.get('a-max')).max_concurrency, 4)
})

test('applyTierRpm writes only the matching tier and skips override', async () => {
  const q = await AccountQuota.create({
    dataDir: tmpDir(),
    config: {},
    accounts: [
      { account_id: 'r-pro', vm_id: 'vm-1', max_rpm: 0 },
      { account_id: 'r-max', vm_id: 'vm-2', max_rpm: 0 },
      { account_id: 'r-pin', vm_id: 'vm-3', max_rpm: 99 },
    ],
  })
  await q.setAccountTier('r-pro', 'pro')
  await q.setAccountTier('r-max', 'max')
  await q.setMaxRpm('r-pin', 99, { override: true })
  await q.applyTierRpm({
    default: { max_rpm: 10 },
    pro: { max_rpm: 15 },
    max: { max_rpm: 30 },
  })
  assert.equal((await q.repo.get('r-pro')).max_rpm, 15)
  assert.equal((await q.repo.get('r-max')).max_rpm, 30)
  assert.equal((await q.repo.get('r-pin')).max_rpm, 99)
})

test('resolveTierPolicy reads live config', () => {
  const p = resolveTierPolicy(
    {
      tiers: { max: { max_concurrency: 8, safety_ratio: 0.9, weekly_safety_ratio: 0.7, warn_ratio: 0.6 } },
    },
    'max',
  )
  assert.equal(p.max_concurrency, 8)
  assert.equal(p.limit_7d, 0.7)
  assert.equal(p.weekly_safety_ratio, 0.7)
})

test('saving Pro 5h=80% lands on policyFor limit_5h', async () => {
  const q = new AccountQuota({
    dataDir: tmpDir(),
    config: {
      quota: { block_on_5h: true, block_on_7d: true, gate_overshoot: 0 },
      tiers: normalizeTiers({
        pro: { limit_5h: 0.8, limit_7d: 0.8, max_concurrency: 2 },
      }),
    },
  })
  await q.ensure({ account_id: 'pro-80' })
  await q.setAccountTier('pro-80', 'pro')
  assert.equal(q.policyFor(await q.repo.get('pro-80')).limit_5h, 0.8)
  await q.ingestHeaders('pro-80', { 'anthropic-ratelimit-unified-5h-utilization': '0.81' })
  assert.equal((await q.canAccept('pro-80')).reason, 'quota_5h_safety')
})

test('Pro 95% runs one call at a time from 90% and blocks at line + overshoot', async () => {
  const q = new AccountQuota({
    dataDir: tmpDir(),
    config: {
      quota: { block_on_5h: true, block_on_7d: true },
      tiers: normalizeTiers({
        pro: { limit_5h: 0.95, limit_7d: 0.95, max_concurrency: 4 },
      }),
    },
  })
  await q.ensure({ account_id: 'pro-95' })
  await q.setAccountTier('pro-95', 'pro')
  await q.ingestHeaders('pro-95', {
    'anthropic-ratelimit-unified-5h-utilization': '0.9',
    'anthropic-ratelimit-unified-5h-status': 'allowed',
  })
  assert.equal((await q.canAccept('pro-95')).ok, true)
  q.inflight.set('pro-95', 1)
  assert.equal((await q.canAccept('pro-95')).reason, 'quota_band_inflight')
  q.inflight.set('pro-95', 0)
  await q.ingestHeaders('pro-95', {
    'anthropic-ratelimit-unified-5h-utilization': '0.96',
    'anthropic-ratelimit-unified-5h-status': 'allowed',
  })
  assert.equal((await q.canAccept('pro-95')).ok, true, 'past the line but inside the 5% overshoot')
  await q.ingestHeaders('pro-95', {
    'anthropic-ratelimit-unified-5h-utilization': '1',
    'anthropic-ratelimit-unified-5h-status': 'allowed',
  })
  assert.equal((await q.canAccept('pro-95')).reason, 'quota_5h_safety')
})

test('reloadConfig applies conc and rpm without rewriting account rows', async () => {
  const q = new AccountQuota({
    dataDir: tmpDir(),
    config: {
      quota: { block_on_5h: true, block_on_7d: true },
      tiers: { default: { max_concurrency: 2, max_rpm: 0 } },
    },
  })
  await q.ensure({ account_id: 'live' })
  const acc = await q.repo.get('live')
  assert.equal(q.limitFor(acc), 2)
  assert.equal(q.rpmLimitFor(acc), 0)
  q.reloadConfig({
    quota: { block_on_5h: true, block_on_7d: true },
    tiers: { default: { max_concurrency: 8, max_rpm: 12 } },
  })
  assert.equal(q.limitFor(await q.repo.get('live')), 8)
  assert.equal(q.rpmLimitFor(await q.repo.get('live')), 12)
})

test('manual conc and rpm pins ignore live tier', async () => {
  const q = new AccountQuota({ dataDir: tmpDir(), config: {} })
  await q.ensure({ account_id: 'pin' })
  await q.setMaxConcurrency('pin', 1, { override: true })
  await q.setMaxRpm('pin', 2, { override: true })
  q.reloadConfig({
    quota: { block_on_5h: true, block_on_7d: true },
    tiers: { default: { max_concurrency: 8, max_rpm: 60 } },
  })
  assert.equal(q.limitFor(await q.repo.get('pin')), 1)
  assert.equal(q.rpmLimitFor(await q.repo.get('pin')), 2)
})
