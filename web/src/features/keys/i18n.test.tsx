import { i18n, resources } from '@/i18n'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider, Trans } from 'react-i18next'
import { afterEach, describe, expect, it } from 'vitest'
import {
  STATS_RANGES,
  formatBucketTitle,
  sessionDisplay,
} from '@/features/statistics/stats-format'
import { GroupGrants } from '@/features/users/group-grants'
import { STEP_META } from '@/features/welcome/steps'
import { connectionFiles } from './connection-config'
import {
  keyExpiryText,
  keyIsDead,
  keyQuotaLabel,
  keyQuotaPct,
  keyStatusTone,
} from './key-format'

const locales = ['en-US', 'zh-CN', 'zh-TW', 'ja-JP'] as const
const namespaces = [
  'keys',
  'statistics',
  'groups',
  'users',
  'billing',
  'subscriptions',
  'profile',
  'auth',
  'welcome',
  'import',
  'specs',
  'fleet',
  'errors',
] as const

afterEach(async () => {
  await i18n.changeLanguage('zh-CN')
})

function placeholders(value: string) {
  return [...value.matchAll(/{{\s*([^},]+)(?:,[^}]+)?}}/g)]
    .map((match) => match[1].trim())
    .sort()
}

describe('feature translation contracts', () => {
  it.each(namespaces)(
    '%s has the same nonempty keys and interpolation parameters in all four languages',
    (namespace) => {
      const reference = resources['zh-CN'][namespace] as Record<string, string>
      expect(Object.keys(reference).length).toBeGreaterThan(0)
      for (const locale of locales) {
        const translated = resources[locale][namespace] as Record<
          string,
          string
        >
        expect(Object.keys(translated).sort()).toEqual(
          Object.keys(reference).sort()
        )
        for (const key of Object.keys(reference)) {
          expect(
            typeof translated[key],
            locale + ':' + namespace + ':' + key
          ).toBe('string')
          expect(translated[key].trim()).not.toBe('')
          expect(
            placeholders(translated[key]),
            locale + ':' + namespace + ':' + key
          ).toEqual(placeholders(reference[key]))
        }
      }
    }
  )

  it('selects English singular and plural forms and interpolates model counts', async () => {
    await i18n.changeLanguage('en-US')
    expect(i18n.t('groups:selectedModels', { count: 1 })).toBe(
      '1 model selected'
    )
    expect(i18n.t('groups:selectedModels', { count: 2 })).toBe(
      '2 models selected'
    )
    expect(i18n.t('keys:modelsFetched', { count: 1 })).toBe(
      'Fetched 1 OpenAI model'
    )
    expect(i18n.t('keys:modelsFetched', { count: 0 })).toBe(
      'Fetched 0 OpenAI models'
    )
    await i18n.changeLanguage('ja-JP')
    expect(i18n.t('keys:modelsFetched', { count: 2 })).toBe(
      'OpenAI モデルを 2 個取得しました'
    )
    expect(i18n.t('keys:catalogFetchFailed', { status: 403 })).toContain(
      'HTTP 403'
    )
  })

  it('updates imported metadata and runtime status labels without reimporting modules', async () => {
    await i18n.changeLanguage('en-US')
    expect(STATS_RANGES[0].label).toBe('Today')
    expect(STEP_META.api_key.title).toBe('Issue an API key')
    const quota = {
      id: 'k',
      status: 'active',
      quota_requests: 2,
      quota_used: 2,
    }
    expect(keyStatusTone(quota).text).toBe('Quota exhausted')
    await i18n.changeLanguage('zh-TW')
    expect(STATS_RANGES[0].label).toBe('今天')
    expect(STEP_META.api_key.title).toBe('簽發 API 金鑰')
    expect(keyStatusTone(quota).text).toBe('額度已用盡')
    expect(keyIsDead(quota)).toBe(true)
    expect(keyQuotaPct(quota)).toBe(100)
    expect(keyQuotaLabel(quota)).toBe('2 / 2 次')
    expect(STEP_META.api_key.panelTo).toBe('/keys')
    expect(STEP_META.api_key.id).toBe('api_key')
    const failed = sessionDisplay({
      lastAt: '2026-10-21T00:00:00Z',
      lastStatus: 503,
    })
    expect(failed.label).toBe('FAIL')
    expect(failed.text).toBe('失敗')
    expect(failed.tooltip).toContain('503')
    expect(failed.pulse).toBe(true)
    expect(keyExpiryText({ id: 'permanent' })).toEqual({
      text: '永久',
      expired: false,
    })
  })

  it('formats a date in each UI language without shifting the supplied timezone', async () => {
    const iso = '2026-12-31T23:30:00Z'
    for (const language of locales) {
      await i18n.changeLanguage(language)
      expect(formatBucketTitle(iso, 'day', 'Asia/Shanghai')).toBe(
        new Intl.DateTimeFormat(language, {
          timeZone: 'Asia/Shanghai',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        }).format(new Date(iso))
      )
    }
  })

  it('renders complete rich text headings with language-specific word order', async () => {
    for (const language of locales) {
      await i18n.changeLanguage(language)
      const html = renderToStaticMarkup(
        <I18nextProvider i18n={i18n}>
          <h1>
            <Trans
              i18nKey='welcome:heroTitle'
              components={{ break: <br />, accent: <strong /> }}
            />
          </h1>
        </I18nextProvider>
      )
      expect(html).toContain('<strong>')
      expect(html).toContain('<br/>')
      expect(html).not.toContain('welcome:heroTitle')
      expect(html).not.toContain('{{')
      if (language === 'en-US') expect(html).toContain('into standard APIs')
      if (language === 'ja-JP') expect(html).toContain('標準 API に')
    }
  })

  it('renders group grant labels in the selected language without mutating grant values', async () => {
    const value = [{ group_id: 7, rate_multiplier: 0, rpm_override: 0 }]
    const original = structuredClone(value)
    for (const language of locales) {
      await i18n.changeLanguage(language)
      const html = renderToStaticMarkup(
        <I18nextProvider i18n={i18n}>
          <GroupGrants
            groups={[]}
            value={value}
            onChange={() => {
              throw new Error('rendering must not mutate grants')
            }}
          />
        </I18nextProvider>
      )
      expect(html).toContain(i18n.t('users:groupAccess'))
      expect(html).toContain(i18n.t('users:selectedGroups', { count: 1 }))
      expect(value).toEqual(original)
    }
  })

  it('keeps native client configuration, model IDs and credentials identical across languages', async () => {
    const options = {
      client: 'codex' as const,
      shell: 'unix' as const,
      base: 'https://relay.example',
      key: 'sk-vm-private-test',
      model: 'gpt-5.4',
      platform: 'openai',
      reasoningEffort: 'high',
    }
    await i18n.changeLanguage('en-US')
    const expected = connectionFiles(options)
    for (const language of locales) {
      await i18n.changeLanguage(language)
      expect(connectionFiles(options)).toEqual(expected)
      const claude = connectionFiles({
        ...options,
        client: 'claude',
        model: 'claude-sonnet-5',
        platform: 'anthropic',
      })
      expect(claude[0].content).toContain('ANTHROPIC_AUTH_TOKEN')
      expect(claude[0].content).toContain('sk-vm-private-test')
      expect(claude[0].content).toContain('claude-sonnet-5')
    }
  })
})
