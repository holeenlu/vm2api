import type { PanelRole } from './panel-auth'

export type PanelUser = {
  id: string
  username: string
  role: PanelRole
  enabled: boolean
  balance?: number
  concurrency?: number
  rpm_limit?: number
  restrict_public_groups?: boolean
  groups?: {
    group_id: number
    rate_multiplier: number | null
    rpm_override?: number | null
  }[]
  created_at?: string
  last_login_at?: string
}

export type PanelUsersPayload = {
  items?: PanelUser[]
}
