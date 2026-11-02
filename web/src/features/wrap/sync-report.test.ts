import { i18n } from '@/i18n'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ApiError } from '@/lib/api'
import { syncReportFromError, syncReportSummary } from './sync-report'

const report = {
  ok: false,
  total: 3,
  ok_count: 1,
  failed_count: 2,
  items: [
    { id: 'vm-1', ok: true },
    { id: 'vm-2', ok: false, error: 'kernel_start_failed' },
    { id: 'vm-3', ok: true, kernel: { ok: false, error: 'not ready' } },
  ],
}

const originalLanguage = i18n.language
beforeEach(async () => {
  await i18n.changeLanguage('zh-CN')
})
afterEach(async () => {
  await i18n.changeLanguage(originalLanguage)
})

describe('wrap sync partial failure', () => {
  it('recovers the per-slot report from a 400/503 error body', () => {
    const error = new ApiError('Bad Request', 400, { data: report })
    expect(syncReportFromError(error)).toBe(report)
  })

  it('recovers the nested sync report of a release install', () => {
    const error = new ApiError('槽同步失败', 400, {
      code: 'kernel_sync_failed',
      data: { release: {}, sync: report },
    })
    expect(syncReportFromError(error)).toBe(report)
  })

  it('ignores errors without a report', () => {
    expect(syncReportFromError(new ApiError('x', 503))).toBeNull()
    expect(syncReportFromError(new Error('x'))).toBeNull()
  })

  it('names the failed slots and their reasons', () => {
    expect(syncReportSummary(report)).toBe(
      '1/3 槽成功；失败 vm-2（kernel_start_failed）, vm-3（not ready）'
    )
    expect(syncReportSummary(report, 1)).toBe(
      '1/3 槽成功；失败 vm-2（kernel_start_failed） 等 2 台'
    )
  })
})

it('translates partial-failure summaries at call time without translating raw reasons', async () => {
  await i18n.changeLanguage('en-US')
  expect(syncReportSummary(report)).toBe(
    '1/3 slots succeeded; failed: vm-2 (kernel_start_failed), vm-3 (not ready)'
  )
  expect(syncReportSummary({ total: 1, ok_count: 1 })).toBe(
    '1/1 slot succeeded'
  )
  await i18n.changeLanguage('ja-JP')
  expect(syncReportSummary(report, 1)).toBe(
    '1/3 スロット成功。失敗：vm-2（kernel_start_failed） ほか、計 2 台'
  )
  expect(report.items[1].error).toBe('kernel_start_failed')
})
