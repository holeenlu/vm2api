import { i18n, t } from '@/i18n'
import type { Vm } from '@/types/panel-vm'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { beforeAll, describe, expect, it } from 'vitest'
import { BulkDeleteSummary } from './bulk-delete-dialog'
import { planBulkDelete } from './bulk-delete-model'

const slot = (id: string, extra: Partial<Vm> = {}): Vm =>
  ({
    id,
    platform: 'anthropic',
    family: 'claude',
    has_token: true,
    status: 'running',
    schedulable: true,
    ...extra,
  }) as Vm

const account = (id: string): Vm =>
  ({ id, platform: 'openai', family: 'codex', runtime_type: 'gateway' }) as Vm

function render(targets: Vm[], vms: Vm[]) {
  const plan = planBulkDelete(targets, vms)
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <BulkDeleteSummary
        plan={plan}
        done={0}
        total={plan.steps.length}
        busy={false}
        failures={[]}
      />
    </I18nextProvider>
  )
}

describe('batch delete confirmation', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('zh-CN')
  })

  it('names both kinds of target and keeps each warning', () => {
    const html = render(
      [slot('vm-1'), account('gw-1')],
      [slot('vm-1'), slot('vm-2')]
    )
    expect(html).toContain(t('vm:vmBulk.deleteVmCount', { count: 1 }))
    expect(html).toContain(t('vm:vmBulk.deleteGatewayCount', { count: 1 }))
    expect(html).toContain(t('vm:sync14008PermanentSlotDelete'))
    expect(html).toContain(t('common:codexDeleteBulkConfirm'))
    // 二次确认不再要求输入 ID
    expect(html).not.toContain('<input')
  })

  it('warns before the active pointer moves and when a slot is skipped', () => {
    const active = slot('vm-1', { active: true })
    const moved = render([active], [active, slot('vm-2')])
    expect(moved).toContain(
      t('vm:vmBulk.deleteSwitchActive', { id: 'vm-1', to: 'vm-2' })
    )
    const stuck = render([active], [active, slot('vm-2', { has_token: false })])
    expect(stuck).toContain(t('vm:vmBulk.deleteSkipped', { names: 'vm-1' }))
    expect(stuck).not.toContain(t('vm:vmBulk.deleteVmCount', { count: 1 }))
  })

  it('shows progress while running and lists what failed', () => {
    const plan = planBulkDelete([slot('vm-1')], [slot('vm-1'), slot('vm-2')])
    const running = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <BulkDeleteSummary
          plan={plan}
          done={1}
          total={3}
          busy
          failures={[{ id: 'vm-9', name: 'vm-9', message: 'boom' }]}
        />
      </I18nextProvider>
    )
    expect(running).toContain(
      t('vm:vmBulk.deleteProgress', { done: 1, total: 3 })
    )
    expect(running).toContain(
      t('vm:vmBulk.deleteFailedItem', { name: 'vm-9', message: 'boom' })
    )
  })
})
