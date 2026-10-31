import { i18n, t } from '@/i18n'
import { renderToStaticMarkup } from 'react-dom/server'
import { Trans } from 'react-i18next'
import { afterEach, describe, expect, it } from 'vitest'
import {
  VM_CREATE_AFTER,
  VM_LOCALES,
  VM_REGIONS,
  VM_TIMEZONES,
} from './create-options'
import {
  INFERENCE_ENGINE_OPTIONS,
  inferenceEnginePatchValue,
} from './engine-contract'
import { SLOT_PERSONA_OPTIONS, slotPersonaPatchValue } from './persona-contract'
import { RuntimeChip } from './runtime-chip'
import { CONC_STEPS, RPM_STEPS } from './scheduling-steps'
import { SeedPolicyCard } from './seed-policy-card'
import { seedDraftOf, seedSaveBody } from './seed-settings'
import { telemetryStatusLabel } from './telemetry-status'
import { groupTestChatStages, type TestChatLogLine } from './test-chat-types'
import { ZONES } from './vm-rack-model'
import { diagnosisCheckLabel, recoveryStepLabel } from './vm-recovery-types'
import {
  reconcileSchedule,
  type FormState,
  type TestSchedule,
} from './vm-test-schedule'

const languages = ['en-US', 'zh-CN', 'zh-TW', 'ja-JP'] as const
const originalLanguage = i18n.language

afterEach(async () => {
  await i18n.changeLanguage(originalLanguage)
})

function flatten(value: unknown, prefix = ''): Record<string, string> {
  if (typeof value === 'string') return { [prefix]: value }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
      Object.entries(flatten(child, prefix ? prefix + '.' + key : key))
    )
  )
}

function placeholders(value: string) {
  return [...value.matchAll(/\{\{\s*([^}]+)\s*\}\}|<\/?(part\d+)\s*\/?>/g)]
    .map((match) => match[0])
    .sort()
}

const catalog = Object.fromEntries(
  languages.map((language) => [
    language,
    flatten(i18n.getResourceBundle(language, 'vm')),
  ])
)

const sources = import.meta.glob<string>('./*.{ts,tsx}', {
  eager: true,
  query: '?raw',
  import: 'default',
})

describe('VM translation resources', () => {
  it.each(languages)(
    '%s has the same keys, interpolation parameters and rich-text slots',
    (language) => {
      expect(Object.keys(catalog[language]).sort()).toEqual(
        Object.keys(catalog['en-US']).sort()
      )
      for (const [key, value] of Object.entries(catalog[language])) {
        expect(value.trim(), language + ':' + key).not.toBe('')
        expect(placeholders(value), language + ':' + key).toEqual(
          placeholders(catalog['en-US'][key])
        )
      }
    }
  )

  it('resolves every statically referenced VM message, including plural families', () => {
    const keys = new Set<string>()
    for (const [file, source] of Object.entries(sources)) {
      if (file.includes('.test.')) continue
      for (const match of source.matchAll(
        /['"]vm:([A-Za-z0-9_.]+)['"]|i18nKey=['"]([A-Za-z0-9_.]+)['"]/g
      )) {
        keys.add(match[1] || match[2])
      }
    }
    for (const key of keys) {
      expect(
        catalog['en-US'][key] ?? catalog['en-US'][key + '_other'],
        key
      ).toBeTypeOf('string')
    }
  })

  it.each([
    [
      'en-US',
      'Created vm/$draft',
      'Checked: 1 reset available',
      'Checked: 2 resets available',
    ],
    ['zh-CN', '已创建 vm/$draft', '已查询，可兑换 1 次', '已查询，可兑换 2 次'],
    ['zh-TW', '已建立 vm/$draft', '已查詢，可兌換 1 次', '已查詢，可兌換 2 次'],
    [
      'ja-JP',
      'vm/$draft を作成しました',
      '確認済み：リセット可能回数 1 回',
      '確認済み：リセット可能回数 2 回',
    ],
  ])(
    'interpolates full messages and plurals in %s',
    async (language, created, one, many) => {
      await i18n.changeLanguage(language)
      expect(t('vm:createVmForm.created', { id: 'vm/$draft' })).toBe(created)
      expect(
        t('vm:claudeResetActions.checkedResetsAvailable', { count: 1 })
      ).toBe(one)
      expect(
        t('vm:claudeResetActions.checkedResetsAvailable', { count: 2 })
      ).toBe(many)
    }
  )

  it.each(languages)(
    'keeps rich-text nodes and unmodified dynamic data in %s',
    async (language) => {
      await i18n.changeLanguage(language)
      const html = renderToStaticMarkup(
        <Trans
          ns='vm'
          i18nKey='fleetPulse.highest'
          values={{ name: 'slot <one>', formattedUsd: '$12.50' }}
          components={{ part0: <strong />, part1: <span data-cost='true' /> }}
        />
      )
      expect(html).toContain('<strong>slot &lt;one&gt;</strong>')
      expect(html).toContain('<span data-cost="true">$12.50</span>')
      expect(html).not.toContain('{{')
    }
  )
})

describe('VM runtime language switching and data contracts', () => {
  it('updates previously imported option labels and status definitions without changing IDs', async () => {
    const optionValues = () =>
      [VM_REGIONS, VM_TIMEZONES, VM_CREATE_AFTER, CONC_STEPS, RPM_STEPS].map(
        (options) => options.map(([value]) => value)
      )
    const before = optionValues()
    await i18n.changeLanguage('en-US')
    expect(VM_REGIONS[0][1]).toBe('Automatic')
    expect(CONC_STEPS[0][1]).toBe('Unlimited')
    expect(SLOT_PERSONA_OPTIONS[0].label).toBe('Follow global')
    expect(ZONES[0].label).toBe('In pool')
    const englishEngine = INFERENCE_ENGINE_OPTIONS[0].label
    await i18n.changeLanguage('ja-JP')
    expect(VM_REGIONS[0][1]).toBe('自動')
    expect(CONC_STEPS[0][1]).toBe('無制限')
    expect(SLOT_PERSONA_OPTIONS[0].label).toBe('全体設定に従う')
    expect(ZONES[0].label).toBe('プール内')
    expect(INFERENCE_ENGINE_OPTIONS[0].label).not.toBe(englishEngine)
    expect(telemetryStatusLabel({ enabled: true, running: false })).toBe(
      '有効 · プロセス停止中'
    )
    expect(optionValues()).toEqual(before)
    expect(VM_LOCALES.map(([value]) => value)).toEqual([
      'en_US.UTF-8',
      'zh_CN.UTF-8',
      'zh_TW.UTF-8',
      'ja_JP.UTF-8',
      'C.UTF-8',
    ])
  })

  it('renders component labels in the selected language without changing runtime identity', async () => {
    const vm = { runtime_type: 'docker' as const }
    await i18n.changeLanguage('en-US')
    expect(renderToStaticMarkup(<RuntimeChip vm={vm} />)).toContain(
      'Docker container'
    )
    await i18n.changeLanguage('zh-TW')
    expect(renderToStaticMarkup(<RuntimeChip vm={vm} />)).toContain(
      'Docker 容器'
    )
    expect(vm).toEqual({ runtime_type: 'docker' })
  })

  it('translates diagnostic headings and stages but preserves raw logs and protocol values', async () => {
    const log: TestChatLogLine[] = [
      {
        at: '2026-10-21T00:00:00Z',
        level: 'info',
        message: '开始测试 vm-id 原始日志',
      },
    ]
    await i18n.changeLanguage('en-US')
    expect(groupTestChatStages(log)[0]).toMatchObject({
      key: 'start',
      label: 'Slot',
      lines: log,
    })
    await i18n.changeLanguage('ja-JP')
    expect(groupTestChatStages(log)[0]).toMatchObject({
      key: 'start',
      label: 'スロット',
      lines: log,
    })
    expect(diagnosisCheckLabel({ id: 'credential', label: '凭证' })).toBe(
      '認証情報'
    )
    expect(recoveryStepLabel({ id: 'start', label: '启动' })).toBe(
      'スロットを起動'
    )
    expect(log[0].message).toBe('开始测试 vm-id 原始日志')
    expect(inferenceEnginePatchValue('auto')).toBe('')
    expect(slotPersonaPatchValue('official_full')).toBe('official_full')
  })

  it('preserves unsaved seed text, LANG, timezone and submitted configuration across languages', async () => {
    const baseline = seedDraftOf(null)
    const draft = seedDraftOf(null, {
      locale: 'ja_JP.UTF-8',
      timezone: 'Asia/Tokyo',
      timezone_source: 'manual',
    })
    draft.claude_setting = 'USER_TEXT=未保存の入力\n'
    draft.env = {
      CUSTOM_FLAG: 'do-not-translate',
      LANG: 'zh_CN.UTF-8',
      TZ: 'UTC',
    }
    const snapshot = structuredClone(draft)
    const body = seedSaveBody(draft, baseline)
    for (const language of languages) {
      await i18n.changeLanguage(language)
      expect(draft).toEqual(snapshot)
      expect(seedSaveBody(draft, baseline)).toEqual(body)
      const html = renderToStaticMarkup(
        <SeedPolicyCard
          seed={{ settings_json: { theme: 'light' } }}
          slot={{}}
          saving={false}
          debug={false}
          onDebug={() => undefined}
          onSave={async () => undefined}
        />
      )
      expect(html).toContain(t('vm:seedSettings.rejectClientSettings'))
      expect(html).toContain(t('vm:seedSettings.rejectClientIdentity'))
    }
    expect(body).toMatchObject({
      locale: 'ja_JP.UTF-8',
      timezone: 'Asia/Tokyo',
      extra_env: { CUSTOM_FLAG: 'do-not-translate' },
      claude_setting: 'USER_TEXT=未保存の入力',
    })
  })

  it('does not treat a language change as a scheduled-test draft edit or data refresh', async () => {
    const saved: TestSchedule = {
      enabled: false,
      frequency: 'daily',
      time: '09:00',
      timezone: 'Asia/Tokyo',
      model: 'model-id',
      prompt: 'original',
      max_tokens: 64,
      reasoning_effort: null,
      last_run_at: null,
      last_ok: null,
      last_duration_ms: null,
      last_error: null,
      next_run_at: null,
      running: false,
    }
    const form: FormState = {
      enabled: false,
      structure: { frequency: 'daily', time: '09:00', timezone: 'Asia/Tokyo' },
      model: 'model-id',
      prompt: '未保存 draft',
      maxTokens: 128,
      reasoningEffort: '',
      codex: false,
    }
    const snapshot = structuredClone(form)
    for (const language of languages) {
      await i18n.changeLanguage(language)
      expect(reconcileSchedule(form, saved, saved)).toBe('keep')
      expect(reconcileSchedule(form, saved, { ...saved, enabled: true })).toBe(
        'stale'
      )
      expect(form).toEqual(snapshot)
    }
  })
})
