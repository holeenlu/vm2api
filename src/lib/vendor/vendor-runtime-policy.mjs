import { vendorGroupPlatforms } from './vendor-groups.mjs'
import { getDb, isDbOpen } from '../db/database.mjs'
import { accountResource, activeGroupNames, proxyStatus, vmGroupMemberships } from './repos/runtime-policy-repo.mjs'
import { getVendorRow } from './repos/vendors-repo.mjs'
import { getVendorVmResource } from './repos/resources-repo.mjs'
const parse = (value) => {
  try {
    return JSON.parse(value || '{}')
  } catch {
    return {}
  }
}
const platformName = (value) => ({ claude: 'anthropic', codex: 'openai' })[value] || value

// Consult authoritative supplier state when selecting a slot. A cached vm.json
// or a later credential refresh must not revive paused/revoked supply.
export function vendorRuntimeBlock(vm, db = isDbOpen() ? getDb() : null) {
  if (!vm?.vendor_account_resource_id) return null
  if (!db) return 'vendor_policy_unavailable'
  const account = accountResource(db, vm.vendor_account_resource_id)
  if (!account) return 'vendor_archived'
  const config = parse(account.config_json)
  const resource = getVendorVmResource(db, config.vm_resource_id, account.vendor_id)
  if (
    !resource ||
    parse(resource.config_json).runtime_vm_id !== vm.id ||
    [account.status, resource.status].includes('archived')
  )
    return 'vendor_archived'
  if (account.status !== 'active' || resource.status === 'paused') return 'vendor_paused'
  const vendor = getVendorRow(db, account.vendor_id)
  const parent = vendor?.parent_id ? getVendorRow(db, vendor.parent_id) : null
  if (!vendor || vendor.status !== 'active' || (vendor.parent_id && parent?.status !== 'active'))
    return 'vendor_disabled'
  const scopes = [vendor, ...(parent ? [parent] : [])]
  const platform = platformName(vm.platform || vm.family || config.platform)
  if (config.platform && platformName(config.platform) !== platform) return 'vendor_scope_revoked'
  const memberships = vmGroupMemberships(db, vm.id)
  if (
    !memberships.length ||
    memberships.some(
      (g) => g.status !== 'active' || g.deleted_at || g.mixed_kind || !vendorGroupPlatforms(g).includes(platform),
    )
  )
    return 'vendor_scope_revoked'
  const groups = memberships.map((g) => String(g.group_id))
  for (const scope of scopes) {
    const platforms = parse(scope.platforms_json)
    if (platforms.length && !platforms.map(platformName).includes(platform)) return 'vendor_scope_revoked'
    const allowed = parse(scope.groups_json)
    if (allowed.length) {
      const allowedGroups = activeGroupNames(db)
        .filter((g) => allowed.includes(String(g.id)) || allowed.includes(g.name))
        .map((g) => String(g.id))
      if (!groups.length || groups.some((id) => !allowedGroups.includes(id))) return 'vendor_scope_revoked'
    }
  }
  if (config.proxy_id) {
    const proxy = proxyStatus(db, config.proxy_id, account.vendor_id)
    if (!proxy || proxy.status !== 'active') return 'vendor_proxy_disabled'
  }
  return null
}
