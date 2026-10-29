import { useEffect, type ReactNode } from 'react'
import { i18n, normalizeLocale, type Locale } from '@/i18n'
import { LOCALE_STORAGE_KEY } from '@/i18n/config'
import { I18nextProvider, useTranslation } from 'react-i18next'

export function LocaleProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    const sync = (language: string) => {
      const locale = normalizeLocale(language)
      document.documentElement.lang = locale
      try {
        localStorage.setItem(LOCALE_STORAGE_KEY, locale)
      } catch {
        /* storage unavailable */
      }
    }
    sync(i18n.resolvedLanguage ?? i18n.language)
    i18n.on('languageChanged', sync)
    return () => {
      i18n.off('languageChanged', sync)
    }
  }, [])
  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
}

export function useLocale() {
  const { i18n: instance } = useTranslation()
  return {
    locale: normalizeLocale(instance.resolvedLanguage ?? instance.language),
    setLocale: (locale: Locale) => {
      void instance.changeLanguage(locale)
    },
  }
}
