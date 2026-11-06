import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeGroupPlatform,
  normalizeGroupPolicy,
  groupAllowsModel,
  groupPlatformAllows,
  groupResourceIds,
} from '../../src/lib/pool/group-policy.mjs'
import {
  groupScopeDenial,
  keyAllowsEndpoint,
  keyAllowsModel,
  keyAllowsVm,
} from '../../src/lib/admin/key-scope-policy.mjs'
import { normalizeBillingFacts } from '../../src/lib/usage/billing-facts.mjs'
import { normalizeAdmissionFacts } from '../../src/lib/pool/admission-facts.mjs'
import { projectVendorAccount } from '../../src/lib/vendor/projections/account-projection.mjs'
import { projectResource } from '../../src/lib/admin/project-resource.mjs'
import { projectSeedSettings } from '../../src/lib/admin/ops/seed-settings-query.mjs'
import { seedSettingsPatchFromBody as commandPatch } from '../../src/lib/admin/ops/seed-settings-command.mjs'
import { backupConfigSnapshot, backupListSnapshot } from '../../src/lib/admin/ops/backup-query.mjs'
import { notificationTestConfig } from '../../src/lib/admin/ops/notification-command.mjs'

test('group policy normalizes aliases, models and resource ids', () => {
  const policy = normalizeGroupPolicy({ id: 3, platform: 'claude', models_json: '["claude-3"]', rpm_limit: '4' })
  assert.equal(normalizeGroupPlatform('claude'), 'anthropic')
  assert.equal(policy.platform, 'anthropic')
  assert.equal(policy.rpm_limit, 4)
  assert.equal(groupPlatformAllows(policy, 'anthropic'), true)
  assert.equal(groupAllowsModel(policy, 'claude-3'), true)
  assert.deepEqual(
    groupResourceIds(
      [
        { resource_kind: 'vm', resource_id: 7 },
        { resource_kind: 'api_endpoint', resource_id: 'e1' },
      ],
      'vm',
    ),
    ['7'],
  )
})

test('key scope predicates preserve platform and resource boundaries', () => {
  const scope = { group_type: 'openai', allowed_vms: ['vm-1'], allowed_endpoints: ['ep-1'], models: ['gpt-4'] }
  assert.equal(keyAllowsVm(scope, { id: 'vm-1', kind: 'codex' }), true)
  assert.equal(keyAllowsVm(scope, { id: 'vm-1', kind: 'claude' }), false)
  assert.equal(keyAllowsEndpoint(scope, { id: 'ep-1', platform: 'openai' }), true)
  assert.equal(keyAllowsModel(scope, 'gpt-4'), true)
  assert.deepEqual(groupScopeDenial({ error: 'group_required' }), {
    code: 'group_required',
    message: '分组不可用或当前用户没有使用权限',
  })
})

test('billing facts keep unknown money unknown', () => {
  const facts = normalizeBillingFacts({ input_tokens: 2, output_tokens: 3, total_cost: null })
  assert.equal(facts.usage_facts.total_tokens, 5)
  assert.equal(facts.cost_usd, null)
  assert.equal(facts.cost_known, false)
  assert.equal(facts.currency, null)
})

test('admission facts expose a stable retry hint without changing result semantics', () => {
  const facts = normalizeAdmissionFacts({ ok: false, reason: 'rpm_limit', detail: { reset_at: 123 } })
  assert.equal(facts.ok, false)
  assert.equal(facts.reason, 'rpm_limit')
  assert.equal(facts.retry_at, 123)
})

test('vendor account projection freezes only the shared read boundary', () => {
  const row = projectVendorAccount({
    config: { platform: 'openai' },
    groups: [{ id: 1 }],
    telemetry: { state: 'available' },
  })
  assert.equal(Object.isFrozen(row), true)
  assert.equal(Object.isFrozen(row.config), true)
  assert.equal(row.telemetry.state, 'available')
})

test('admin resource projection keeps proxy secrets out of the shared DTO', () => {
  const row = projectResource({
    id: 'proxy-1',
    vendor_id: 'vendor-1',
    resource_type: 'proxy',
    config_json: JSON.stringify({ endpoint: 'http://user:secret@example.test:8080', mode: 'pool' }),
    status: 'active',
  })
  assert.equal(row.config.endpoint, 'http://example.test:8080/')
  assert.equal(row.config.proxy, undefined)
})

test('ops facades preserve seed, backup and notification DTO shapes', async () => {
  assert.deepEqual(commandPatch({ seed_policy: { theme: 'dark' }, 'claude.setting': 'x' }), {
    theme: 'dark',
    claude_setting: 'x',
  })
  assert.deepEqual(commandPatch({ telemetry_disabled: true }), { telemetry_disabled: true })
  assert.deepEqual(
    projectSeedSettings({
      vmId: 'vm-1',
      seedPolicy: {},
      telemetry: { supported: true },
      observed: { timezone: 'Asia/Shanghai' },
    }),
    { vm_id: 'vm-1', seed_policy: {}, supported: true, timezone: 'Asia/Shanghai' },
  )
  const service = {
    list: () => ['b'],
    getSchedule: () => ({ enabled: true }),
    nextAutoAt: () => null,
    isRestoring: false,
  }
  assert.deepEqual(await backupListSnapshot(service), {
    items: ['b'],
    config: { enabled: true },
    next_auto_at: null,
    restoring: false,
  })
  assert.deepEqual(await backupConfigSnapshot(service), { config: { enabled: true }, next_auto_at: null })
  assert.deepEqual(
    notificationTestConfig({ enabled: true }, { email: { enabled: true } }, (base, patch) => ({ ...base, ...patch })),
    { enabled: true, email: { enabled: true }, telegram: undefined, wecom: undefined },
  )
})
