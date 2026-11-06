import { i18n } from '@/i18n'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  ControlPlaneStatusCard,
  type ControlPlaneStatus,
} from './control-plane-status'

const base: ControlPlaneStatus = {
  switches: [
    {
      name: 'KIN_EXECUTOR_EVENTS',
      value: 'off',
      valid: false,
      given: 'primry',
    },
    { name: 'KIN_REFRESH_LEASE', value: 'on', valid: true },
    { name: 'KIN_CREDENTIAL_CUSTODY', value: 'control', valid: true },
    {
      name: 'KIN_REDIS_URL',
      value: 'configured',
      valid: true,
      scope: 'control_plane_env',
    },
  ],
  events: {
    since_hours: 24,
    by_status: { matched: 3, applied: 2, recorded: 1, diff: 1, pending: 4 },
    attempts: { failed: 0, retry: 2 },
    lag: [{ instance_id: 'gw-1', lag: 5 }],
  },
  refresh_leases: {
    by_state: { held: 1, ambiguous: 1, expired: 2 },
    ambiguous: [
      {
        account_resource_id: 'gw-01',
        grant_kind: 'native',
        holder_instance_id: 'gw-1',
        expires_at: '2026-11-06T02:00:00.000Z',
      },
    ],
    denials: {
      since: '2026-11-06T00:00:00.000Z',
      counts: { lease_held: 2, stale_token: 1 },
      recent: [],
    },
  },
}

const render = (status: ControlPlaneStatus) =>
  renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <ControlPlaneStatusCard status={status} />
    </I18nextProvider>
  )

describe('ControlPlaneStatusCard (audit U8)', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('zh-CN')
  })

  it('shows effective switches, flags invalid values and summarises inbox and leases', () => {
    const html = render(base)
    expect(html).toContain('KIN_EXECUTOR_EVENTS</code> = off')
    expect(html).toContain('配置值“primry”无效')
    expect(html).toContain('已处理 6')
    expect(html).toContain('差异 1')
    expect(html).toContain('未拉取 gw-1 5 条')
    expect(html).toContain('持有中 1 · 结果不明 1 · 已过期 2')
    expect(html).toContain('同机 Worker 继承')
    expect(html).toContain('已被持有 2')
    expect(html).toContain('令牌已被轮换 1')
    expect(html).toContain('gw-01 · native 在 gw-1 上结果不明')
  })

  it('marks unreadable sections without hiding the switches', () => {
    const html = render({ ...base, events: null, refresh_leases: null })
    expect(html).toContain('KIN_REFRESH_LEASE</code> = on')
    expect(html.match(/读取失败/g)?.length).toBe(2)
  })
})
