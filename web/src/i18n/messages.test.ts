import { describe, expect, it } from 'vitest'
import { LOCALES, normalizeLocale, translate } from './messages'

describe('console language preferences', () => {
  it('offers the four requested locales and preserves unknown text', () => {
    expect(LOCALES.map((v) => v.id)).toEqual([
      'en_US',
      'zh_CN',
      'zh_TW',
      'ja_JP',
    ])
    expect(normalizeLocale('invalid')).toBe('zh_CN')
    expect(translate('en_US', '个人资料')).toBe('My profile')
    expect(translate('zh_TW', '个人资料')).toBe('個人資料')
    expect(translate('ja_JP', '个人资料')).toBe('プロフィール')
    expect(translate('en_US', 'user-defined-model-id')).toBe(
      'user-defined-model-id'
    )
  })
})
