import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react'
import {
  LOCALES,
  normalizeLocale,
  translate,
  type Locale,
} from '@/i18n/messages'

const Context = createContext({
  locale: 'zh_CN' as Locale,
  setLocale: (() => {}) as (locale: Locale) => void,
  t: (s: string) => s,
})
export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>(() => {
    try {
      return normalizeLocale(localStorage.getItem('tapmodels.locale'))
    } catch {
      return 'zh_CN'
    }
  })
  useEffect(() => {
    document.documentElement.lang = LOCALES.find((l) => l.id === locale)!.lang
    try {
      localStorage.setItem('tapmodels.locale', locale)
    } catch {
      /* storage unavailable */
    }
  }, [locale])
  return (
    <Context.Provider
      value={{ locale, setLocale, t: (s) => translate(locale, s) }}
    >
      {children}
    </Context.Provider>
  )
}
export const useLocale = () => useContext(Context)
