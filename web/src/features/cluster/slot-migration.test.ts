import { i18n } from '@/i18n'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrationMemoryOptions, migrationPhase } from './slot-migration'

// Phase assertions below check the zh-CN copy.
const originalLanguage = i18n.language
beforeAll(async () => {
  await i18n.changeLanguage('zh-CN')
})
afterAll(async () => {
  await i18n.changeLanguage(originalLanguage)
})

describe('slot migration controls', () => {
  it('offers only preservation/enlargement, never shrinking', () => {
    expect(migrationMemoryOptions('2g')).toEqual(['2g', '4g', '8g', '16g'])
    expect(migrationMemoryOptions('4g')).not.toContain('2g')
  })
  it('names rollback and transfer states explicitly', () => {
    expect(migrationPhase('copying')).toContain('校验')
    expect(migrationPhase('rolled_back')).toContain('已回滚')
    expect(migrationPhase('rollback_failed')).toContain('管理员')
  })
})
