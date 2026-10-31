import type { Resource } from './portal-model'

export type AccountStatus = 'active' | 'paused'
export type AccountStatusResult = {
  succeeded: string[]
  failed: { id: string; name: string; error: unknown }[]
}

export async function setAccountStatuses(
  rows: Resource[],
  status: AccountStatus,
  update: (row: Resource, status: AccountStatus) => Promise<unknown>,
  onProgress: (row: Resource, ok: boolean, done: number) => void
): Promise<AccountStatusResult> {
  const result: AccountStatusResult = { succeeded: [], failed: [] }
  for (const row of rows) {
    let ok = true
    try {
      // Set the requested state even if the list snapshot already has it.
      // A concurrent change or a stale derived state must not invert the intent.
      await update(row, status)
      result.succeeded.push(row.id)
    } catch (error) {
      ok = false
      result.failed.push({ id: row.id, name: row.name, error })
    }
    onProgress(row, ok, result.succeeded.length + result.failed.length)
  }
  return result
}

export function accountRowsCsv(rows: Resource[]) {
  const cell = (value: unknown) => {
    const text = String(value ?? '')
    const formula = /^[\s\uFEFF]*[=+@-]|^[\t\r\n]/.test(text)
    return '"' + (formula ? "'" : '') + text.replace(/"/g, '""') + '"'
  }
  const data = [
    [
      'id',
      'name',
      'platform',
      'status',
      'groups',
      'today_usd',
      'total_usd',
      'created_at',
    ],
    ...rows.map((row) => [
      row.id,
      row.name,
      row.config.platform,
      row.telemetry?.state,
      row.groups?.map((group) => group.name).join(';'),
      row.telemetry?.today_cost,
      row.telemetry?.total_cost,
      row.created_at,
    ]),
  ]
  return '\uFEFF' + data.map((row) => row.map(cell).join(',')).join('\r\n')
}
