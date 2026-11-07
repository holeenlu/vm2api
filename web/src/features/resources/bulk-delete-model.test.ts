import type { Vm } from '@/types/panel-vm'
import { describe, expect, it } from 'vitest'
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

describe('batch delete plan', () => {
  it('counts both kinds and keeps the picked order', () => {
    const targets = [slot('vm-1'), account('gw-1'), slot('vm-2')]
    const plan = planBulkDelete(targets, [slot('vm-1'), slot('vm-2')])
    expect(plan.steps.map((step) => step.vm.id)).toEqual([
      'vm-1',
      'gw-1',
      'vm-2',
    ])
    expect(plan.vmCount).toBe(2)
    expect(plan.gatewayCount).toBe(1)
    expect(plan.skipped).toEqual([])
    expect(plan.steps.every((step) => !step.switchTo)).toBe(true)
  })

  it('deletes the active slot last and hands the pointer to a surviving slot', () => {
    const active = slot('vm-1', { active: true })
    const vms = [active, slot('vm-2'), slot('vm-3')]
    const plan = planBulkDelete([active, slot('vm-2')], vms)
    expect(plan.steps.map((step) => step.vm.id)).toEqual(['vm-2', 'vm-1'])
    // vm-2 is being deleted too, so it must not be picked as the replacement.
    expect(plan.steps[1].switchTo).toBe('vm-3')
  })

  it('skips an active slot when the surviving slots cannot take over', () => {
    const active = slot('vm-1', { active: true })
    const vms = [active, slot('vm-2', { has_token: false })]
    const plan = planBulkDelete([active], vms)
    expect(plan.steps).toEqual([])
    expect(plan.skipped.map((vm) => vm.id)).toEqual(['vm-1'])
    expect(plan.vmCount).toBe(0)
  })

  it('clears the whole fleet when the active slot has no survivor left', () => {
    const active = slot('vm-1', { active: true })
    const vms = [active, slot('vm-2')]
    const plan = planBulkDelete([active, slot('vm-2')], vms)
    expect(plan.steps.map((step) => step.vm.id)).toEqual(['vm-2', 'vm-1'])
    expect(plan.steps[1].switchTo).toBeUndefined()
    expect(plan.skipped).toEqual([])
  })

  it('deletes a sole active slot without a replacement', () => {
    const active = slot('vm-1', { active: true })
    const plan = planBulkDelete([active], [active])
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0].switchTo).toBeUndefined()
    expect(plan.skipped).toEqual([])
  })
})
