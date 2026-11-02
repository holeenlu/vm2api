import { api } from '@/lib/api'

export const bulkFields = [
  'schedulable',
  'max_concurrency',
  'max_rpm',
  'weight',
  'schedule_level',
] as const
export type BulkField = (typeof bulkFields)[number]
export type BulkValue = number | boolean | null
export type BulkTarget = {
  id: string
  name: string
  platform: 'openai' | 'anthropic'
  values: Record<BulkField, BulkValue>
  versions: Record<BulkField, string>
  group_ids: number[]
  groups_version: number
}
export type BulkPatch = Partial<Record<BulkField, BulkValue>> & {
  groups?: { operation: 'add' | 'remove' | 'replace'; ids: number[] }
}
export type BulkRequest = {
  operation_id: string
  items: BulkTarget[]
  patch: BulkPatch
  confirm_empty_groups: boolean
}
export type BulkReport = {
  operation_id: string
  status: 'complete' | 'incomplete'
  error?: { code: string; message: string }
  items: Array<{
    id: string
    fields: Record<
      string,
      {
        status: 'pending' | 'writing' | 'saved' | 'unchanged' | 'not_applicable'
        error?: { code: string; message: string }
      }
    >
  }>
}
export const bulkBase = '/api/panel/vms/bulk-edit'
export const appliesTo = (field: BulkField, target: BulkTarget) =>
  field === 'weight'
    ? target.platform === 'openai'
    : field === 'schedule_level'
      ? target.platform === 'anthropic'
      : true
export function groupResult(
  before: number[],
  ids: number[],
  mode: 'add' | 'remove' | 'replace'
) {
  return mode === 'replace'
    ? ids
    : mode === 'add'
      ? [...new Set([...before, ...ids])]
      : before.filter((id) => !ids.includes(id))
}
export function bulkComplete(report: BulkReport) {
  return (
    report.status === 'complete' &&
    report.items.length > 0 &&
    report.items.every((item) =>
      Object.values(item.fields).every((cell) =>
        ['saved', 'unchanged', 'not_applicable'].includes(cell.status)
      )
    )
  )
}
/** Always query an uncertain response before retrying. Caller keeps this exact request/id. */
export async function saveBulk(request: BulkRequest): Promise<BulkReport> {
  try {
    return await api<BulkReport>(bulkBase, {
      method: 'POST',
      body: JSON.stringify(request),
    })
  } catch (error) {
    try {
      const found = await api<BulkReport>(
        `${bulkBase}/operations/${request.operation_id}`
      )
      return bulkComplete(found)
        ? found
        : {
            ...found,
            error: {
              code: 'save_unconfirmed',
              message:
                error instanceof Error ? error.message : 'Save unconfirmed',
            },
          }
    } catch {
      throw error
    }
  }
}

// Only non-secret configuration and snapshots are kept in this tab. Server receipts
// are authoritative; this merely preserves the operation ID after navigation/reload.
const pendingKey = () =>
  `vm-bulk-edit:${localStorage.getItem('kin_api_base') || ''}:${localStorage.getItem('kin_console_user') || ''}`
export function readPendingBulk(): BulkRequest | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(pendingKey()) || 'null')
    return value &&
      typeof value.operation_id === 'string' &&
      Array.isArray(value.items) &&
      value.items.length &&
      value.patch
      ? value
      : null
  } catch {
    return null
  }
}
export function storePendingBulk(request: BulkRequest | null) {
  try {
    if (request) sessionStorage.setItem(pendingKey(), JSON.stringify(request))
    else sessionStorage.removeItem(pendingKey())
  } catch {
    /* Storage may be unavailable; server receipt remains queryable. */
  }
}
