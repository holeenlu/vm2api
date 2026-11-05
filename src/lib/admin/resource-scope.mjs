/**
 * Infrastructure ownership scope.
 *
 * Commercial group authorization remains in key-scope/groups. This module
 * only decides which platform-owned resources a request may observe or use.
 */
export const PLATFORM_SCOPE = Object.freeze({ type: 'platform' })

export function normalizeOwnerId(id) {
  const s = String(id || '').trim()
  return s || null
}

export function vmOwnerId(vm) {
  return normalizeOwnerId(vm?.owner_user_id)
}

export function ownerScopeFromApiKey(record, { apiKeyKind = null, ownerRole = null } = {}) {
  if (record?.group_id) return { type: 'any' }
  if (apiKeyKind === 'master') return PLATFORM_SCOPE
  const userId = normalizeOwnerId(record?.user_id)
  if (!userId) return PLATFORM_SCOPE
  const role = String(ownerRole || '')
    .trim()
    .toLowerCase()
  if (role === 'super_admin') return PLATFORM_SCOPE
  return { type: 'any' }
}

export function ownerScopeFromRequest(req, usersRepo = null) {
  const rec = req?.apiKeyRecord || null
  if (!rec && req?.panelUser && req?.apiKeyKind !== 'master') {
    const role = String(req.panelRole || '')
      .trim()
      .toLowerCase()
    if (role === 'super_admin') return PLATFORM_SCOPE
    const userId = normalizeOwnerId(req.panelUserId)
    return userId ? { type: 'user', userId } : { type: 'none' }
  }
  let ownerRole = null
  const userId = normalizeOwnerId(rec?.user_id)
  if (userId && usersRepo?.getByIdSync) {
    try {
      // R6 临时同步出口，B7 删除：推理热路径同步判定 Key 所属用户角色
      ownerRole = usersRepo.getByIdSync(userId)?.role || null
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
