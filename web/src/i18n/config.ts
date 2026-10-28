export const LOCALES = [
  { id: 'en-US', name: 'English' },
  { id: 'zh-CN', name: '简体中文' },
  { id: 'zh-TW', name: '繁體中文' },
  { id: 'ja-JP', name: '日本語' },
] as const
export type Locale = (typeof LOCALES)[number]['id']
export const DEFAULT_LOCALE: Locale = 'zh-CN'
export const LOCALE_STORAGE_KEY = 'tapmodels.locale'

export function normalizeLocale(value: string | null | undefined): Locale {
  const tag = value?.replace(/_/g, '-').toLowerCase() ?? ''
  if (tag === 'zh-tw' || tag.startsWith('zh-hant') || tag === 'zh-hk')
    return 'zh-TW'
  if (tag === 'zh' || tag.startsWith('zh-')) return 'zh-CN'
  if (tag === 'en' || tag.startsWith('en-')) return 'en-US'
  if (tag === 'ja' || tag.startsWith('ja-')) return 'ja-JP'
  return DEFAULT_LOCALE
}

export function initialLocale(): Locale {
  try {
    const saved = localStorage.getItem(LOCALE_STORAGE_KEY)
    if (saved) return normalizeLocale(saved)
  } catch {
    /* Browsers may disable storage. */
  }
  return normalizeLocale(
    typeof navigator === 'undefined' ? null : navigator.language
  )
}
