/**
 * Historical infrastructure provenance, and explicit platform diagnostic scope.
 * Commercial authorization is handled by key-scope and group_resources.
 */

export const VM_ORIGIN = {
  platform: 'platform',
  adminAssigned: 'admin_assigned',
  userCreated: 'user_created',
}

export const PLATFORM_SCOPE = Object.freeze({ type: 'platform' })

export function normalizeOwnerId(id) {
  const s = String(id || '').trim()
  return s || null
}

export function vmOwnerId(vm) {
  return normalizeOwnerId(vm?.owner_user_id)
}

export function vmOriginOf(vm) {
  const origin = String(vm?.origin || '').trim()
  if (origin === VM_ORIGIN.adminAssigned || origin === VM_ORIGIN.userCreated || origin === VM_ORIGIN.platform) {
    return origin
  }
  return vmOwnerId(vm) ? VM_ORIGIN.adminAssigned : VM_ORIGIN.platform
}

export function proxyOwnerId(proxy) {
  return normalizeOwnerId(proxy?.owner_user_id)
}

export function ownerScopeFromApiKey(record, { apiKeyKind = null, ownerRole = null } = {}) {
  if (record?.group_id) return { type: 'any' }
  if (apiKeyKind === 'master') return PLATFORM_SCOPE
  const userId = normalizeOwnerId(record?.user_id)
  if (!userId) return PLATFORM_SCOPE
  const role = String(ownerRole || '')
    .trim()
    .toLowerCase()
  if (role === 'admin' || role === 'super') return PLATFORM_SCOPE
  return { type: 'any' } // Commercial group scope, not infrastructure ownership, authorizes customers.
}

export function ownerScopeFromRequest(req, usersRepo = null) {
  const rec = req?.apiKeyRecord || null
  let ownerRole = null
  const userId = normalizeOwnerId(rec?.user_id)
  if (userId && usersRepo?.getById) {
    try {
      ownerRole = usersRepo.getById(userId)?.role || null
    } catch {
      ownerRole = null
    }
  }
  return ownerScopeFromApiKey(rec, { apiKeyKind: req?.apiKeyKind, ownerRole })
}

export function vmMatchesOwnerScope(vm, scope = PLATFORM_SCOPE) {
  const type = scope?.type || 'platform'
  if (type === 'any') return true
  const owner = vmOwnerId(vm)
  if (type === 'platform') return !owner
  if (type === 'user') return owner === normalizeOwnerId(scope.userId)
  return false
}

export function filterVmsForPanel(vms, { role } = {}) {
  return ['admin', 'super'].includes(role) ? vms : []
}

export function canBindProxyToVm(proxy, vm, { role } = {}) {
  const pOwner = proxyOwnerId(proxy)
  const vOwner = vmOwnerId(vm)
  const r = String(role || '')
    .trim()
    .toLowerCase()
  if (r !== 'admin' && r !== 'super') return false
  // admin/super: user proxies stay off the platform pool
  if (pOwner && !vOwner) return false
  return true
}
