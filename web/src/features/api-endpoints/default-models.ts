import type { ApiModelEntry } from '@/types/panel-api-endpoints'
import type { ModelEntry, PolicyPayload } from '@/features/models/policy'

/**
 * OpenAI endpoints need an alias list even when the upstream /v1/models
 * request is unavailable. The model-policy page is the single source for
 * the system's enabled GPT allowlist.
 */
export function systemOpenAiModels(
  payload: PolicyPayload | undefined
): ApiModelEntry[] {
  const rows = (
    payload?.effective?.length ? payload.effective : payload?.models || []
  ) as Array<Partial<ModelEntry> & { id?: string }>
  const seen = new Set<string>()
  return rows
    .filter((row) => row.enabled !== false)
    .map((row) => String(row.id || '').trim())
    .filter((id) => {
      const key = id.toLowerCase()
      if (!id || seen.has(key)) return false
      seen.add(key)
      return true
    })
    .map((id) => ({ name: id, alias: id }))
}

export function hasModelDraftContent(
  rows: Array<{ name: string; alias: string }>
) {
  return rows.some((row) => row.name.trim() || row.alias.trim())
}
