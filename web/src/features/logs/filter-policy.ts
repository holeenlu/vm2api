import type { PanelRole } from '@/types/panel-auth'
import type { LogsFilterState } from './search'

export type LogsTab = 'detail' | 'errors' | 'user' | 'key'

export function canFilterLogUsers(role: PanelRole | undefined, scope?: 'mine') {
  return scope !== 'mine' && (role === 'super_admin' || role === 'admin')
}

export function filtersForRole(
  filters: LogsFilterState,
  role: PanelRole | undefined
): LogsFilterState {
  const next = { ...filters }
  if (!canFilterLogUsers(role, filters.scope)) delete next.userId
  if (role !== 'super_admin') {
    delete next.vmId
    delete next.accountId
    delete next.sessionId
    delete next.mismatch
    delete next.minRetry
    delete next.debugOnly
  }
  return next
}
