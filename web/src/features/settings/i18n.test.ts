import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { i18n, resources } from '@/i18n'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SETTINGS_TAB_LABELS, settingsTabId } from './navigation'
import { OfficialCcSettingsPane } from './official-cc-pane'
import { seedPersonaDrafts, personaTemplatesPayload } from './persona-drafts'
import { Socks5Pane } from './socks5-pane'
import { getUploadIntervalPresets, intervalLabel } from './telemetry-interval'

const locales = ['en-US', 'zh-CN', 'zh-TW', 'ja-JP'] as const
afterEach(async () => {
  await i18n.changeLanguage('zh-CN')
})

describe('settings localization contracts', () => {
  it('keeps keys, interpolation variables and rich-text tags identical in all owned namespaces', () => {
    const tokens = (value: string) =>
      [
        ...value.matchAll(
          new RegExp(
            '[{][{]([^}]+)[}][}]|<[/]?([a-zA-Z][a-zA-Z0-9]*)[ ]*[/]?[ ]*>',
            'g'
          )
        ),
      ]
        .map((m) => m[1] || m[2])
        .sort()
    for (const ns of ['settings', 'cluster', 'database']) {
      const reference = resources['en-US'][ns] as Record<string, string>
      for (const locale of locales) {
        const messages = resources[locale][ns] as Record<string, string>
        expect(Object.keys(messages).sort(), `${locale}:${ns}`).toEqual(
          Object.keys(reference).sort()
        )
        for (const [key, value] of Object.entries(messages)) {
          expect(typeof value, `${locale}:${ns}:${key}`).toBe('string')
          expect(value.trim(), `${locale}:${ns}:${key}`).not.toBe('')
          expect(tokens(value), `${locale}:${ns}:${key}`).toEqual(
            tokens(reference[key])
          )
        }
      }
    }
  })

  it('resolves navigation and interval options after each language switch without changing draft data', async () => {
    const draft = seedPersonaDrafts({
      persona_templates: {
        custom: [{ id: 'user', type: 'text', text: 'Keep 原文 {{user_id}}' }],
      },
    })
    const payload = personaTemplatesPayload(draft)
    const cases = [
      ['en-US', 'Branding', '1 hr 30 min'],
      ['zh-CN', '品牌', '1 小时 30 分钟'],
      ['zh-TW', '品牌', '1 小時 30 分鐘'],
      ['ja-JP', 'ブランド', '1 時間 30 分'],
    ] as const
    for (const [locale, title, interval] of cases) {
      await i18n.changeLanguage(locale)
      expect(i18n.t(SETTINGS_TAB_LABELS.branding, { ns: 'settings' })).toBe(
        title
      )
      expect(settingsTabId('branding')).toBe('branding')
      expect(intervalLabel(5400)).toBe(interval)
      expect(getUploadIntervalPresets().map(([value]) => value)).toEqual([
        300, 600, 1800, 3600, 21600, 86400,
      ])
      expect(personaTemplatesPayload(draft)).toEqual(payload)
    }
  })

  it('renders translated initialization controls while preserving custom prompt and configuration values', async () => {
    const config = {
      enabled: true,
      inference: 'cli-hop',
      hello_prompt: 'Keep user prompt 原文',
      timeout_ms: 70000,
      memory: '777m',
    }
    const before = structuredClone(config)
    const onChange = vi.fn()
    for (const locale of locales) {
      await i18n.changeLanguage(locale)
      const html = renderToStaticMarkup(
        createElement(OfficialCcSettingsPane, { config, onChange })
      )
      expect(html).toContain(i18n.t('settings:official.title'))
      expect(html).not.toContain('[object Object]')
      expect(html).not.toContain('{{value')
      expect(config).toEqual(before)
      expect(onChange).not.toHaveBeenCalled()
    }
  })

  it('renders rich text as markup and selects grammatical count variants', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    try {
      for (const locale of locales) {
        await i18n.changeLanguage(locale)
        const html = renderToStaticMarkup(
          createElement(
            QueryClientProvider,
            { client },
            createElement(Socks5Pane)
          )
        )
        expect(html).toContain('<code>[2001:db8::1]:1080</code>')
        expect(html).not.toContain('<part1>')
        expect(html).not.toContain('[object Object]')
      }
      await i18n.changeLanguage('en-US')
      expect(i18n.t('settings:telemetry.batchEnabled', { count: 1 })).toBe(
        'Telemetry enabled for 1 slot'
      )
      expect(i18n.t('settings:telemetry.batchEnabled', { count: 2 })).toBe(
        'Telemetry enabled for 2 slots'
      )
    } finally {
      client.clear()
    }
  })
})
