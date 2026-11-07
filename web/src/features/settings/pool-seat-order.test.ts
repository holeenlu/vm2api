import { i18n } from '@/i18n'
import type { Vm } from '@/types/panel-vm'
import { afterEach, describe, expect, it } from 'vitest'
import { predictSeatOrder } from './pool-seat-order'

afterEach(async () => {
  await i18n.changeLanguage('zh-CN')
})
describe('seat prediction is independent of translated labels', () => {
  it('preserves ranking, restrictions and manual-off state in every language', async () => {
    const vms: Vm[] = [
      { id: 'a', seats_used: 1, seats_max: 2, schedulable: true },
      { id: 'b', seats_used: 0, seats_max: 2, schedulable: true },
      { id: 'full', seats_used: 2, seats_max: 2, schedulable: true },
      {
        id: 'restricted',
        seats_used: 0,
        seats_max: 2,
        schedule_state: 'restricted',
      },
      {
        id: 'manual',
        seats_used: 0,
        seats_max: 2,
        schedulable: false,
        schedule_manual: true,
      },
      {
        id: 'quota',
        seats_used: 0,
        seats_max: 2,
        schedulable: false,
        schedule_disabled_reason: 'quota_5h',
      },
    ]
    const original = structuredClone(vms)
    for (const locale of ['en-US', 'zh-CN', 'zh-TW', 'ja-JP']) {
      await i18n.changeLanguage(locale)
      const rows = predictSeatOrder(vms, 'balanced')
      expect(rows.filter((r) => r.rank != null).map((r) => r.vm.id)).toEqual([
        'b',
        'a',
      ])
      expect(
        predictSeatOrder(vms, 'fill')
          .filter((r) => r.rank != null)
          .map((r) => r.vm.id)
      ).toEqual(['a', 'b'])
      expect(rows.filter((r) => !r.inPool).map((r) => r.vm.id)).toEqual([
        'manual',
        'quota',
        'restricted',
      ])
      expect(rows.find((r) => r.vm.id === 'full')).toMatchObject({
        inPool: true,
        rank: null,
        why: i18n.t('settings:full'),
      })
      expect(vms).toEqual(original)
    }
  })
})
