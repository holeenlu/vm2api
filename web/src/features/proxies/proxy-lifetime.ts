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
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
export function expiryISO(date: string) {
  return date ? new Date(`${date}T23:59:59`).toISOString() : null
}
