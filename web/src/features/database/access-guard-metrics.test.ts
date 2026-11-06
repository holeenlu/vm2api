import { createElement } from 'react'
import { i18n } from '@/i18n'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { AccessGuardMetricsPanel } from './access-guard-metrics'

afterEach(async () => {
  await i18n.changeLanguage('zh-CN')
})

const writeBehind = {
  queued: 3,
  max_queue: 10000,
  enqueued: 120,
  dropped_observation: 7,
  billing_direct: 0,
  peak: 42,
}
const routeBudget = {
  admitted: 15,
  rejected_busy: 2,
  timed_out: 1,
  running: 1,
  running_by_route: { 'GET /api/panel/usage-logs/summary': 1 },
  limits: { route_concurrency: 4, concurrency: 0, timeout_ms: 15000 },
}

describe('data access guard metrics', () => {
  it('shows write-behind drops and stats budget counters in every locale', async () => {
    for (const [locale, title] of [
      ['zh-CN', '数据访问保护'],
      ['zh-TW', '資料存取保護'],
      ['en-US', 'Data access guards'],
      ['ja-JP', 'データアクセス保護'],
    ] as const) {
      await i18n.changeLanguage(locale)
      const html = renderToStaticMarkup(
        createElement(AccessGuardMetricsPanel, { writeBehind, routeBudget })
      )
      expect(html).toContain(title)
      expect(html).toContain(i18n.t('database:droppedObservation'))
      expect(html).toContain(i18n.t('database:unlimited'))
      expect(html).not.toContain('{{value')
    }
  })

  it('shows failing database writes and settlements waiting for a retry in every locale', async () => {
    const writeHealth = {
      writable: false,
      since: '2026-11-06T12:00:00.000Z',
      last_error: 'database is locked',
      last_error_code: 'SQLITE_BUSY',
      last_failure_at: '2026-11-06T12:00:05.000Z',
      failures: 4,
      recovered_at: null,
      recoveries: 0,
      settlement_retry: {
        pending: 2,
        scheduled: 2,
        retried: 1,
        recovered: 0,
        abandoned: 0,
      },
    }
    for (const locale of ['zh-CN', 'zh-TW', 'en-US', 'ja-JP'] as const) {
      await i18n.changeLanguage(locale)
      const html = renderToStaticMarkup(
        createElement(AccessGuardMetricsPanel, { writeHealth })
      )
      expect(html).toContain(i18n.t('database:dbWritesFailing'))
      expect(html).toContain('SQLITE_BUSY')
      expect(html).toContain(i18n.t('database:settlementRetry'))
      expect(html).not.toContain('{{value')
    }
    await i18n.changeLanguage('zh-CN')
    const ok = renderToStaticMarkup(
      createElement(AccessGuardMetricsPanel, {
        writeHealth: { ...writeHealth, writable: true, since: null },
      })
    )
    expect(ok).toContain(i18n.t('database:dbWritesOk'))
  })

  it('renders nothing for an older control plane without the fields', () => {
    expect(
      renderToStaticMarkup(createElement(AccessGuardMetricsPanel, {}))
    ).toBe('')
  })
})
