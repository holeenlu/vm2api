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

  it('renders nothing for an older control plane without the fields', () => {
    expect(
      renderToStaticMarkup(createElement(AccessGuardMetricsPanel, {}))
    ).toBe('')
  })
})
