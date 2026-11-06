import type { PanelRole, ResourcePermission } from './panel-auth'

export type PanelUser = {
  id: string
  username: string
  company?: string
  parent_user_id?: string | null
  parent_username?: string | null
  role: PanelRole
  vendor_id?: string | null
  vendor_name?: string | null
  vendor_tier?: 1 | 2 | null
  vendor_create_child?: boolean
  vendor_child_limit?: number
  enabled: boolean
  balance?: number
  shared_balance?: boolean
  can_credit?: boolean
  concurrency?: number
  rpm_limit?: number
  restrict_public_groups?: boolean
  resource_permissions?: ResourcePermission[]
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
