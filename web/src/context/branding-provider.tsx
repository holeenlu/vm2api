import { createContext, useContext, useEffect, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { panelFetch } from '@/lib/api'

export type Branding = {
  name: string
  tagline: string
  logo_url: string
  favicon_url: string
}
export const DEFAULT_BRANDING: Branding = {
  name: 'tapmodels',
  tagline: '管理台',
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
  const query = useQuery(brandingQuery())
  const value = query.data || DEFAULT_BRANDING
  useEffect(() => {
    document.title = [value.name, value.tagline].filter(Boolean).join(' · ')
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
  }, [value])
  return <Context.Provider value={value}>{children}</Context.Provider>
}
export const useBranding = () => useContext(Context)
