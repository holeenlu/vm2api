import type { PanelRole } from './panel-auth'

export type PanelUser = {
  id: string
  username: string
  role: PanelRole
  vendor_id?: string | null
  vendor_name?: string | null
  vendor_tier?: 1 | 2 | null
  enabled: boolean
  balance?: number
  shared_balance?: boolean
  can_credit?: boolean
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
