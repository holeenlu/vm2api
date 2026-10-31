import { i18n } from '@/i18n'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { AccountWorkbench } from './account-workbench'
import { type Resource } from './portal-model'

const account: Resource = {
  id: 'account-id',
  vendor_id: 'supplier-id',
  name: 'Example account',
  resource_type: 'account',
  status: 'active',
  created_at: '2026-10-30T00:00:00Z',
  config: { platform: 'anthropic', auth_method: 'oauth' },
  telemetry: {
    vm_id: 'vm-example',
    state: 'available',
    email: 'account@example.test',
    utilization_5h: 0.25,
    utilization_7d: 0.75,
    reset_5h: '2026-10-30T05:00:00Z',
    reset_7d: '2026-11-06T01:00:00Z',
    today_cost: 0,
    total_cost: 25.5,
    total_tokens: 123456,
    requests: 25,
    cache_hit_rate: 0.8,
    inflight: 2,
    max_concurrency: 5,
    rpm: 3,
  },
}

afterEach(async () => {
  await i18n.changeLanguage('zh-CN')
})
const render = (rows: Resource[], admin = false) =>
  renderToStaticMarkup(
    <AccountWorkbench
      rows={rows}
      admin={admin}
      apiBase={admin ? '/api/admin/vendors/accounts' : '/api/vendor/accounts'}
      vendorId={admin ? 'super-admin' : 'supplier-id'}
      vendorName='Example supplier'
      scope='all'
      scopes={[
        { id: 'all', name: 'All' },
        { id: 'supplier-id', name: 'Example supplier' },
      ]}
      loading={false}
      error={null}
      busy={false}
      updatedAt={0}
      canManage
      canCreate
      canViewUsage
      refreshSeconds={60}
      onScope={() => {}}
      onRefreshSeconds={() => {}}
      onRefresh={() => {}}
      onCreate={() => {}}
      onDetail={() => {}}
      onAuthorize={() => {}}
      onToggle={async () => true}
      onDelete={async () => {}}
      onVmSettings={admin ? () => {} : undefined}
    />
  )
describe('shared supplier and super administrator account workbench', () => {
  it('hides supplier ownership from supplier users while keeping it for admins', async () => {
    await i18n.changeLanguage('en-US')
    const supplier = render([account]),
      admin = render([account], true)
    const table = (html: string) => html.match(/<table[\s\S]*?<\/table>/)?.[0]
    expect(table(supplier)).not.toContain('>Supplier<')
    expect(table(admin)).toContain('>Supplier<')
    for (const html of [supplier, admin])
      for (const text of [
        'Example account',
        'Claude',
        '25%',
        '75%',
        '$25.50',
        '80.0%',
      ])
        expect(html).toContain(text)
    expect(table(supplier)).toContain(
      'aria-label="Copy account account@example.test"'
    )
    expect(table(supplier)).not.toContain('Example supplier')
    expect(table(admin)).toContain('Example supplier')
  })
  it('does not invent quota or cost data for unknown accounts', async () => {
    await i18n.changeLanguage('en-US')
    const html = render([{ ...account, telemetry: undefined }])
    const body = html.match(/<tbody[\s\S]*?<\/tbody>/)?.[0] || ''
    expect(body).not.toContain('$0.00')
    expect(body.replace(/<[^>]*>/g, ' ')).not.toContain('0%')
    expect(body).toContain('—')
    expect(html).not.toContain('>null<')
  })

  it('shows the abnormal reason on the account status hover target', async () => {
    await i18n.changeLanguage('en-US')
    const html = render([
      {
        ...account,
        telemetry: {
          ...account.telemetry!,
          vm_id: 'vm-example',
          state: 'error',
          schedulable: false,
          unschedulable_reason: 'oauth_revoked',
          reason_detail: 'OAuth access token has been revoked.',
        },
      },
    ])
    expect(html).toContain('data-slot="tooltip-trigger"')
    expect(html).toContain('title="OAuth access token has been revoked."')
    expect(html).toContain('>Abnormal<')
    expect(html).not.toContain('Abnormal:')
  })
})
