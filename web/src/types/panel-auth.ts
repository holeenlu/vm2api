export type PanelRole = 'super_admin' | 'admin' | 'user'

export type MeResponse = {
  user: string
  display_name?: string
  email?: string
  role: PanelRole
  views?: string[]
  capabilities?: string[]
  version?: string
}
