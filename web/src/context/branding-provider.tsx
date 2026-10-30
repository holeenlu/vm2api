import { createContext, useContext, useEffect, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { normalizeLocale, type Locale } from '@/i18n'
import { useTranslation } from 'react-i18next'
import { panelFetch } from '@/lib/api'

export type Branding = {
  name: string
  tagline: string
  taglines?: Partial<Record<Locale, string>>
  logo_url: string
  favicon_url: string
}
export const DEFAULT_BRANDING: Branding = {
  name: 'tapmodels',
  tagline:
    /* i18n-exempt "管理台" -- Persisted default branding value; display uses common:console while editable custom text stays raw. */ '管理台',
  taglines: {
    'zh-CN': '管理台',
    'zh-TW': '管理台',
    'en-US': 'Console',
    'ja-JP': '管理コンソール',
  },
  logo_url: '',
  favicon_url: '',
}
export const brandingQuery = () => ({
  queryKey: ['site', 'branding'],
  queryFn: async (): Promise<Branding> => {
    const response = await panelFetch('/api/panel/site')
    if (!response.ok) throw new Error(response.statusText)
    const body = await response.json()
    return body.data ?? body
  },
  staleTime: 300000,
})
const Context = createContext(DEFAULT_BRANDING)
export function BrandingProvider({ children }: { children: ReactNode }) {
  const { t, i18n } = useTranslation('common')
  const query = useQuery(brandingQuery())
  const value = query.data || DEFAULT_BRANDING
  const locale = normalizeLocale(i18n.resolvedLanguage || i18n.language)
  const tagline =
    value.taglines?.[locale] ||
    (value.tagline !== DEFAULT_BRANDING.tagline ? value.tagline : t('console'))
  useEffect(() => {
    document.title = [value.name, tagline].filter(Boolean).join(' · ')
    document
      .querySelectorAll<HTMLLinkElement>(
        'link[rel="icon"], link[rel="apple-touch-icon"]'
      )
      .forEach((icon) => {
        icon.dataset.defaultHref ??= icon.getAttribute('href') || '/favicon.svg'
        icon.href =
          value.favicon_url || value.logo_url || icon.dataset.defaultHref
        icon.removeAttribute('type')
        icon.removeAttribute('sizes')
      })
  }, [value, tagline])
  return <Context.Provider value={value}>{children}</Context.Provider>
}
export const useBranding = () => useContext(Context)
