export type PanelRole = 'admin' | 'super' | 'user'

export type MeResponse = {
  user: string
  display_name?: string
  email?: string
  role: PanelRole
  views?: string[]
  capabilities?: string[]
  version?: string
}
