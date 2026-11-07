/**
 * GPT catalog. Separate settings key from Claude model_policy.
 * Live ids from ChatGPT sync; seed is empty-catalog fallback.
 */
import { SettingsRepo } from '../db/repos/settings-repo.mjs'
import { isAstraSolModel, isGptSeriesId, isSyncableGptCatalogId } from './gpt-ids.mjs'
import { IMAGE_TOOL_MODELS, canonicalImageToolModel } from './image-tool-models.mjs'

const SETTINGS_KEY = 'gpt_model_policy'
const DEFAULT_GPT_CONTEXT_WINDOW = 272000

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

function positiveContextWindow(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 8192 ? value : null
}

function normalizeContextWindowOverride(value) {
  if (value == null || value === '') return null
  return positiveContextWindow(value)
}

/**
 * Resolve the gateway's effective OpenAI context budget.
 * `catalog` remains the upstream fact; `context_window_override` is the
 * administrator-controlled value used by Codex export and preflight.
 */
export function effectiveGptContextWindow(id, row = null, fallback = DEFAULT_GPT_CONTEXT_WINDOW) {
  const override = positiveContextWindow(row?.context_window_override)
  if (override) return override
  const catalog = positiveContextWindow(row?.catalog?.context_window)
  if (catalog) return catalog
  const metadata = positiveContextWindow(row?.codex_metadata?.context_window)
  if (metadata && !(isAstraSolModel(id) && metadata === 500000)) return metadata
  return positiveContextWindow(fallback) || DEFAULT_GPT_CONTEXT_WINDOW
}

function entry(id, extra = {}) {
  return {
    id,
    display_name: extra.display_name || extra.label || id,
    family: 'codex',
    enabled: extra.enabled !== false,
    sort: extra.sort || 80,
    capabilities: extra.capabilities || { ...CAP_GPT, ...(id.startsWith('gpt-6') ? { supports_effort: true } : {}) },
    params: extra.params || { max_tokens_default: 16384, max_tokens_cap: 128000 },
    aliases: extra.aliases || [],
    expose_fast: extra.expose_fast === true,
    ...(extra.codex_metadata ? { codex_metadata: extra.codex_metadata } : {}),
  }
}

function bareModelId(model) {
  const raw = String(model || '').trim()
  if (!raw) return ''
  return raw.split('/').filter(Boolean).pop() || raw
}

function exactPolicyModelId(id) {
  const lower = String(id || '')
    .trim()
    .toLowerCase()
  if (!lower) return null
  return Object.keys(policy.models || {}).find((candidate) => candidate.toLowerCase() === lower) || null
}

function hasPriorityTier(row) {
  return (
    Array.isArray(row?.catalog?.service_tiers) &&
    row.catalog.service_tiers.some((tier) => tier && typeof tier === 'object' && tier.id === 'priority')
  )
}

/** Resolve the generated `<model>-fast` alias without treating it as a catalog id. */
export function resolveGptFastAlias(model) {
  if (!loaded) loadGptModelPolicy()
  const alias = bareModelId(model)
  if (!/^gpt-/i.test(alias) || !/-fast$/i.test(alias)) return { kind: 'normal', model: alias }

  const actualId = exactPolicyModelId(alias)
  if (actualId) return { kind: 'actual', model: actualId }

  const baseId = alias.replace(/-fast$/i, '')
  const baseIdExact = exactPolicyModelId(baseId)
  const base = baseIdExact ? policy.models?.[baseIdExact] : null
  if (!baseIdExact || !base) return { kind: 'unavailable', alias, reason: 'base_missing' }
  if (base.enabled === false) return { kind: 'unavailable', alias, reason: 'base_disabled', base: baseIdExact }
  if (base.expose_fast !== true) return { kind: 'unavailable', alias, reason: 'not_exposed', base: baseIdExact }
  if (!hasPriorityTier(base)) return { kind: 'unavailable', alias, reason: 'priority_missing', base: baseIdExact }
  return { kind: 'fast', alias, base: baseIdExact, service_tier: 'priority' }
}

export function isGptFastAliasAvailable(model) {
  return resolveGptFastAlias(model).kind === 'fast'
}

export function listGptFastAliases({ mappingKeys = [] } = {}) {
  if (!loaded) loadGptModelPolicy()
  const actualIds = new Set(Object.keys(policy.models || {}).map((id) => id.toLowerCase()))
  const mapped = new Set(
    (Array.isArray(mappingKeys) ? mappingKeys : []).map((id) => bareModelId(id).toLowerCase()).filter(Boolean),
  )
  return Object.entries(policy.models || {})
    .filter(([id, row]) => {
      const alias = `${id}-fast`.toLowerCase()
      return (
        /^gpt-/i.test(id) &&
        row?.enabled !== false &&
        row?.expose_fast === true &&
        hasPriorityTier(row) &&
        !actualIds.has(alias) &&
        !mapped.has(alias)
      )
    })
    .map(([id, row]) => ({
      id: `${id}-fast`,
      display_name: `${row.display_name || id} Fast`,
      family: 'codex',
      enabled: true,
      source: 'gpt-model-policy',
      alias_of: id,
      service_tier: 'priority',
    }))
}

/** Known image model ids only; `enabled` must be a boolean. Unlisted ids keep `base`. */
function normalizeImageTools(raw, base = null) {
  const out = {}
  for (const model of IMAGE_TOOL_MODELS) {
    out[model.id] = { enabled: base?.[model.id]?.enabled !== false }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [id, row] of Object.entries(raw)) {
    const canonical = canonicalImageToolModel(id)
    if (canonical && typeof row?.enabled === 'boolean') out[canonical] = { enabled: row.enabled }
  }
  return out
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
    image_tools: normalizeImageTools(null),
  }
}

let policy = seedGptPolicy()
let loaded = false

async function persist(value = policy) {
  try {
    await new SettingsRepo().set(SETTINGS_KEY, value)
  } catch (e) {
    console.warn('[gpt-model-policy] persist failed', e?.message || e)
  }
}

// 加载时 settings 里还没有 GPT 策略：种子（规整前的原样，与原先写入的内容一致）只由 warmGptModelPolicy 在服务启动时写入
let pendingSeed = null
let warming = null

/**
 * 同步加载（只读内存快照，不写库）。竞态 R21：种子写回只在服务启动时 `await warmGptModelPolicy()` 执行一次，
 * 运行期（推理热路径）只读内存，并发的首批请求不会重复 seed。
 */
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
      policy.image_tools = normalizeImageTools(stored.image_tools)
      policy.source = policy.source || 'settings'
      pendingSeed = null
    } else {
      policy = seedGptPolicy()
      pendingSeed = { ...policy }
    }
  } catch {
    policy = seedGptPolicy()
    pendingSeed = null
  }
  policy.models = Object.fromEntries(
    Object.entries(policy.models).map(([id, row]) => {
      const next = {
        ...(row && typeof row === 'object' ? row : {}),
        id,
        family: 'codex',
        expose_fast: row?.expose_fast === true,
      }
      const contextOverride = normalizeContextWindowOverride(row?.context_window_override)
      if (contextOverride) next.context_window_override = contextOverride
      else delete next.context_window_override
      return [id, next]
    }),
  )
  loaded = true
  return policy
}

/** 服务启动预热（R21）：重新加载；settings 里还没有 GPT 策略时写入种子。并发调用共用同一次预热。 */
export function warmGptModelPolicy() {
  warming ||= (async () => {
    loadGptModelPolicy({ force: true })
    const seed = pendingSeed
    pendingSeed = null
    if (seed) await persist(seed)
    return policy
  })().finally(() => {
    warming = null
  })
  return warming
}

export function getGptModelPolicy() {
  if (!loaded) loadGptModelPolicy()
  return policy
}

export async function saveGptModelPolicy(next) {
  const seed = seedGptPolicy()
  const models = { ...(seed.models || {}) }
  if (next?.models && typeof next.models === 'object') {
    for (const [id, row] of Object.entries(next.models)) {
      if (!isGptSeriesId(id) || !row || typeof row !== 'object') continue
      // Catalog facts come from the upstream sync only; a stale panel draft must not overwrite them.
      const { catalog: _drop, ...edits } = row
      const catalog = policy.models?.[id]?.catalog
      models[id] = {
        ...models[id],
        ...edits,
        id,
        family: 'codex',
        expose_fast: typeof edits.expose_fast === 'boolean' ? edits.expose_fast : models[id]?.expose_fast === true,
      }
      const contextOverride = normalizeContextWindowOverride(edits.context_window_override)
      if (contextOverride) models[id].context_window_override = contextOverride
      else delete models[id].context_window_override
      if (catalog) models[id].catalog = catalog
    }
  }
  const currentImageTools = policy.image_tools
  policy = {
    ...seed,
    ...next,
    models,
    image_tools: normalizeImageTools(next?.image_tools, currentImageTools),
    platform: 'openai',
    updated_at: new Date().toISOString(),
    source: 'panel',
  }
  await persist()
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

/** false = known and disabled; null = not a gateway image model (the upstream decides). */
export function isImageToolModelEnabled(id) {
  const canonical = canonicalImageToolModel(id)
  if (!canonical) return null
  if (!loaded) loadGptModelPolicy()
  return policy.image_tools?.[canonical]?.enabled !== false
}

export function listImageToolModels() {
  if (!loaded) loadGptModelPolicy()
  return IMAGE_TOOL_MODELS.map((model) => ({
    id: model.id,
    display_name: model.display_name,
    snapshots: [...model.snapshots],
    upstream_default: model.upstream_default,
    sort: model.sort,
    enabled: policy.image_tools?.[model.id]?.enabled !== false,
  }))
}

export async function resetGptModelPolicy() {
  policy = seedGptPolicy()
  loaded = true
  await persist()
  return policy
}

/**
 * Replace the GPT catalog with the live Codex list. Existing rows keep their edits;
 * a GPT id the policy has never seen starts disabled until the admin enables it
 * (GPT has no worker_only mode).
 */
export async function syncGptIdsIntoPolicy(ids = [], { displayNameOf = null } = {}) {
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
      catalog: typeof item === 'object' && item?.catalog && typeof item.catalog === 'object' ? item.catalog : null,
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
    // Upstream catalog facts replace the previous snapshot; a sync without them keeps it.
    const catalog = row.catalog ? { ...row.catalog, synced_at: new Date().toISOString() } : prev?.catalog
    if (catalog) next[row.id].catalog = catalog
  }
  policy = {
    ...policy,
    models: next,
    platform: 'openai',
    updated_at: new Date().toISOString(),
    source: 'codex',
  }
  await persist()
  return {
    ok: true,
    synced: live.length,
    added,
    ids: listGptPolicyModels().map((m) => m.id),
  }
}
