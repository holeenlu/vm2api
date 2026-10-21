/**
 * GPT catalog. Separate settings key from Claude model_policy.
 * Live ids from ChatGPT sync; seed is empty-catalog fallback.
 */
import { SettingsRepo } from '../db/repos/settings-repo.mjs'
import { gptContextWindowOverride, isGptSeriesId, isSyncableGptCatalogId } from './gpt-ids.mjs'

const SETTINGS_KEY = 'gpt_model_policy'

const CAP_GPT = {
  context_window: 272000,
  supports_1m: false,
  thinking_mode: 'enabled_only',
  supports_adaptive: false,
  requires_adaptive: false,
  supports_interleaved: false,
  supports_effort: false,
  supports_context_management: false,
}

function applyContextWindow(id, row) {
  const context = gptContextWindowOverride(id)
  if (!context) return row
  return {
    ...row,
    capabilities: { ...row.capabilities, context_window: context, supports_1m: false },
    ...(row.codex_metadata ? { codex_metadata: { ...row.codex_metadata, context_window: context } } : {}),
  }
}

function entry(id, extra = {}) {
  return applyContextWindow(id, {
    id,
    display_name: extra.display_name || extra.label || id,
    family: 'codex',
    enabled: extra.enabled !== false,
    sort: extra.sort || 80,
    capabilities: extra.capabilities || {
      ...CAP_GPT,
      ...(id.startsWith('gpt-6') ? { context_window: 1050000, supports_1m: true, supports_effort: true } : {}),
    },
    params: extra.params || { max_tokens_default: 16384, max_tokens_cap: 128000 },
    aliases: extra.aliases || [],
    ...(extra.codex_metadata ? { codex_metadata: extra.codex_metadata } : {}),
  })
}

export function seedGptPolicy() {
  const models = {}
  for (const [id, extra] of [
    ['gpt-6.1-sol', { display_name: 'GPT-6.1 Sol', sort: 1, aliases: ['codex'] }],
    ['gpt-6-astra', { display_name: 'GPT-6 Astra', sort: 2 }],
    ['gpt-6-luna', { display_name: 'GPT-6 Luna', sort: 3 }],
    ['gpt-6-sol', { display_name: 'GPT-6 Sol', sort: 4 }],
    ['gpt-5.6-sol', { display_name: 'GPT-5.6 Sol', sort: 10 }],
    ['gpt-5.6-terra', { display_name: 'GPT-5.6 Terra', sort: 11 }],
    ['gpt-5.6-luna', { display_name: 'GPT-5.6 Luna', sort: 12 }],
  ]) {
    models[id] = entry(id, extra)
  }
  return {
    version: 1,
    updated_at: new Date().toISOString(),
    source: 'seed',
    platform: 'openai',
    models,
  }
}

let policy = seedGptPolicy()
let loaded = false

function persist() {
  try {
    new SettingsRepo().set(SETTINGS_KEY, policy)
  } catch (e) {
    console.warn('[gpt-model-policy] persist failed', e?.message || e)
  }
}

export function loadGptModelPolicy({ force = false } = {}) {
  if (loaded && !force) return policy
  try {
    const stored = new SettingsRepo().get(SETTINGS_KEY, null)
    if (stored && typeof stored === 'object' && stored.models && typeof stored.models === 'object') {
      const live = stored.source === 'codex' && Object.keys(stored.models).length
      policy = {
        ...(live
          ? stored
          : stored.source === 'seed'
            ? seedGptPolicy()
            : { ...seedGptPolicy(), ...stored, models: { ...seedGptPolicy().models, ...stored.models } }),
        platform: 'openai',
      }
      policy.source = policy.source || 'settings'
    } else {
      policy = seedGptPolicy()
      persist()
    }
  } catch {
    policy = seedGptPolicy()
  }
  policy.models = Object.fromEntries(
    Object.entries(policy.models).map(([id, row]) => [id, applyContextWindow(id, row)]),
  )
  loaded = true
  return policy
}

export function getGptModelPolicy() {
  if (!loaded) loadGptModelPolicy()
  return policy
}

export function saveGptModelPolicy(next) {
  const seed = seedGptPolicy()
  const models = { ...(seed.models || {}) }
  if (next?.models && typeof next.models === 'object') {
    for (const [id, row] of Object.entries(next.models)) {
      if (!isGptSeriesId(id) || !row || typeof row !== 'object') continue
      models[id] = applyContextWindow(id, { ...models[id], ...row, id, family: 'codex' })
    }
  }
  policy = {
    ...seed,
    ...next,
    models,
    platform: 'openai',
    updated_at: new Date().toISOString(),
    source: 'panel',
  }
  persist()
  return policy
}
export function listGptPolicyModels() {
  if (!loaded) loadGptModelPolicy()
  return Object.entries(policy.models || {})
    .filter(([id, cfg]) => isGptSeriesId(id) && cfg?.enabled !== false)
    .map(([id, cfg]) => ({ id, ...cfg, family: 'codex' }))
    .sort((a, b) => (a.sort || 80) - (b.sort || 80) || String(a.id).localeCompare(String(b.id)))
}

export function getGptPolicyCatalogIds({ enabledOnly = false } = {}) {
  if (!loaded) loadGptModelPolicy()
  return Object.entries(policy.models || {})
    .filter(([id, cfg]) => isGptSeriesId(id) && (!enabledOnly || cfg?.enabled !== false))
    .map(([id]) => id)
}

export function isGptModelEnabled(id) {
  if (!isGptSeriesId(id)) return false
  if (!loaded) loadGptModelPolicy()
  const row = policy.models?.[id]
  if (row) return row.enabled !== false
  if (policy.source === 'codex' && Object.keys(policy.models || {}).length) return false
  return true
}

export function resetGptModelPolicy() {
  policy = seedGptPolicy()
  loaded = true
  persist()
  return policy
}

/**
 * Replace the GPT catalog with the live Codex list. Existing rows keep their edits;
 * a GPT id the policy has never seen starts disabled until the admin enables it
 * (GPT has no worker_only mode).
 */
export function syncGptIdsIntoPolicy(ids = [], { displayNameOf = null } = {}) {
  if (!loaded) loadGptModelPolicy()
  const live = []
  const seen = new Set()
  for (const item of ids || []) {
    const id = String(typeof item === 'string' ? item : item?.id || '').trim()
    if (!isSyncableGptCatalogId(id) || seen.has(id.toLowerCase())) continue
    seen.add(id.toLowerCase())
    live.push({
      id,
      display_name: String((typeof item === 'object' && item?.display_name) || '').trim(),
      codex_metadata: typeof item === 'object' ? item.codex_metadata : undefined,
    })
  }
  if (!live.length) {
    return { ok: true, synced: 0, added: [], ids: listGptPolicyModels().map((m) => m.id) }
  }
  const next = {}
  const added = []
  for (const row of live) {
    const prev = policy.models[row.id]
    if (!prev) added.push(row.id)
    next[row.id] = entry(row.id, {
      ...prev,
      display_name: row.display_name || prev?.display_name || displayNameOf?.(row.id) || row.id,
      enabled: prev ? prev.enabled !== false : false,
      source: 'codex',
      codex_metadata: row.codex_metadata || prev?.codex_metadata,
    })
  }
  policy = {
    ...policy,
    models: next,
    platform: 'openai',
    updated_at: new Date().toISOString(),
    source: 'codex',
  }
  persist()
  return {
    ok: true,
    synced: live.length,
    added,
    ids: listGptPolicyModels().map((m) => m.id),
  }
}
