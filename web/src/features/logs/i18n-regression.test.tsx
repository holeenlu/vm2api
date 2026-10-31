import { i18n, resources, LOCALES } from '@/i18n'
import type { UsageLogRow } from '@/types/panel-usage-logs'
import type { VmProxySnap } from '@/types/panel-vm'
import { renderToStaticMarkup } from 'react-dom/server'
import { Trans } from 'react-i18next'
import { afterEach, describe, expect, it } from 'vitest'
import {
  regionGroups,
  regionLabel,
  proxyInRegion,
} from '@/features/proxies/proxy-region'
import {
  probeOneOutcome,
  disableConfirmText,
} from '@/features/proxies/proxy-results'
import {
  PROXY_HEALTH_LABEL,
  proxyInFilter,
} from '@/features/proxies/proxy-sort'
import { STAGES, accountInScope } from '@/features/risk/model'
import { LOGS_TABLE_COLUMNS } from './column-visibility'
import { formatTimestamp, formatCountdown, formatAgo } from './display-time'
import { LatencyBreakdownBar } from './log-detail/latency-breakdown-bar'
import {
  formatShortDistance,
  errorClassLabel,
  hasFastMode,
  cacheWriteSplit,
} from './log-display'
import { filtersToApi } from './search'

const initialLanguage = i18n.language
afterEach(async () => {
  await i18n.changeLanguage(initialLanguage)
})
const namespaces = ['logs', 'proxies', 'risk', 'overview'] as const
const placeholders = (value: string) =>
  [...value.matchAll(/{{\s*([^},]+)(?:,[^}]*)?}}/g)]
    .map((m) => m[1].trim())
    .sort()

describe('four-language UI contracts', () => {
  it.each(namespaces)(
    '%s has matching keys, interpolation variables, and rich-text tags',
    (ns) => {
      const source = resources['en-US'][ns] as Record<string, string>
      for (const { id } of LOCALES) {
        const translated = resources[id][ns] as Record<string, string>
        expect(Object.keys(translated).sort()).toEqual(
          Object.keys(source).sort()
        )
        for (const [key, text] of Object.entries(source)) {
          expect(translated[key].trim(), id + ':' + ns + ':' + key).not.toBe('')
          expect(placeholders(translated[key]), id + ':' + key).toEqual(
            placeholders(text)
          )
          const tags = (s: string) =>
            s.match(/<\/?[A-Za-z][^>]*>/g)?.sort() ?? []
          expect(tags(translated[key]), id + ':' + key).toEqual(tags(text))
        }
      }
    }
  )

  it('resolves imported labels and geography again after each language change', async () => {
    const expected = {
      'en-US': [
        'Healthy',
        'Distillation',
        'Authentication',
        'Japan',
        'Queue wait',
      ],
      'zh-CN': ['正常', '蒸馏', '认证', '日本', '排队等待'],
      'zh-TW': ['正常', '蒸餾', '驗證', '日本', '佇列等待'],
      'ja-JP': ['正常', '蒸留検知', '認証', '日本', 'キュー待機'],
    }
    for (const { id } of LOCALES) {
      await i18n.changeLanguage(id)
      const [health, stage, auth, country, wait] = expected[id]
      expect(PROXY_HEALTH_LABEL.ok).toBe(health)
      expect(STAGES[0].name).toBe(stage)
      expect(errorClassLabel('auth')).toBe(auth)
      expect(regionLabel('JP')).toBe(country)
      expect(
        renderToStaticMarkup(
          <LatencyBreakdownBar waitMs={100} ttftMs={300} durationMs={1000} />
        )
      ).toContain(wait)
    }
  })

  it('uses count plurals and preserves raw diagnostic interpolation', async () => {
    await i18n.changeLanguage('en-US')
    expect(i18n.t('logs:loadedRecords', { count: 1 })).toBe('Loaded 1 record')
    expect(i18n.t('logs:loadedRecords', { count: 2 })).toBe('Loaded 2 records')
    const now = new Date('2026-10-21T12:00:00Z')
    expect(formatShortDistance(new Date(now.getTime() - 1000), now)).toBe(
      '1 second ago'
    )
    expect(formatShortDistance(new Date(now.getTime() - 2000), now)).toBe(
      '2 seconds ago'
    )
    const raw = '<upstream> 原始错误 & ECONNREFUSED'
    for (const { id } of LOCALES) {
      await i18n.changeLanguage(id)
      expect(probeOneOutcome({ probe: { ok: false, error: raw } })).toEqual({
        level: 'error',
        text: i18n.t('proxies:connectionFailedReason', { reason: raw }),
      })
      expect(
        probeOneOutcome({ probe: { ok: false, error: raw } }).text
      ).toContain(raw)
      expect(disableConfirmText(2)).toContain('2')
      expect(errorClassLabel('new_vendor_code', raw)).toBe(raw)
    }
  })

  it('renders rich text without translating the protocol header', async () => {
    for (const { id } of LOCALES) {
      await i18n.changeLanguage(id)
      const html = renderToStaticMarkup(
        <Trans
          ns='logs'
          i18nKey='debugSamplingHelp'
          components={{ code: <code /> }}
        />
      )
      expect(html).toContain('<code>x-kin-debug: 1</code>')
      expect(html).not.toContain('debugSamplingHelp')
    }
  })

  it('keeps filter values, column IDs, routing, and cache accounting unchanged', async () => {
    const proxy: VmProxySnap = {
      id: 'px-1',
      host: '192.0.2.1',
      status: 'ok',
      enabled: true,
      bind_limit: 3,
      bound_vm_ids: ['vm-1'],
      geo: { country_code: 'JP', city: 'Tokyo' },
    }
    const filters = {
      model: '模型-id',
      keyId: 'key_unchanged',
      sessionId: '会话-raw',
      minRetry: 2,
    }
    const expectedFilters = filtersToApi(filters, [])
    const ids = LOGS_TABLE_COLUMNS.map(({ id }) => id)
    for (const { id } of LOCALES) {
      await i18n.changeLanguage(id)
      expect(LOGS_TABLE_COLUMNS.map(({ id }) => id)).toEqual(ids)
      expect(ids).toContain('tokens')
      expect(filtersToApi(filters, [])).toEqual(expectedFilters)
      expect(
        hasFastMode({ speed: 'fast', serviceTier: null } as UsageLogRow)
      ).toBe(true)
      expect(proxyInFilter(proxy, 'open', 3)).toBe(true)
      expect(proxyInRegion(proxy, { country: 'JP', city: 'Tokyo' })).toBe(true)
      const [group] = regionGroups([proxy], 3, () => true)
      expect({
        country: group.country,
        total: group.total,
        free: group.free,
      }).toEqual({ country: 'JP', total: 1, free: 2 })
      expect(
        cacheWriteSplit({ total: 300, fiveM: 0, oneH: 0, ttl: '1h' })
      ).toEqual({ fiveM: 0, oneH: 300 })
      expect(
        accountInScope(
          { account_ids: ['USER@example.test'], account_platform_plans: [] },
          {
            id: 'vm-1',
            email: 'user@example.test',
            name: 'slot-1',
            platform: 'claude',
            plan_type: 'max',
            schedulable: true,
          }
        )
      ).toBe(true)
    }
  })

  it('localizes dates and durations without changing timestamps or timezone', async () => {
    const ms = Date.parse('2026-10-21T12:34:56Z')
    for (const { id } of LOCALES) {
      await i18n.changeLanguage(id)
      expect(formatTimestamp(ms)).toBe(new Date(ms).toLocaleString(id))
      expect(formatTimestamp('invalid timestamp')).toBe('invalid timestamp')
      expect(formatCountdown(60_000)).toBe(
        new Intl.NumberFormat(id, {
          style: 'unit',
          unit: 'minute',
          unitDisplay: 'short',
          maximumFractionDigits: 0,
        }).format(1)
      )
      expect(formatAgo(new Date(ms - 120_000).toISOString(), ms)).toBe(
        new Intl.RelativeTimeFormat(id, {
          numeric: 'always',
          style: 'short',
        }).format(-2, 'minute')
      )
    }
  })
})
