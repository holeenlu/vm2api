import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { i18n } from '@/i18n'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { describe, expect, it } from 'vitest'
import type { BpsSettings, BpsView } from './accounts-model'
import { BpsSection, linkBpsSettings } from './bps-section'

const settings: BpsSettings = {
  enabled: true,
  models: ['gpt-5.5'],
  omit_unsupported_tools: false,
  ignore_encrypted_content: false,
  auto_disable_on_403: true,
  auto_recover_on_403: false,
  recovery_interval_minutes: 60,
  auto_move_on_403: false,
  target_group_id: null,
  cache_creation_as_input: true,
}
const endpoints = { drafts: '/d', draftApiBase: '/d', import: '/i', bps: '/b' }

function render(view: BpsView) {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={new QueryClient()}>
        <BpsSection
          view={view}
          endpoints={endpoints}
          groups={[]}
          value={view.bps || null}
          onChange={() => {}}
          onChanged={async () => {}}
        />
      </QueryClientProvider>
    </I18nextProvider>
  )
}

describe('BpsSection', () => {
  it('asks for authorization before showing BPS settings', () => {
    const html = render({ id: 'a', name: 'A' })
    expect(html).toContain(i18n.t('common:codexBpsStatus.none'))
    expect(html).toContain(i18n.t('common:codexBpsAuthorize'))
    expect(html).not.toContain(i18n.t('common:codexBpsModels'))
  })

  it('shows status, revoke and settings once authorized', () => {
    const html = render({
      id: 'a',
      name: 'A',
      bps: settings,
      bps_grant: { revision: 1, authorized_at: '2026-11-04T00:00:00Z' },
      bps_state: 'blocked',
      bps_blocked_at: null,
    })
    expect(html).toContain(i18n.t('common:codexBpsStatus.blocked'))
    expect(html).toContain(i18n.t('common:codexBpsRevoke'))
    expect(html).toContain(i18n.t('common:codexBpsModels'))
    expect(html).toContain('gpt-5.5')
  })

  it('lists recent recovery probes with their token usage', () => {
    const html = render({
      id: 'a',
      name: 'A',
      bps_grant: { revision: 1, authorized_at: '2026-11-04T00:00:00Z' },
      bps_probes: [
        {
          probed_at: '2026-11-04T00:00:00Z',
          model: 'gpt-probe',
          ok: false,
          status: 403,
          error_code: 'account_deactivated',
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
          duration_ms: 10,
        },
      ],
    })
    expect(html).toContain(i18n.t('common:codexBpsProbes'))
    expect(html).toContain('gpt-probe')
    expect(html).toContain('account_deactivated')
  })
})

describe('BPS settings rendered from the account schema', () => {
  it('renders the schema fields and links the 403 options', () => {
    const html = render({
      id: 'a',
      name: 'A',
      bps: settings,
      bps_grant: { revision: 1, authorized_at: '2026-11-04T00:00:00Z' },
    })
    expect(html).toContain('data-testid="bps-settings"')
    expect(html).toContain('data-schema-field="enabled"')
    expect(html).toContain('data-schema-field="auto_disable_on_403"')
    expect(html).not.toContain('data-schema-field="recovery_interval_minutes"')
    expect(
      linkBpsSettings(
        { ...settings, auto_disable_on_403: false, auto_recover_on_403: true },
        settings
      ).auto_recover_on_403
    ).toBe(false)
    // 关闭 403 自动停用时自动移组一并关闭（移组以停用为触发）
    expect(
      linkBpsSettings(
        {
          ...settings,
          auto_disable_on_403: false,
          auto_move_on_403: true,
          target_group_id: 3,
        },
        settings
      )
    ).toMatchObject({ auto_move_on_403: false, target_group_id: null })
    expect(
      linkBpsSettings({ ...settings, auto_move_on_403: true }, settings)
        .target_group_id
    ).toBe(0)
    expect(
      linkBpsSettings(
        { ...settings, auto_move_on_403: false, target_group_id: 5 },
        settings
      ).target_group_id
    ).toBe(null)
  })
})
