import { t } from '@/i18n'
import { isGptCatalogId } from '@/lib/vm-kind'

export type CatalogMode = 'remote' | 'file'
export type CodexModel = {
  slug: string
  display_name?: string
  visibility?: string
  default_reasoning_level?: string | null
  supported_reasoning_levels?: { effort: string; description?: string }[]
}
export type CodexCatalog = {
  models: CodexModel[]
  content: string
  responseBytes: number
}
export const CODEX_CATALOG_PATH = '~/.codex/codex-models.json'
export const CODEX_REMOTE_MAX_BYTES = 1024 * 1024
export function isCodexModelId(id: string) {
  return isGptCatalogId(id.split('/').filter(Boolean).pop() || id)
}
export function modelCatalogUrl(base: string) {
  return (
    base
      .trim()
      .replace(/[/]+$/, '')
      .replace(/[/]v1$/i, '') + '/v1/models'
  )
}
export async function fetchCodexCatalog(
  base: string,
  key: string,
  signal?: AbortSignal
): Promise<CodexCatalog> {
  const response = await fetch(
    `${modelCatalogUrl(base)}?client_version=0.156.0`,
    {
      headers: { Accept: 'application/json', Authorization: `Bearer ${key}` },
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
        : AbortSignal.timeout(15000),
    }
  )
  if (!response.ok)
    throw new Error(t('keys:catalogFetchFailed', { status: response.status }))
  const text = await response.text()
  const payload = JSON.parse(text)
  if (
    !payload ||
    !Array.isArray(payload.models) ||
    payload.models.some(
      (m: CodexModel) => !m || typeof m.slug !== 'string' || !m.slug.trim()
    )
  )
    throw new Error(t('keys:invalidCatalog'))
  const models = payload.models.filter((m: CodexModel) =>
    isCodexModelId(m.slug)
  )
  return {
    models,
    content: JSON.stringify({ ...payload, models }, null, 2),
    responseBytes: new TextEncoder().encode(text).byteLength,
  }
}
export function catalogReasoningEffort(model?: CodexModel) {
  const levels = (model?.supported_reasoning_levels || [])
    .map((v) => v.effort)
    .filter((v) => typeof v === 'string' && v !== 'none')
  const preferred = model?.default_reasoning_level
  return preferred === 'none'
    ? null
    : levels.includes(preferred || '')
      ? preferred
      : levels[0] || null
}
