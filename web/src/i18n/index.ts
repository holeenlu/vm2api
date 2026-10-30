import { createInstance, type Resource } from 'i18next'
import { initReactI18next } from 'react-i18next'
import { DEFAULT_LOCALE, initialLocale, LOCALES } from './config'

const modules = import.meta.glob<Record<string, unknown>>(
  './locales/*/*.json',
  {
    eager: true,
    import: 'default',
  }
)
export const resources: Resource = {}
for (const [path, messages] of Object.entries(modules)) {
  const [, language, namespace] = path.match(
    /\/locales\/([^/]+)\/([^/]+)\.json$/
  )!
  ;(resources[language] ??= {})[namespace] = messages
}

export const i18n = createInstance()
void i18n.use(initReactI18next).init({
  resources,
  lng: initialLocale(),
  supportedLngs: LOCALES.map(({ id }) => id),
  fallbackLng: DEFAULT_LOCALE,
  load: 'currentOnly',
  defaultNS: 'common',
  ns: Object.keys(resources[DEFAULT_LOCALE] ?? {}),
  initAsync: false,
  interpolation: { escapeValue: false },
  returnEmptyString: false,
  react: { useSuspense: false },
})

// Resolve at call time so notifications and formatters follow language changes.
export const t = i18n.t.bind(i18n)
export { LOCALES, normalizeLocale, type Locale } from './config'
