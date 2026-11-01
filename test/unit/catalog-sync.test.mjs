import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { SettingsRepo } from '../../src/lib/db/repos/settings-repo.mjs'
import { loadModelPolicy, getModelPolicy } from '../../src/lib/protocol/model-policy.mjs'
import {
  loadGptModelPolicy,
  getGptModelPolicy,
  syncGptIdsIntoPolicy,
  saveGptModelPolicy,
} from '../../src/lib/protocol/gpt-model-policy.mjs'
import { clearModelsCache } from '../../src/lib/protocol/models.mjs'
import { readCatalogSync, syncClaudeCatalog } from '../../src/lib/admin/catalog-monitor.mjs'
import { parseCodexModelCatalog } from '../../src/lib/protocol/codex-models.mjs'
import { codexModelCatalog } from '../../src/lib/protocol/codex-catalog.mjs'

function seedClaudeVm(root, id) {
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'vms', `${id}.json`),
    JSON.stringify({
      id,
      status: 'running',
      claude: { access_token: 'at', refresh_token: 'rt', account_uuid: `acc-${id}` },
      proxy: { url: 'socks5h://127.0.0.1:1080' },
    }),
  )
}

function withDb(t, catalogMode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-catalog-sync-'))
  openDatabase({ dbPath: ':memory:' })
  if (catalogMode) new SettingsRepo().set('model_policy', { catalog_mode: catalogMode, models: {} })
  loadModelPolicy({ force: true })
  loadGptModelPolicy({ force: true })
  clearModelsCache()
  t.after(() => {
    closeDatabase()
    loadModelPolicy({ force: true })
    loadGptModelPolicy({ force: true })
    clearModelsCache()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return root
}

const upstream = (ids) => async () => ({ ok: true, status: 200, body: { data: ids.map((id) => ({ id })) } })

test('a Claude id new to the policy is added disabled outside worker_only', async (t) => {
  const root = withDb(t, 'policy_only')
  seedClaudeVm(root, 'vm-1')
  const before = getModelPolicy().models['claude-opus-5']
  const status = await syncClaudeCatalog({
    projectRoot: root,
    runOauth: upstream(['claude-opus-5', 'claude-opus-6-preview']),
  })
  assert.equal(status.status, 'ok')
  assert.deepEqual(status.added, ['claude-opus-6-preview'])
  const models = getModelPolicy().models
  assert.equal(models['claude-opus-6-preview'].enabled, false)
  assert.deepEqual(models['claude-opus-5'], before)
  assert.equal(readCatalogSync().claude.status, 'ok')
})

test('worker_only publishes a new Claude id immediately', async (t) => {
  const root = withDb(t, 'worker_only')
  seedClaudeVm(root, 'vm-1')
  await syncClaudeCatalog({ projectRoot: root, runOauth: upstream(['claude-opus-6-preview']) })
  assert.equal(getModelPolicy().models['claude-opus-6-preview'].enabled, true)
})

test('Claude sync without a reachable slot records the failure and changes nothing', async (t) => {
  const root = withDb(t, 'policy_only')
  seedClaudeVm(root, 'vm-1')
  const before = structuredClone(getModelPolicy().models)
  const status = await syncClaudeCatalog({
    projectRoot: root,
    runOauth: async () => ({ ok: false, status: 401, body: { error: { code: 'upstream_auth' } } }),
  })
  assert.equal(status.status, 'error')
  assert.equal(status.error, 'upstream_auth')
  assert.deepEqual(getModelPolicy().models, before)
})

test('a GPT id new to the policy starts disabled; known ids keep their switch', (t) => {
  withDb(t)
  const result = syncGptIdsIntoPolicy([{ id: 'gpt-6.1-sol' }, { id: 'gpt-7-preview' }])
  assert.deepEqual(result.added, ['gpt-7-preview'])
  const models = getGptModelPolicy().models
  assert.equal(models['gpt-6.1-sol'].enabled, true)
  assert.equal(models['gpt-7-preview'].enabled, false)
  assert.ok(!result.ids.includes('gpt-7-preview'))
})

const reference = JSON.parse(
  fs.readFileSync(new URL('../../src/lib/protocol/codex-assets/models.json', import.meta.url), 'utf8'),
)
const catalogInput = { data: reference.models.map((m) => ({ id: m.slug, display_name: m.display_name })) }

test('complete native descriptors survive synchronization, persistence and catalog download', (t) => {
  withDb(t)
  const live = structuredClone(reference)
  live.models[1].context_window = 765432
  live.models[1].model_messages.content_filter_guidance = 'Synced native guidance'
  syncGptIdsIntoPolicy(parseCodexModelCatalog(live))
  loadGptModelPolicy({ force: true })
  const exported = codexModelCatalog(catalogInput)
  assert.deepEqual(
    exported.models,
    live.models.map((m, priority) => ({
      ...m,
      context_window: m.slug === 'gpt-6.1-sol' ? 500000 : m.context_window,
      priority,
      use_responses_lite: false,
    })),
  )
})

test('historical sparse metadata gets complete matching descriptors without adding unauthorized models', (t) => {
  withDb(t)
  syncGptIdsIntoPolicy([
    {
      id: 'gpt-6.1-sol',
      codex_metadata: {
        context_window: 654321,
        model_messages: { instructions_template: 'cached native instructions' },
      },
    },
  ])
  const exported = codexModelCatalog({ data: [catalogInput.data[1]] }).models
  assert.equal(exported.length, 1)
  const native = reference.models[1]
  assert.deepEqual(exported[0], {
    ...native,
    context_window: 500000,
    priority: 0,
    use_responses_lite: false,
    model_messages: { ...native.model_messages, instructions_template: 'cached native instructions' },
  })
})

test('seed, existing stored policy, edits and synchronization keep Astra/Sol at 500k', (t) => {
  withDb(t)
  const ids = ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.6-sol']
  for (const id of ids) assert.equal(getGptModelPolicy().models[id].capabilities.context_window, 500000)
  const rows = Object.fromEntries(
    ids.map((id) => [
      id,
      {
        id,
        enabled: true,
        capabilities: { context_window: 1050000, supports_1m: true },
        codex_metadata: { context_window: 1050000, max_context_window: 872000 },
      },
    ]),
  )
  new SettingsRepo().set('gpt_model_policy', { source: 'codex', models: rows })
  loadGptModelPolicy({ force: true })
  const verify = () => {
    for (const id of ids) {
      const row = getGptModelPolicy().models[id]
      assert.equal(row.capabilities.context_window, 500000)
      assert.equal(row.capabilities.supports_1m, false)
      assert.equal(row.codex_metadata.context_window, 500000)
      assert.equal(row.codex_metadata.max_context_window, 872000)
    }
  }
  verify()
  saveGptModelPolicy({ models: rows })
  verify()
  syncGptIdsIntoPolicy(Object.values(rows))
  loadGptModelPolicy({ force: true })
  verify()
})

test('every catalog entry uses the same official field shape and valid types', (t) => {
  withDb(t)
  const original = reference.models.find((m) => m.slug === 'gpt-6-astra')
  const data = [
    ...catalogInput.data,
    { id: 'vendor/gpt-6-astra' },
    { id: 'gpt-new-model' },
    catalogInput.data[0],
    { id: 'claude-sonnet-5-5' },
  ]
  const models = codexModelCatalog({ data }).models
  assert.equal(models.length, reference.models.length + 2)
  for (const m of models) {
    assert.deepEqual(Object.keys(m), Object.keys(original))
    assert.deepEqual(Object.keys(m.model_messages), Object.keys(original.model_messages))
    assert.equal(typeof m.context_window, 'number')
    assert.ok(Array.isArray(m.supported_reasoning_levels))
    assert.ok(Array.isArray(m.service_tiers))
  }
  const alias = models.find((m) => m.slug === 'vendor/gpt-6-astra')
  assert.equal(alias.context_window, 500000)
  assert.equal(alias.max_context_window, 872000)
  assert.equal(models.find((m) => m.slug === 'gpt-6-luna').context_window, 272000)
})

test('invalid upstream field types fall back to official metadata and cannot leak extra keys', (t) => {
  withDb(t)
  syncGptIdsIntoPolicy([
    {
      id: 'gpt-6.1-sol',
      codex_metadata: {
        context_window: '900000',
        supports_parallel_tool_calls: 'yes',
        additional_speed_tiers: null,
        shell_type: 'shell_command',
        api_key: 'private',
        arbitrary_setting: true,
        base_instructions: 'obsolete prompt field',
        supported_reasoning_levels: [{ effort: 12 }],
        model_messages: { approvals: [], persistent_instructions: 123, arbitrary_setting: true },
      },
    },
  ])
  const m = codexModelCatalog({ data: [{ id: 'gpt-6.1-sol' }] }).models[0]
  const native = reference.models.find((m) => m.slug === 'gpt-6.1-sol')
  assert.equal(m.context_window, 500000)
  assert.equal(m.shell_type, 'unified_exec')
  assert.equal(m.supports_parallel_tool_calls, native.supports_parallel_tool_calls)
  assert.deepEqual(m.additional_speed_tiers, native.additional_speed_tiers)
  assert.deepEqual(m.supported_reasoning_levels, native.supported_reasoning_levels)
  assert.deepEqual(m.model_messages, native.model_messages)
  assert.equal(m.api_key, undefined)
  assert.equal(m.arbitrary_setting, undefined)
})
