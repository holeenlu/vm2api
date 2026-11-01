import fs from 'node:fs'
import { getGptModelPolicy } from './gpt-model-policy.mjs'
import { detectInboundPlatform } from './platform-detect.mjs'
import { gptContextWindowOverride } from './gpt-ids.mjs'

// Complete native descriptors, not an availability list. Provenance is in codex-assets.
const bundled = JSON.parse(fs.readFileSync(new URL('./codex-assets/models.json', import.meta.url), 'utf8')).models
const fallbackMessages = {
  instructions_template: fs.readFileSync(new URL('./codex-assets/instructions.txt', import.meta.url), 'utf8'),
  instructions_variables: null,
  content_filter_guidance: null,
  persistent_instructions: null,
  tools: null,
  approvals: null,
  collaboration_modes: null,
  auto_review: null,
  permissions: null,
  multi_agent: null,
  token_budget: null,
  guardian_v2: null,
  confirmation_policies: null,
}
// Codex rust-v0.160.0 ModelInfo plus its published catalog fields. Every model
// uses this ordered shape; model-specific capabilities and messages stay distinct.
const defaults = {
  slug: '',
  display_name: '',
  description: '',
  guardian: null,
  default_reasoning_level: null,
  supported_reasoning_levels: [],
  multi_agent_reasoning_effort: null,
  shell_type: 'unified_exec',
  visibility: 'list',
  supported_in_api: true,
  priority: 0,
  prefer_websockets: false,
  additional_speed_tiers: [],
  service_tiers: [],
  default_service_tier: null,
  available_access_programs: null,
  available_in_plans: [],
  minimal_client_version: null,
  availability_nux: null,
  upgrade: null,
  model_messages: fallbackMessages,
  include_skills_usage_instructions: false,
  include_plugin_usage_instructions: false,
  include_apps_usage_instructions: true,
  supports_reasoning_summary_parameter: true,
  supports_reasoning_summaries: false,
  default_reasoning_summary: 'auto',
  support_verbosity: false,
  default_verbosity: null,
  apply_patch_tool_type: null,
  web_search_tool_type: 'text',
  truncation_policy: { mode: 'bytes', limit: 10000 },
  supports_image_detail_original: false,
  supports_parallel_tool_calls: false,
  context_window: 272000,
  max_context_window: 272000,
  auto_compact_token_limit: null,
  comp_hash: null,
  effective_context_window_percent: 95,
  experimental_supported_tools: [],
  input_modalities: ['text'],
  supports_search_tool: false,
  supports_experimental_context: false,
  supports_reasoning_effort_updates: false,
  use_responses_lite: false,
  node_repl_auto_review_required: false,
  node_repl_disabled: false,
  requires_sandboxed_review: false,
  auto_review_model_override: null,
  model_specialty: null,
  tool_mode: null,
  multi_agent_version: null,
}
const nullableStrings = new Set([
  'description',
  'default_reasoning_level',
  'multi_agent_reasoning_effort',
  'default_service_tier',
  'minimal_client_version',
  'default_verbosity',
  'apply_patch_tool_type',
  'comp_hash',
  'auto_review_model_override',
  'model_specialty',
  'tool_mode',
  'multi_agent_version',
])
const nullableNumbers = new Set(['context_window', 'max_context_window', 'auto_compact_token_limit'])
const nullableObjects = new Set([
  'guardian',
  'available_access_programs',
  'availability_nux',
  'upgrade',
  'model_messages',
])
const messageStrings = new Set(['instructions_template', 'content_filter_guidance', 'persistent_instructions'])
const enums = {
  shell_type: ['unified_exec', 'disabled'],
  visibility: ['list', 'hide', 'none'],
  default_verbosity: ['low', 'medium', 'high'],
  apply_patch_tool_type: ['freeform'],
  web_search_tool_type: ['text', 'text_and_image'],
  default_reasoning_summary: ['auto', 'concise', 'detailed', 'none'],
  tool_mode: ['direct', 'code_mode', 'code_mode_only'],
  multi_agent_version: ['v1', 'v2'],
}
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
function validField(key, value, fallback) {
  if (value === null) return nullableStrings.has(key) || nullableNumbers.has(key) || nullableObjects.has(key)
  if (enums[key]) return enums[key].includes(value)
  if (nullableStrings.has(key)) return typeof value === 'string'
  if (nullableObjects.has(key)) return record(value)
  if (nullableNumbers.has(key) || typeof fallback === 'number')
    return (
      Number.isSafeInteger(value) &&
      (key === 'priority' || value > 0) &&
      (key !== 'effective_context_window_percent' || value <= 100)
    )
  if (key === 'truncation_policy')
    return (
      record(value) && ['bytes', 'tokens'].includes(value.mode) && Number.isSafeInteger(value.limit) && value.limit > 0
    )
  if (Array.isArray(fallback)) {
    if (!Array.isArray(value)) return false
    if (key === 'supported_reasoning_levels')
      return value.every(
        (v) => record(v) && typeof v.effort === 'string' && v.effort.length > 0 && typeof v.description === 'string',
      )
    if (key === 'service_tiers')
      return value.every((v) => record(v) && ['id', 'name', 'description'].every((k) => typeof v[k] === 'string'))
    return value.every((v) => typeof v === 'string' && (key !== 'input_modalities' || ['text', 'image'].includes(v)))
  }
  return typeof value === typeof fallback
}

// Store only the official fields with their declared types, including nulls.
// Message templates are metadata; credentials and routing headers are not.
export function codexMetadata(row) {
  const out = {}
  for (const [key, fallback] of Object.entries(defaults)) {
    let value = row?.[key]
    if (key === 'shell_type' && ['default', 'local', 'shell_command'].includes(value)) value = 'unified_exec'
    if (value !== undefined && validField(key, value, fallback)) out[key] = structuredClone(value)
  }
  if (record(out.model_messages)) {
    out.model_messages = Object.fromEntries(
      Object.keys(fallbackMessages)
        .filter((key) => {
          const value = out.model_messages[key]
          return value === null || (messageStrings.has(key) ? typeof value === 'string' : record(value))
        })
        .map((key) => [key, out.model_messages[key]]),
    )
  }
  if (out.truncation_policy)
    out.truncation_policy = { mode: out.truncation_policy.mode, limit: out.truncation_policy.limit }
  if (out.supported_reasoning_levels)
    out.supported_reasoning_levels = out.supported_reasoning_levels.map(({ effort, description }) => ({
      effort,
      description,
    }))
  if (out.service_tiers)
    out.service_tiers = out.service_tiers.map(({ id, name, description }) => ({ id, name, description }))
  const context = gptContextWindowOverride(row?.slug || row?.id)
  if (context) out.context_window = context
  return out
}

export function normalizeCodexModel(row) {
  const metadata = codexMetadata(row)
  const model = {
    ...structuredClone(defaults),
    ...metadata,
    model_messages: { ...fallbackMessages, ...metadata.model_messages },
  }
  if (model.context_window && model.max_context_window && model.max_context_window < model.context_window)
    model.max_context_window = model.context_window
  return model
}

/** Codex ModelsResponse: only authorized OpenAI chat models, with native metadata. */
export function codexModelCatalog(catalog) {
  const gpt = getGptModelPolicy().models || {}
  const seen = new Set()
  const models = catalog.data.filter((model) => {
    if (detectInboundPlatform(model.id).platform !== 'openai' || seen.has(model.id)) return false
    seen.add(model.id)
    return true
  })
  return {
    models: models.map((model, priority) => {
      const id = detectInboundPlatform(model.id).model
      const policy = gpt[model.id] || gpt[id]
      const reference = codexMetadata(bundled.find((m) => m.slug === id))
      const synced = codexMetadata(policy?.codex_metadata)
      const metadata = { ...reference, ...synced }
      const context = metadata.context_window ?? policy?.capabilities?.context_window ?? defaults.context_window
      return normalizeCodexModel({
        description: model.display_name || model.id,
        ...metadata,
        context_window: context,
        max_context_window: metadata.max_context_window ?? context,
        model_messages: { ...fallbackMessages, ...reference.model_messages, ...synced.model_messages },
        // Identity, visibility and the supported wire protocol belong to this gateway.
        slug: model.id,
        display_name: model.display_name || model.id,
        priority,
        visibility: 'list',
        supported_in_api: true,
        use_responses_lite: false,
      })
    }),
  }
}
