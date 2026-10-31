export type PanelRole = 'super_admin' | 'admin' | 'user' | 'vendor'

export type MeResponse = {
  user: string
  display_name?: string
  email?: string
  role: PanelRole
  views?: string[]
  capabilities?: string[]
  vendor?: {
    name: string
    role: 'vendor'
    tier: 1 | 2
    views: string[]
    capabilities: string[]
  } | null
  version?: string
}
