export type PanelRole = 'super_admin' | 'admin' | 'user' | 'vendor'

/** 账号资源能力，与后端 src/lib/admin/resource-permissions.mjs 一致。 */
export type ResourcePermission =
  'resources.read' | 'resources.create' | 'resources.edit' | 'resources.manage'

export type MeResponse = {
  user: string
  display_name?: string
  email?: string
  role: PanelRole
  views?: string[]
  capabilities?: string[]
  resource_permissions?: ResourcePermission[]
  vendor?: {
    name: string
    role: 'vendor'
    tier: 1 | 2
    views: string[]
    capabilities: string[]
  } | null
  version?: string
}
