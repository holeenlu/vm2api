/** Pure commercial group policy helpers.  Database access stays in GroupsRepo. */

const PLATFORM_ALIASES = Object.freeze({ claude: 'anthropic', codex: 'openai' })

function text(value) {
  const result = String(value ?? '').trim()
  return result || null
}

function arrayOf(value) {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      value = []
    }
  }
  return Array.isArray(value) ? [...new Set(value.map((item) => String(item).trim()).filter(Boolean))] : []
}

export function normalizeGroupPlatform(value) {
  const platform = text(value)
  return PLATFORM_ALIASES[platform] || platform || 'mixed'
}

export function normalizeGroupPolicy(group = {}) {
  const source = group && typeof group === 'object' ? group : {}
  const platform = normalizeGroupPlatform(source.platform)
  const models = arrayOf(source.models ?? source.models_json)
  return Object.freeze({
    id: source.id ?? null,
    platform,
    models,
    rpm_limit: Number.isFinite(Number(source.rpm_limit)) ? Math.max(0, Number(source.rpm_limit)) : null,
    concurrency_limit: Number.isFinite(Number(source.concurrency_limit))
      ? Math.max(0, Number(source.concurrency_limit))
      : null,
    version: source.version ?? null,
  })
}

export function groupPlatformAllows(group, platform) {
  const policy = normalizeGroupPolicy(group)
  const wanted = normalizeGroupPlatform(platform)
  return policy.platform === 'mixed' || policy.platform === 'all' || policy.platform === wanted
}

export function groupAllowsModel(group, model) {
  const policy = normalizeGroupPolicy(group)
  return !policy.models.length || policy.models.includes(String(model ?? ''))
}

export function groupResourceIds(resources = [], resourceKind = null) {
  const rows = Array.isArray(resources) ? resources : []
  return rows
    .filter((row) => !resourceKind || row?.resource_kind === resourceKind)
    .map((row) => row?.resource_id)
    .filter((id) => id != null)
    .map(String)
}
