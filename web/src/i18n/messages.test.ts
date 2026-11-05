import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  initialLocale,
  LOCALES,
  LOCALE_STORAGE_KEY,
  normalizeLocale,
} from './config'
import { i18n, t } from './index'

afterEach(async () => {
  vi.unstubAllGlobals()
  await i18n.changeLanguage('zh-CN')
})

describe('console internationalization', () => {
  it('offers BCP 47 locales and migrates existing saved preferences', () => {
    expect(LOCALES.map(({ id }) => id)).toEqual([
      'en-US',
      'zh-CN',
      'zh-TW',
      'ja-JP',
    ])
    expect(normalizeLocale('zh_TW')).toBe('zh-TW')
    expect(normalizeLocale('zh-Hant-TW')).toBe('zh-TW')
    expect(normalizeLocale('en_GB')).toBe('en-US')
    expect(normalizeLocale('ja_JP')).toBe('ja-JP')
    expect(normalizeLocale('invalid')).toBe('zh-CN')
  })

  it('prefers a saved language over browser language', () => {
    const getItem = vi.fn(() => 'zh_TW')
    vi.stubGlobal('localStorage', { getItem })
    vi.stubGlobal('navigator', { language: 'en-US' })
    expect(initialLocale()).toBe('zh-TW')
    expect(getItem).toHaveBeenCalledWith(LOCALE_STORAGE_KEY)
  })

  it('detects browser language when storage is unavailable', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
    })
    vi.stubGlobal('navigator', { language: 'ja-JP' })
    expect(initialLocale()).toBe('ja-JP')
  })

  it('resolves non-component notifications at call time', async () => {
    await i18n.changeLanguage('en-US')
    expect(t('common:sessionExpired')).toBe('Your session has expired')
    await i18n.changeLanguage('zh-TW')
    expect(t('common:sessionExpired')).toBe('登入已過期')
    await i18n.changeLanguage('ja-JP')
    expect(t('common:sessionExpired')).toBe('ログインの有効期限が切れました')
  })

  it('preserves interpolated user data without attempting to translate it', async () => {
    await i18n.changeLanguage('en-US')
    expect(t('common:copyValue', { value: '用户自定义-model/<tag>' })).toBe(
      'Copy 用户自定义-model/<tag>'
    )
    await i18n.changeLanguage('zh-TW')
    expect(t('common:copyValue', { value: 'model/<tag>' })).toBe(
      '複製 model/<tag>'
    )
  })
})
