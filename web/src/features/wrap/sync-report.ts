import { t } from '@/i18n'
import { isApiError } from '@/lib/api'
import type { WrapSyncReport } from './queries'

type SyncItem = NonNullable<WrapSyncReport['items']>[number]

/**
 * 槽同步部分失败时网关回 400/503，但正文仍是 `{ ok: true, data: 报告 }`；
 * api() 抛错时把 data 留在 ApiError 上，这里把逐槽报告取回来。
 */
export function syncReportFromError(error: unknown): WrapSyncReport | null {
  if (!isApiError(error)) return null
  const data = error.data
  if (!data || typeof data !== 'object') return null
  const rec = data as Record<string, unknown>
  if (Array.isArray(rec.items)) return rec as WrapSyncReport
  const sync = rec.sync as Record<string, unknown> | undefined
  if (sync && Array.isArray(sync.items)) return sync as WrapSyncReport
  return null
}

export function syncItemFailed(item: SyncItem): boolean {
  return item.ok === false || item.kernel?.ok === false
}

function itemReason(item: SyncItem): string {
  return String(item.error || item.kernel?.error || item.code || '').trim()
}

export function slotFailureLabel(item: SyncItem): string {
  const reason = itemReason(item)
  const id = item.id || '?'
  return reason ? t('wrap:slotFailure', { id, reason }) : id
}

/** Summarize partial failures while preserving original slot IDs and error text. */
export function syncReportSummary(report: WrapSyncReport, limit = 3): string {
  const items = report.items || []
  const count = report.total ?? items.length
  const failed = items.filter(syncItemFailed)
  const ok = report.ok_count ?? items.length - failed.length
  if (!failed.length) return t('wrap:syncSummary', { ok, count })
  const failures = failed.slice(0, limit).map(slotFailureLabel).join(', ')
  return t(
    failed.length > limit
      ? 'wrap:syncSummaryMoreFailed'
      : 'wrap:syncSummaryFailed',
    {
      ok,
      count,
      failures,
      failedCount: failed.length,
    }
  )
}
