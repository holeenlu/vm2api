import { createElement } from 'react'
import { i18n } from '@/i18n'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { formatMetricTime, promptCacheRate } from './metrics'
import { PromptCacheMetricsPanel } from './prompt-cache-metrics'
import { UsageCacheMetricsPanel } from './usage-cache-metrics'

afterEach(async () => {
  await i18n.changeLanguage('zh-CN')
})
describe('database localized metrics', () => {
  it('translates errors and empty metrics without translating upstream details', async () => {
    const prefixes = [
      ['en-US', 'Failed to load prompt cache metrics:'],
      ['zh-CN', '提示词缓存统计加载失败：'],
      ['zh-TW', '提示詞快取統計載入失敗：'],
      ['ja-JP', 'プロンプトキャッシュ指標の読み込みに失敗しました：'],
    ] as const
    for (const [locale, prefix] of prefixes) {
      await i18n.changeLanguage(locale)
      const html = renderToStaticMarkup(
        createElement(PromptCacheMetricsPanel, {
          loading: false,
          error: new Error('upstream_bad <model-id> 原文'),
          window: '6h',
          onWindowChange: () => {},
        })
      )
      expect(html).toContain(prefix)
      expect(html).toContain('upstream_bad &lt;model-id&gt; 原文')
      expect(html).not.toContain('[object Object]')
      expect(html).not.toContain('{{value')
      const empty = renderToStaticMarkup(
        createElement(UsageCacheMetricsPanel, { metrics: null })
      )
      expect(empty).toContain(i18n.t('database:usageUnavailable'))
    }
  })
  it('uses the selected locale for dates without changing calculations or timezone', async () => {
    const timestamp = '2026-10-21T04:05:06.000Z'
    for (const locale of ['en-US', 'zh-CN', 'zh-TW', 'ja-JP']) {
      await i18n.changeLanguage(locale)
      expect(formatMetricTime(timestamp)).toBe(
        new Date(timestamp).toLocaleString(locale)
      )
      expect(promptCacheRate({ input: 10, read: 20, creation: 10 })).toBe(0.5)
      expect(promptCacheRate({})).toBeNull()
    }
  })
})
