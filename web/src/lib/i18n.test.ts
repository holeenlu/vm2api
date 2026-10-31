import { i18n, resources } from '@/i18n'
import type { Vm } from '@/types/panel-vm'
import { toast } from 'sonner'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError, loginRequest, normalizePanelError } from './api'
import {
  MESSAGES_BREAKPOINT_OPTIONS,
  normalizeCacheBreakpoints,
} from './cache-breakpoints'
import {
  credTypeLabel,
  credTypeOf,
  importMethodsFor,
  oauthFlavorFor,
} from './cred-type'
import {
  concInfo,
  extraUsageText,
  fableCardInfo,
  fableProbeLabel,
  fableState,
  fableUtil,
  fmtReset,
  fmtResetClock,
  resetCountdown,
  weeklySplitInfo,
} from './fable-status'
import {
  fmtAgo,
  fmtBytes,
  fmtDuration,
  fmtExpiresAt,
  fmtNum,
  fmtRate,
  fmtUsd,
  pct,
  usedPctOf,
} from './format'
import { handleServerError } from './handle-server-error'
import { importErrorMessage } from './import-errors'
import {
  ERROR_CLASS_META,
  hasApproximateCount,
  resolveMutedClasses,
  writeMutedClasses,
} from './log-mute'
import { errorClassTone, statusTone } from './log-tone'
import { vendorDisplayName } from './model-vendor/vendor-inference'
import {
  DEFAULT_AGENT_STANDING,
  DEFAULT_OVERLAY_TEMPLATES,
  DEFAULT_PERSONA_TEMPLATES,
  OVERLAY_PRESET_OPTIONS,
  OVERLAY_TEMPLATE_VARS,
  PERSONA_PRESET_OPTIONS,
  PERSONA_TEMPLATE_VARS,
  formatLineError,
  parsePersonaTemplateLines,
  protocolPersonaSaveToast,
  renderOverlayTemplate,
  stringifyPersonaTemplate,
  templateOrFollowPreset,
  validatePersonaTemplate,
} from './persona-template'
import { poolQuota } from './pool-quota'
import { setSession } from './session'
import { TIMEZONE_SOURCE_LABELS, validTimezone, zoneNowLabel } from './timezone'
import {
  calculateOutputRate,
  formatCurrency,
  formatDuration,
  formatTokenAmount,
} from './usage-format'
import { slotCredentialLabel } from './vm-kind'
import {
  accountStatus,
  accountUsable,
  credentialStatus,
  fleetGroup,
  localProxyText,
  poolStatus,
  vmBuckets,
} from './vm-status'
import {
  ESTIMATE_STATUS_LABELS,
  formatWindowSpend,
  vmCostLedger,
  vmTodayStats,
} from './vm-usage'
import { wrapHealthLabel } from './wrap-health'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

const languages = ['en-US', 'zh-CN', 'zh-TW', 'ja-JP'] as const
const now = Date.parse('2026-10-21T12:34:56Z')
const live: Vm = { id: 'vm-01', has_token: true, has_refresh: true }

// Exercises the already-imported singleton and constants; no module reset hides frozen labels.
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await i18n.changeLanguage('zh-CN')
})

function leaves(value: unknown, prefix = ''): Record<string, string> {
  if (typeof value === 'string') return { [prefix]: value }
  return Object.assign(
    {},
    ...Object.entries(value as Record<string, unknown>).map(([key, child]) =>
      leaves(child, prefix ? prefix + '.' + key : key)
    )
  )
}

describe('shared lib language switching', () => {
  it('provides the same semantic keys and interpolation parameters in all four catalogs', () => {
    const english = leaves(resources['en-US'].lib)
    for (const language of languages) {
      const catalog = leaves(resources[language].lib)
      expect(Object.keys(catalog).sort()).toEqual(Object.keys(english).sort())
      for (const [key, message] of Object.entries(catalog)) {
        expect(key).toMatch(/^[A-Za-z][A-Za-z0-9_.]*$/)
        expect(message.trim()).not.toBe('')
        expect((message.match(/{{\w+}}/g) || []).sort()).toEqual(
          (english[key].match(/{{\w+}}/g) || []).sort()
        )
      }
    }
  })

  it('refreshes imported option tuples, metadata and helper labels without changing IDs', async () => {
    const auth = ERROR_CLASS_META.auth
    const preset = PERSONA_PRESET_OPTIONS[0]
    const descriptions = PERSONA_TEMPLATE_VARS[0]
    const breakpoint = MESSAGES_BREAKPOINT_OPTIONS[0]
    const expected = [
      [
        'Manual',
        'Authentication',
        'Official prompt',
        'Fill missing',
        'No usage readings',
        'Empty slot',
      ],
      ['手动', '认证', '官方提示词', '补齐', '无用量读数', '空槽'],
      ['手動', '驗證', '官方提示詞', '補齊', '無用量讀數', '空插槽'],
      [
        '手動',
        '認証',
        '公式プロンプト',
        '不足を補完',
        '使用量データなし',
        '空きスロット',
      ],
    ]
    const descriptorLabels = new Set<string>()
    for (const [index, language] of languages.entries()) {
      await i18n.changeLanguage(language)
      expect([
        TIMEZONE_SOURCE_LABELS.manual,
        auth.label,
        preset[1],
        breakpoint[1],
        ESTIMATE_STATUS_LABELS.no_data,
        slotCredentialLabel(),
      ]).toEqual(expected[index])
      expect([auth.owner, preset[0], breakpoint[0], descriptions[0]]).toEqual([
        'client',
        'official',
        'fill',
        'billing',
      ])
      descriptorLabels.add(descriptions[1])
      expect(OVERLAY_PRESET_OPTIONS.map(([id]) => id)).toEqual([
        'off',
        'official',
        'minimal',
        'custom',
      ])
      expect(
        credTypeOf({ ...live, credential_mode: 'official-setup-token' })
      ).toBe('official-setup-token')
      expect(oauthFlavorFor('setup-token', 'link')).toBe('setup_token')
      expect(importMethodsFor('setup-token').map(({ id }) => id)).toEqual([
        'link',
        'session',
      ])
    }
    expect(descriptorLabels.size).toBe(4)
    await i18n.changeLanguage('en-US')
    expect(credTypeLabel('official-setup-token')).toBe('Official Setup Token')
    expect(vendorDisplayName('other')).toBe('Other')
    expect(vendorDisplayName('openai')).toBe('OpenAI')
    await i18n.changeLanguage('zh-TW')
    expect(vendorDisplayName('other')).toBe('其他')
    expect(
      normalizeCacheBreakpoints({ messages: 'cli-hop', enabled: false })
    ).toMatchObject({ messages: 'cli-hop', enabled: false })
  })

  it.each(languages)(
    'keeps VM grouping, usability and quota math unchanged in %s',
    async (language) => {
      await i18n.changeLanguage(language)
      const rows: [Vm, string, string, boolean][] = [
        [{ ...live, utilization_5h: 0.9 }, 'pool', 'caution', true],
        [{ ...live, utilization_7d: 0.9 }, 'pool', 'caution', true],
        [{ ...live, utilization_5h: 1 }, 'restricted', 'warn', true],
        [
          {
            ...live,
            schedule_state: 'restricted',
            restriction_reason: 'quota_5h_header',
            availability: { key: 'quota', usable: true, text: '5h 限制' },
          },
          'restricted',
          'warn',
          true,
        ],
        [{ ...live, schedule_state: 'off' }, 'off', 'off', true],
        [
          {
            ...live,
            schedule_state: 'restricted',
            availability: { key: 'rest', usable: true, text: '休息时段' },
          },
          'restricted',
          'caution',
          true,
        ],
        [
          {
            ...live,
            availability: { key: 'drain', usable: true, text: '7d 临近闸线' },
          },
          'pool',
          'caution',
          true,
        ],
        [{ ...live, seats_used: 4, seats_max: 4 }, 'pool', 'caution', true],
        [
          {
            ...live,
            schedule_state: 'off',
            availability: {
              key: 'off',
              usable: false,
              reason: 'oauth_revoked',
            },
          },
          'revoke',
          'bad',
          false,
        ],
        [
          { ...live, has_refresh: false, expires_at: '2000-01-01T00:00:00Z' },
          'bad',
          'bad',
          false,
        ],
        [{ id: 'vm-empty' }, 'none', 'none', false],
      ]
      const input = JSON.stringify(rows)
      for (const [vm, group, cls, usable] of rows) {
        expect(fleetGroup(vm)).toBe(group)
        expect(poolStatus(vm).cls).toBe(cls)
        expect(accountUsable(vm)).toBe(usable)
      }
      expect(credentialStatus(rows[4][0]).cls).toBe('ok')
      expect(vmBuckets(rows.map(([vm]) => vm))).toEqual({
        ok: 2,
        caution: 4,
        warn: 2,
        bad: 2,
        off: 0,
        none: 1,
      })
      expect(JSON.stringify(rows)).toBe(input)
      expect(pct(1.04)).toBe(104)
      expect(
        usedPctOf(
          {
            utilization_5h: 1,
            codex_usage: { windows: [{ id: '5h', used_percent: 1 }] },
          },
          '5h'
        )
      ).toBe(1)
      expect(
        poolQuota([
          { ...live, utilization_5h: 0.25 },
          { ...live, id: 'vm-02', schedule_state: 'off', utilization_5h: 0.5 },
        ]).windows[0]
      ).toMatchObject({
        capacity: 2,
        usedAccounts: 0.75,
        remainAccounts: 1.25,
        remainPct: 62.5,
      })
      expect(
        vmTodayStats({
          ...live,
          today_input_tokens: 20,
          today_cache_read_tokens: 80,
          today_cost: 1.25,
        })
      ).toMatchObject({ tok: 100, hit: 80, today: 1.25 })
      expect(
        vmCostLedger({ ...live, total_cost: 12, total_tokens: 800 })[2]
      ).toMatchObject({ key: 'total', cost: null, tokens: null })
    }
  )

  it('translates known backend statuses while preserving provider errors and node names', async () => {
    const raw = '上游自定义错误 <request id="123">'
    await i18n.changeLanguage('en-US')
    expect(
      accountStatus({
        ...live,
        availability: { key: 'ok', usable: true, text: '可用' },
      }).text
    ).toBe('Available')
    expect(
      accountStatus({
        ...live,
        cred_status: { key: 'bad', text: raw, tone: 'bad' },
      }).text
    ).toBe(raw)
    expect(accountStatus({ ...live, cred_status: '5h 限制' })).toMatchObject({
      cls: 'caution',
      text: '5h warning',
    })
    expect(fableProbeLabel({ fable: { error: raw } }, 'max')).toBe(raw)
    expect(localProxyText({ revealNode: true, nodeName: '東京-01' })).toBe(
      '東京-01 local proxy'
    )
    expect(localProxyText({ revealNode: false, nodeName: '東京-01' })).toBe(
      'Local proxy'
    )
    expect(
      errorClassTone({ error_class: 'auth', error_label: '认证' })
    ).toEqual({
      key: 'auth',
      cls: 'caution',
      text: 'Authentication',
      label: 'Authentication',
    })
    expect(
      errorClassTone({ error_class: 'custom', error_label: raw })?.text
    ).toBe(raw)
    expect(statusTone('failed')).toMatchObject({
      key: 'bad',
      cls: 'bad',
      text: 'Failed',
    })
    expect(statusTone(raw).text).toBe(raw)
    expect(statusTone(429)).toMatchObject({ key: 'caution', text: '429' })
    await i18n.changeLanguage('ja-JP')
    expect(
      accountStatus({
        ...live,
        availability: { key: 'ok', usable: true, text: '可用' },
      }).text
    ).toBe('利用可能')
    expect(
      errorClassTone({ error_class: 'auth', error_label: '认证' })?.text
    ).toBe('認証')
    expect(statusTone('failed')).toMatchObject({
      key: 'bad',
      cls: 'bad',
      text: '失敗',
    })
  })

  it.each(languages)(
    'keeps Fable state and concurrency unchanged in %s',
    async (language) => {
      await i18n.changeLanguage(language)
      expect(fableState({ fable: { banned: true } }, 'max')).toMatchObject({
        usedPct: null,
        tone: { key: 'bad', cls: 'bad' },
      })
      expect(fableState({ fable: { limited: true } }, 'max')).toMatchObject({
        usedPct: null,
        tone: { key: 'warn', cls: 'warn' },
      })
      expect(
        fableState({ fable: { ok: true }, utilization_7d_oi: 0.42 }, 'max')
      ).toMatchObject({ usedPct: 42, tone: { key: 'ok', cls: 'ok' } })
      expect(
        fableCardInfo({ fable: { plan_denied: true, status: 403 } }, 'max', 4)
      ).toMatchObject({ usedPct: null, badgeCls: 'bad' })
      expect(fableUtil({ fable: { banned: true } }, 'max')).toBe(100)
      expect(
        concInfo(
          { max_concurrency: 6, inflight: 2, fable_inflight: 4 },
          undefined,
          4
        )
      ).toMatchObject({
        max: 6,
        inf: 2,
        fmax: 4,
        fin: 4,
        cooling: false,
        hot: true,
      })
      expect(
        weeklySplitInfo({
          weekly_split: {
            enabled: true,
            fable_share: 0.5,
            fable_utilization: 0.4,
            fable_remaining: 0.1,
            fable_blocked: false,
          },
        })
      ).toMatchObject({ share: 0.5, used: 0.4, remaining: 0.1, blocked: false })
      expect(calculateOutputRate(100, 3000, 1000)).toBe(50)
    }
  )

  it('switches time, usage and health labels on the existing module instances', async () => {
    await i18n.changeLanguage('en-US')
    expect(fmtAgo(new Date(now - 60000).toISOString(), now)).toBe(
      '1 minute ago'
    )
    expect(fmtAgo(new Date(now - 120000).toISOString(), now)).toBe(
      '2 minutes ago'
    )
    expect(fmtDuration(90000)).toBe('1 min 30 s')
    expect(fableProbeLabel({}, 'max')).toBe('Not probed')
    expect(resetCountdown(1000, now)).toBe('Reset time passed')
    expect(fmtReset(1000)).toBe('Reset time passed')
    expect(
      extraUsageText({ is_enabled: true, utilization: 0.25, status: 'allowed' })
    ).toBe('On · 25% · Allowed')
    expect(
      wrapHealthLabel({
        reachable: true,
        provider: 'local_cli',
        ready_slots: 2,
      })
    ).toBe('Online · cli-hop · 2 slots ready')
    const spend = {
      status: 'ok' as const,
      used_ratio: 0.25,
      spent_usd: 1.25,
      total_usd: 5,
      remaining_usd: 3.75,
      total_tokens: 1200,
    }
    expect(formatWindowSpend(1.25, spend).remainText).toBe('$3.75 remaining')
    await i18n.changeLanguage('zh-TW')
    expect(fmtAgo(new Date(now - 120000).toISOString(), now)).toBe('2 分鐘前')
    expect(fmtDuration(90000)).toBe('1 分 30 秒')
    expect(fableProbeLabel({}, 'max')).toBe('尚未探測')
    expect(resetCountdown(1000, now)).toBe('已過重設時間')
    expect(formatWindowSpend(1.25, spend).remainText).toBe('剩餘 $3.75')
    expect(formatWindowSpend(1.25, spend).costText).toBe('$1.25 / ≈$5.00')
  })

  it.each(languages)(
    'formats dates and numbers with resolvedLanguage while retaining USD in %s',
    async (language) => {
      await i18n.changeLanguage(language)
      const numberFormat = vi.spyOn(Number.prototype, 'toLocaleString')
      expect(fmtUsd(12.3456)).toBe('$12.346')
      expect(formatCurrency(1234.5)).toBe('$1,234.50')
      expect(fmtNum(1500)).toBe('1.5K')
      expect(formatTokenAmount(12345)).toBe('12.35K')
      expect(fmtRate(1.234)).toBe('1.23')
      expect(fmtBytes(1536)).toBe('1.5KB')
      expect(formatDuration(1234)).toBe('1.23s')
      expect(numberFormat.mock.calls.length).toBeGreaterThan(0)
      expect(
        numberFormat.mock.calls.every(
          ([locale]) => locale === i18n.resolvedLanguage
        )
      ).toBe(true)
      expect(fmtExpiresAt(now)).toBe(new Date(now).toLocaleString(language))
      expect(zoneNowLabel('Asia/Tokyo', now)).toBe(
        new Intl.DateTimeFormat(language, {
          timeZone: 'Asia/Tokyo',
          hour12: false,
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        }).format(new Date(now))
      )
      expect(fmtResetClock(now)).toBe(
        new Intl.DateTimeFormat(language, {
          hour12: false,
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }).format(new Date(now))
      )
      expect(validTimezone(' asia/tokyo ')).toBe('Asia/Tokyo')
      expect(validTimezone('+09:00')).toBe('')
      expect(fmtExpiresAt('raw unknown date')).toBe('raw unknown date')
    }
  )

  it('stores error classes as codes even when the display language changes', async () => {
    const storage = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    })
    await i18n.changeLanguage('en-US')
    writeMutedClasses(['auth', 'quota'])
    await i18n.changeLanguage('ja-JP')
    expect(resolveMutedClasses()).toEqual(['auth', 'quota'])
    expect(storage.get('kin_log_muted_classes')).toBe('["auth","quota"]')
    expect(hasApproximateCount(resolveMutedClasses())).toBe(true)
  })

  it('localizes API fallbacks and import advice without altering raw errors or metadata', async () => {
    const raw = '后端原始错误 <request-123>'
    const envelope = {
      error: {
        message: raw,
        code: 'proxy_required',
        type: 'permission_error',
        checks: ['socks5'],
        details: { retry: true },
      },
      data: { id: 3 },
    }
    await i18n.changeLanguage('en-US')
    expect(normalizePanelError({}, 500).message).toBe('Request failed')
    expect(normalizePanelError(envelope, 403)).toEqual({
      message: raw,
      status: 403,
      code: 'proxy_required',
      type: 'permission_error',
      checks: ['socks5'],
      details: { retry: true },
      data: { id: 3 },
    })
    const error = new ApiError(raw, 400, 'proxy_required')
    expect(importErrorMessage(error)).toBe(
      'This slot has no healthy SOCKS5 proxy. Assign one before continuing. (' +
        raw +
        ')'
    )
    expect(
      importErrorMessage(new ApiError(raw, 400, 'credential_mode_unsupported'))
    ).toBe(raw)
    expect(importErrorMessage(new Error(raw))).toBe(raw)
    handleServerError(null)
    expect(toast.error).toHaveBeenLastCalledWith('Request failed')
    handleServerError(error)
    expect(toast.error).toHaveBeenLastCalledWith(raw)
    await i18n.changeLanguage('zh-TW')
    expect(normalizePanelError({}, 500).message).toBe('請求失敗')
    expect(importErrorMessage(error)).toBe(
      '此插槽未綁定可用的 SOCKS5，請先指派 Proxy 再操作。（' + raw + '）'
    )
    handleServerError(null)
    expect(toast.error).toHaveBeenLastCalledWith('請求失敗')
    expect(error).toMatchObject({
      message: raw,
      status: 400,
      code: 'proxy_required',
    })
  })

  it('maps HTTP fallback codes but preserves unknown reason phrases and structured errors', async () => {
    const storage = new Map<string, string>()
    vi.stubGlobal('location', {
      hostname: 'console.example',
      protocol: 'https:',
    })
    vi.stubGlobal('document', { cookie: '' })
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    })
    setSession('test-token')
    try {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
      await i18n.changeLanguage('en-US')
      fetchMock.mockResolvedValueOnce(
        new Response('{}', { status: 503, statusText: 'Service Unavailable' })
      )
      await expect(api('/api/panel/health')).rejects.toMatchObject({
        message: 'Service unavailable',
        status: 503,
      })
      await i18n.changeLanguage('zh-TW')
      fetchMock.mockResolvedValueOnce(
        new Response('{}', { status: 503, statusText: 'Service Unavailable' })
      )
      await expect(api('/api/panel/health')).rejects.toMatchObject({
        message: '服務暫時無法使用',
        status: 503,
      })
      fetchMock.mockResolvedValueOnce(
        new Response('{}', {
          status: 599,
          statusText: 'Custom upstream reason',
        })
      )
      await expect(api('/api/panel/health')).rejects.toMatchObject({
        message: 'Custom upstream reason',
        status: 599,
      })
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: { message: '原始上游錯誤', code: 'custom' },
          }),
          { status: 503 }
        )
      )
      await expect(api('/api/panel/health')).rejects.toMatchObject({
        message: '原始上游錯誤',
        status: 503,
        code: 'custom',
      })
    } finally {
      setSession('')
    }
  })

  it('keeps login payload and server messages unchanged across languages', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: '后端认证错误' } }), {
          status: 401,
        })
    )
    vi.stubGlobal('fetch', fetchMock)
    await i18n.changeLanguage('ja-JP')
    await expect(
      loginRequest({
        username: '管理员',
        password: 'user supplied',
        base: 'https://example.test',
      })
    ).rejects.toMatchObject({ message: '后端认证错误', status: 401 })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.test/api/panel/login',
      expect.objectContaining({
        body: '{"username":"管理员","password":"user supplied"}',
      })
    )
    fetchMock.mockRejectedValueOnce(new Error('network'))
    await expect(
      loginRequest({
        username: 'a',
        password: 'b',
        base: 'https://example.test',
      })
    ).rejects.toMatchObject({
      message:
        '認証サービスに接続できません: https://example.test/api/panel/login',
    })
  })
})

describe('persona UI and unchanged gateway contract', () => {
  it('translates parsing, line numbers and save notices while preserving the parser error', async () => {
    await i18n.changeLanguage('en-US')
    const parsed = parsePersonaTemplateLines(
      '// comment\nnull\n{"type":"text","text":"用户内容"}\n{"bad":'
    )
    expect(parsed.blocks).toEqual([{ type: 'text', text: '用户内容' }])
    expect(parsed.errors.map(({ line }) => line)).toEqual([2, 4])
    expect(formatLineError(parsed.errors[0])).toBe(
      'Line 2: Each line must be a JSON object'
    )
    let rawError = ''
    try {
      JSON.parse('{"bad":')
    } catch (error) {
      rawError = (error as Error).message
    }
    expect(parsed.errors[1].message).toBe('Invalid JSON: ' + rawError)
    expect(
      protocolPersonaSaveToast({ persona_preset: 'official_full' }, 2, {
        updated: 3,
      })
    ).toBe(
      'Saved · Full official prompt · 2 slots now follow global settings · System prompt hot-updated on 3 slots'
    )
    await i18n.changeLanguage('zh-TW')
    const translated = parsePersonaTemplateLines('null')
    expect(formatLineError(translated.errors[0])).toBe(
      '第 1 行：每行必須是一個 JSON 物件'
    )
    expect(
      protocolPersonaSaveToast({ persona_preset: 'official_full' }, 0, {
        updated: 0,
      })
    ).toBe('已儲存 · 完整官方提示詞 · system 提示詞的 kernel 設定已一致')
    expect(
      validatePersonaTemplate([{ type: 'wrapper', text: 'x' }], {
        overlay: true,
      })[0]
    ).toContain('{{overlay_body}}')
    expect(validatePersonaTemplate([{ text: '{{unknown}}' }])[0]).toContain(
      '{{unknown}}'
    )
  })

  it('matches actual gateway template bytes, whitelist IDs and validation outcomes in every language', async () => {
    const gateway = await import(
      /* @vite-ignore */ new URL(
        '../../../src/lib/identity/persona-template.mjs',
        import.meta.url
      ).href
    )
    const serialized = JSON.stringify([
      DEFAULT_PERSONA_TEMPLATES,
      DEFAULT_OVERLAY_TEMPLATES,
      DEFAULT_AGENT_STANDING,
    ])
    const samples = [
      { blocks: [], overlay: false },
      {
        blocks: [{ text: '{{ billing }} {{TIMEZONE}}', type: 'text' }],
        overlay: false,
      },
      {
        blocks: [{ text: '{{unknown}}', cache_control: false }],
        overlay: false,
      },
      { blocks: [{ type: 'text' }], overlay: false },
      { blocks: [{ text: 'a'.repeat(40001) }], overlay: false },
      {
        blocks: Array.from({ length: 25 }, () => ({ text: 'x' })),
        overlay: false,
      },
      {
        blocks: [
          { type: 'wrapper', text: '{{overlay_body}}' },
          { type: 'body', text: '{{standing}}' },
        ],
        overlay: true,
      },
      { blocks: [{ type: 'body', text: '{{overlay_body}}' }], overlay: true },
    ]
    for (const language of languages) {
      await i18n.changeLanguage(language)
      expect(
        JSON.stringify([
          DEFAULT_PERSONA_TEMPLATES,
          DEFAULT_OVERLAY_TEMPLATES,
          DEFAULT_AGENT_STANDING,
        ])
      ).toBe(serialized)
      expect(JSON.stringify(DEFAULT_PERSONA_TEMPLATES)).toBe(
        JSON.stringify(gateway.DEFAULT_PERSONA_TEMPLATES)
      )
      expect(JSON.stringify(DEFAULT_OVERLAY_TEMPLATES)).toBe(
        JSON.stringify(gateway.DEFAULT_OVERLAY_TEMPLATES)
      )
      expect(DEFAULT_AGENT_STANDING).toBe(gateway.DEFAULT_AGENT_STANDING)
      expect(PERSONA_TEMPLATE_VARS.map(([id]) => id)).toEqual(
        gateway.PERSONA_TEMPLATE_VARS.map(([id]: [string, string]) => id)
      )
      expect(OVERLAY_TEMPLATE_VARS.map(([id]) => id)).toEqual(
        gateway.OVERLAY_TEMPLATE_VARS.map(([id]: [string, string]) => id)
      )
      for (const preset of Object.values(DEFAULT_PERSONA_TEMPLATES)) {
        expect(stringifyPersonaTemplate(preset)).toBe(
          gateway.stringifyPersonaTemplate(preset)
        )
        expect(
          parsePersonaTemplateLines(stringifyPersonaTemplate(preset)).blocks
        ).toEqual(preset)
      }
      expect(
        templateOrFollowPreset(
          DEFAULT_PERSONA_TEMPLATES.official_full,
          DEFAULT_PERSONA_TEMPLATES,
          'official_full'
        )
      ).toEqual([])
      expect(
        renderOverlayTemplate(DEFAULT_OVERLAY_TEMPLATES.official, {
          standing: '用户提供的原始内容',
        })
      ).toBe(
        gateway.renderOverlayTemplate(DEFAULT_OVERLAY_TEMPLATES.official, {
          standing: '用户提供的原始内容',
        })
      )
      for (const { blocks, overlay } of samples) {
        expect(validatePersonaTemplate(blocks, { overlay }).length).toBe(
          gateway.validatePersonaTemplate(blocks, { overlay }).length
        )
      }
    }
  })
})
