import { systemDate, systemDateTimeToIso } from '@/lib/system-time'

export type ProxyLifetime = {
  expires_at: string
  fallback_mode: 'none' | 'proxy' | 'direct'
  backup_proxy_id: string
}
export const EMPTY_LIFETIME: ProxyLifetime = {
  expires_at: '',
  fallback_mode: 'none',
  backup_proxy_id: '',
}
export function expiryDate(iso?: string | null) {
  if (!iso || !Number.isFinite(Date.parse(iso))) return ''
  return systemDate(iso)
}
export function expiryISO(date: string) {
  return date ? systemDateTimeToIso(`${date}T23:59:59`) : null
}
