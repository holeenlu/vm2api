import { createElement } from 'react'
import { i18n } from '@/i18n'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImageToolSection } from './image-tool-section'
import { ALIAS_PROBLEM_KEYS } from './model-mapping'
import { ModelRow } from './model-row'
import {
  modelsDevSyncOutcome,
  resetConfirmText,
  syncConfirmText,
} from './page-messages'
import {
  catalogFacts,
  filterModels,
  hydratePolicy,
  thinkingPolicyLabel,
} from './policy'
import { cacheFillHint, priceSourceLabel } from './price-display'

const locales = ['en-US', 'zh-CN', 'zh-TW', 'ja-JP'] as const
const namespaces = [
  'models',
  'apiEndpoints',
  'anthropic',
  'system',
  'wrap',
] as const
const originalLanguage = i18n.language

afterEach(async () => {
  await i18n.changeLanguage(originalLanguage)
})

function readResource(
  locale: string,
  namespace: string
): Record<string, string> {
  return JSON.parse(
    readFileSync(
      new URL(
        '../../i18n/locales/' + locale + '/' + namespace + '.json',
        import.meta.url
      ),
      'utf8'
    )
  )
}

function variables(value: string): string[] {
  return [...value.matchAll(/{{\s*([^},\s]+)(?:,[^}]*)?\s*}}/g)]
    .map((match) => match[1])
    .sort()
}

function tags(value: string): string[] {
  return [...value.matchAll(/<\/?([a-zA-Z][\w]*)\s*\/?\s*>/g)]
    .map((match) => match[1])
    .sort()
}

describe('assigned feature translations', () => {
  it.each(namespaces)(
    '%s has the same semantic keys, interpolation variables and rich-text tags in four languages',
    (namespace) => {
      const reference = readResource('en-US', namespace)
      for (const locale of locales) {
        const translated = readResource(locale, namespace)
        expect(Object.keys(translated).sort()).toEqual(
          Object.keys(reference).sort()
        )
        for (const [key, value] of Object.entries(translated)) {
          expect(key).toMatch(/^[a-zA-Z][a-zA-Z0-9]*(?:_(?:one|other))?$/)
          expect(typeof value).toBe('string')
          expect(
            value.trim().length,
            locale + ':' + namespace + ':' + key
          ).toBeGreaterThan(0)
          expect(variables(value), locale + ':' + key).toEqual(
            variables(reference[key])
          )
          expect(tags(value), locale + ':' + key).toEqual(tags(reference[key]))
          if (variables(value).includes('count')) {
            expect(key).toMatch(/_(one|other)$/)
            expect(
              translated[key.replace(/_(one|other)$/, '_one')]
            ).toBeDefined()
            expect(
              translated[key.replace(/_(one|other)$/, '_other')]
            ).toBeDefined()
          }
        }
      }
    }
  )

  it('updates runtime helper messages on language changes and uses English plurals', async () => {
    await i18n.changeLanguage('en-US')
    expect(
      modelsDevSyncOutcome({ models_dev: { status: 'ok', models: 1 } }).text
    ).toBe('models.dev synced (1 model)')
    expect(
      modelsDevSyncOutcome({ models_dev: { status: 'ok', models: 2 } }).text
    ).toBe('models.dev synced (2 models)')
    expect(syncConfirmText(false, 'GPT')).toBeNull()
    expect(syncConfirmText(true, 'GPT')).toContain('GPT catalog')
    expect(priceSourceLabel('override')).toBe('Override')
    await i18n.changeLanguage('zh-TW')
    expect(resetConfirmText(true)).toContain('未儲存')
    expect(priceSourceLabel('override')).toBe('覆寫')
    expect(cacheFillHint('openai', 'cache_5m', '3')).toBe(
      '預設為 0（無 cache_write）'
    )
    await i18n.changeLanguage('ja-JP')
    expect(priceSourceLabel('override')).toBe('上書き')
    expect(
      modelsDevSyncOutcome({
        models_dev: { status: 'error', error: 'HTTP 503 <upstream>' },
      })
    ).toEqual({
      ok: false,
      text: 'models.dev の同期に失敗しました：HTTP 503 <upstream>。前回の料金を引き続き使用します。',
    })
  })

  it('localizes image cards, catalog facts and mapping errors at runtime', async () => {
    const onToggle = vi.fn()
    for (const [locale, heading, pending, aliasError] of [
      ['en-US', 'Image models', 'Not synced', 'Alias cannot be empty'],
      ['zh-CN', '图像模型', '未同步', '别名不能为空'],
      ['zh-TW', '圖像模型', '未同步', '別名不能為空'],
      ['ja-JP', '画像モデル', '未同期', '別名は必須です'],
    ]) {
      await i18n.changeLanguage(locale)
      const html = renderToStaticMarkup(
        createElement(ImageToolSection, {
          models: [
            {
              id: 'gpt-image-2.5-flare',
              display_name: 'Flare',
              enabled: true,
              upstream_default: true,
              snapshots: [],
              sort: 0,
            },
          ],
          enabled: undefined,
          pricing: undefined,
          onToggle,
        })
      )
      expect(html).toContain(heading)
      expect(html).toContain('gpt-image-2.5-flare')
      expect(html).toContain('/v1/images/edits')
      expect(catalogFacts({ id: 'gpt-6-luna' }).context).toBe(pending)
      expect(i18n.t(ALIAS_PROBLEM_KEYS.empty)).toBe(aliasError)
    }
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('renders model cards in each language without modifying policy data or invoking edits', async () => {
    const model = {
      id: 'claude-private-中文',
      display_name: '使用者名稱 <raw>',
      family: 'custom',
      aliases: ['alias-中文'],
      enabled: false,
      params: { on_adaptive: 'strip' },
    }
    const policy = hydratePolicy({
      models: { [model.id]: model },
      defaults: { max_tokens: 321 },
    })
    const snapshot = JSON.stringify(policy)
    const onEdit = vi.fn()
    for (const [locale, hidden, thinking] of [
      ['en-US', 'Hidden', 'Strip'],
      ['zh-CN', '隐藏', '剥离'],
      ['zh-TW', '隱藏', '移除'],
      ['ja-JP', '非表示', '除去'],
    ]) {
      await i18n.changeLanguage(locale)
      const html = renderToStaticMarkup(
        createElement(ModelRow, {
          model,
          platform: 'anthropic',
          pol: policy,
          live: false,
          open: false,
          onToggleOpen: onEdit,
          onToggleEnabled: onEdit,
          onModel: onEdit,
          onParam: onEdit,
          onPass1m: onEdit,
        })
      )
      expect(html).toContain(hidden)
      expect(html).toContain('使用者名稱 &lt;raw&gt;')
      expect(html).toContain('claude-private-中文')
      expect(html).toContain('alias-中文')
      expect(thinkingPolicyLabel(model)).toBe(thinking)
      expect(filterModels([model], policy, 'alias-中文', 'all', 'all')).toEqual(
        [model]
      )
      expect(JSON.stringify(policy)).toBe(snapshot)
    }
    expect(onEdit).not.toHaveBeenCalled()
  })
})
