/** Historical infrastructure provenance and compatibility exports. */
import {
  PLATFORM_SCOPE,
  normalizeOwnerId,
  vmOwnerId,
  ownerScopeFromApiKey,
  ownerScopeFromRequest,
  vmMatchesOwnerScope,
} from './resource-scope.mjs'

export {
  PLATFORM_SCOPE,
  normalizeOwnerId,
  vmOwnerId,
  ownerScopeFromApiKey,
  ownerScopeFromRequest,
  vmMatchesOwnerScope,
} from './resource-scope.mjs'

export const VM_ORIGIN = {
  platform: 'platform',
  adminAssigned: 'admin_assigned',
  userCreated: 'user_created',
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

export function filterVmsForPanel(vms, { role } = {}) {
  return role === 'super_admin' ? vms : []
}

export function canBindProxyToVm(proxy, vm, { role } = {}) {
  const pOwner = proxyOwnerId(proxy)
  const vOwner = vmOwnerId(vm)
  const r = String(role || '')
    .trim()
    .toLowerCase()
  if (r !== 'super_admin') return false
  // admin/super: user proxies stay off the platform pool
  if (pOwner && !vOwner) return false
  return true
}
