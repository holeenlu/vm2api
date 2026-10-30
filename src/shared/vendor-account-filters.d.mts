export const EMPTY_ACCOUNT_FILTERS: {
  search: string
  platform: string
  status: string
  group: string
  method: string
  failure: string
  cooldown: string
  schedulable: string
  archived: string
  from: string
  to: string
  sort: string
}
type AccountRow = {
  id: string
  name: string
  status: string
  created_at: string
  config: Record<string, unknown>
  telemetry?: { state: string; requires_authorization?: boolean }
}
export function filterAccountRows<T extends AccountRow>(
  rows: T[],
  query?: Partial<typeof EMPTY_ACCOUNT_FILTERS>,
  now?: number,
): T[]
export function canReauthorizeAccount(row: AccountRow): boolean
export function accountCooldown(row: AccountRow, now?: number): Record<string, boolean>
