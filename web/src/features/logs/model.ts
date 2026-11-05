import type { UsageLogRow } from '@/types/panel-usage-logs'

export * from './column-visibility'
export { exportQuery } from './export-query'

export type LogStatusKind =
  'success' | 'redirect' | 'client_error' | 'server_error' | 'unknown'

export function logStatusKind(
  row: Pick<UsageLogRow, 'statusCode'>
): LogStatusKind {
  const status = row.statusCode
  if (status == null) return 'unknown'
  if (status >= 200 && status < 300) return 'success'
  if (status >= 300 && status < 400) return 'redirect'
  if (status >= 400 && status < 500) return 'client_error'
  return 'server_error'
}

export function logCostKnown(row: Pick<UsageLogRow, 'costUsd'>) {
  return row.costUsd != null && Number.isFinite(Number(row.costUsd))
}
