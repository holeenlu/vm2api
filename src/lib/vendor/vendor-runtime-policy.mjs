import { vendorGroupPlatforms } from './vendor-groups.mjs'
import { getDb, isDbOpen } from '../db/database.mjs'
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
  const account = db
    .prepare("SELECT * FROM vendor_resources WHERE id=? AND resource_type='account'")
    .get(vm.vendor_account_resource_id)
  if (!account) return 'vendor_archived'
  const config = parse(account.config_json)
  const resource = db
    .prepare("SELECT * FROM vendor_resources WHERE id=? AND vendor_id=? AND resource_type='vm'")
    .get(config.vm_resource_id, account.vendor_id)
  if (
    !resource ||
    parse(resource.config_json).runtime_vm_id !== vm.id ||
    [account.status, resource.status].includes('archived')
  )
    return 'vendor_archived'
  if (account.status !== 'active' || resource.status === 'paused') return 'vendor_paused'
  const vendor = db.prepare('SELECT * FROM vendors WHERE id=? AND deleted_at IS NULL').get(account.vendor_id)
  const parent = vendor?.parent_id
    ? db.prepare('SELECT * FROM vendors WHERE id=? AND deleted_at IS NULL').get(vendor.parent_id)
    : null
  if (!vendor || vendor.status !== 'active' || (vendor.parent_id && parent?.status !== 'active'))
    return 'vendor_disabled'
  const scopes = [vendor, ...(parent ? [parent] : [])]
  const platform = platformName(vm.platform || vm.family || config.platform)
  if (config.platform && platformName(config.platform) !== platform) return 'vendor_scope_revoked'
  const memberships = db
    .prepare(`SELECT r.group_id,g.platform,g.models_json,g.status,g.deleted_at,
    EXISTS(SELECT 1 FROM group_resources other WHERE other.group_id=r.group_id AND other.resource_kind<>'vm') AS mixed_kind
    FROM group_resources r LEFT JOIN groups g ON g.id=r.group_id WHERE r.resource_kind='vm' AND r.resource_id=?`)
    .all(vm.id)
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
      const allowedGroups = db
        .prepare("SELECT id,name FROM groups WHERE deleted_at IS NULL AND status='active'")
        .all()
        .filter((g) => allowed.includes(String(g.id)) || allowed.includes(g.name))
        .map((g) => String(g.id))
      if (!groups.length || groups.some((id) => !allowedGroups.includes(id))) return 'vendor_scope_revoked'
    }
  }
  if (config.proxy_id) {
    const proxy = db
      .prepare("SELECT status FROM vendor_resources WHERE id=? AND vendor_id=? AND resource_type='proxy'")
      .get(config.proxy_id, account.vendor_id)
    if (!proxy || proxy.status !== 'active') return 'vendor_proxy_disabled'
  }
  return null
}
