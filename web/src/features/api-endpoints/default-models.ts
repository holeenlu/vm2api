import type { ApiModelEntry } from '@/types/panel-api-endpoints'
import type { PolicyPayload } from '@/features/models/policy'

/** Official endpoint defaults come from the model page, independently of VM availability. */
export function systemEndpointModels(
  kind: 'claude' | 'openai' | 'custom',
  payload: PolicyPayload | undefined
): ApiModelEntry[] {
  if (kind === 'custom') return []
  const rows: ApiModelEntry[] = (payload?.models ?? payload?.effective ?? [])
    .filter((row) => !('enabled' in row) || row.enabled !== false)
    .map((row) => ({ name: row.id.trim(), alias: row.id.trim() }))
  if (kind === 'openai') {
    rows.push(
      ...(payload?.image_tools || [])
        .filter((row) => row.enabled !== false)
        .map((row) => ({
          name: row.id.trim(),
          alias: row.id.trim(),
          image: true,
        }))
    )
  }
  return appendSystemModels([], rows)
}

export function appendSystemModels<T extends { name: string; alias: string }>(
  existing: T[],
  defaults: T[]
): T[] {
  const seen = new Set(
    existing
      .flatMap((row) => [row.name, row.alias])
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
  )
  const added = defaults.filter((row) => {
    const id = row.name.trim().toLowerCase()
    if (!id || seen.has(id)) return false
    seen.add(id)
    return true
  })
  return [...existing, ...added]
}

export function hasModelDraftContent(
  rows: Array<{ name: string; alias: string }>
) {
  return rows.some((row) => row.name.trim() || row.alias.trim())
}
