import { permitsIp } from './key-ip-rules.mjs'
import { ApiKeysRepo } from '../db/repos/api-keys-repo.mjs'
/** A managed key has one commercial group; resource selection is always read live. */
import { getDb, isDbOpen } from '../db/database.mjs'
import { GroupsRepo } from '../db/repos/groups-repo.mjs'
import { UsersRepo } from '../db/repos/users-repo.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'

export function vmGroupType(vm) {
  return isCodexVm(vm) ? 'openai' : 'anthropic'
}
export function keyScopeFromRecord(record, db = isDbOpen() ? getDb() : null) {
  if (record?.user_id && !record.group_id && db && new UsersRepo(db).getById(record.user_id)?.role === 'user')
    return { error: 'group_required', group_type: 'all', allowed_vms: [], allowed_endpoints: [], models: [] }
  if (!record?.group_id)
    return {
      key_id: record?.id,
      platform: true,
      group_id: null,
      group_type: 'all',
      allowed_vms: [],
      allowed_endpoints: [],
      models: [],
    }
  if (!db)
    return {
      group_id: record.group_id,
      group_type: 'all',
      allowed_vms: [],
      allowed_endpoints: [],
      models: [],
      error: 'group_unavailable',
    }
  const groups = new GroupsRepo(db)
  try {
    const user = record.user_id
      ? new UsersRepo(db).getById(record.user_id)
      : { id: null, role: 'super_admin', status: 'active' }
    if (record.status && record.status !== 'active') throw { code: 'api_key_disabled' }
    const { group, rate } = groups.access(user, record.group_id)
    const resources = groups.resources(group.id)
    return {
      key_id: record.id,
      group_id: group.id,
      group_type: group.platform === 'mixed' ? 'all' : group.platform === 'claude' ? 'anthropic' : group.platform,
      allowed_vms: resources.filter((r) => r.resource_kind === 'vm').map((r) => r.resource_id),
      allowed_endpoints: resources.filter((r) => r.resource_kind === 'api_endpoint').map((r) => r.resource_id),
      resource_priorities: Object.fromEntries(
        resources.filter((r) => r.resource_kind === 'vm').map((r) => [r.resource_id, r.priority]),
      ),
      models: group.models,
      rate_multiplier: rate,
      version: group.version,
    }
  } catch (error) {
    return {
      group_id: record.group_id,
      group_type: 'all',
      allowed_vms: [],
      allowed_endpoints: [],
      models: [],
      error: error.code || 'group_unavailable',
    }
  }
}
export function refreshAuthenticatedKey(record, db) {
  const current = record?.id && db ? new ApiKeysRepo(db).getById(record.id) : null
  if (!current || current.key_hash !== record.key_hash) return { error: 'invalid_api_key' }
  if (current.user_id && new UsersRepo(db).getById(current.user_id)?.status !== 'active')
    return { error: 'user_disabled' }
  // An in-flight admission must not silently change billing owner/backend/group.
  if (
    current.user_id !== record.user_id ||
    current.group_id !== record.group_id ||
    current.category !== record.category
  )
    return { error: 'api_key_scope_changed' }
  return { record: current }
}

export function keyScopeFromRequest(req) {
  if (!req || req.apiKeyKind === 'master')
    return { platform: true, group_type: 'all', allowed_vms: [], allowed_endpoints: [], models: [] }
  const db = isDbOpen() ? getDb() : null
  const live = db ? refreshAuthenticatedKey(req.apiKeyRecord, db) : { record: req.apiKeyRecord }
  const scope = keyScopeFromRecord(live.record, db)
  const unavailable =
    live.record &&
    ((live.record.status && live.record.status !== 'active') ||
      (live.record.expires_at && Date.parse(live.record.expires_at) <= Date.now()))
  const error =
    live.error ||
    (unavailable ? 'key_unavailable' : null) ||
    (live.record && !permitsIp(live.record, req.socket?.remoteAddress) ? 'ip_not_allowed' : null)
  if (error) return { ...scope, platform: false, error, allowed_vms: [], allowed_endpoints: [] }
  return {
    ...scope,
    key_hash: live.record?.key_hash,
    key_category: live.record?.category,
    client_ip: req.socket?.remoteAddress,
  }
}
export function groupScopeDenial(scope) {
  return scope?.error ? { code: scope.error, message: '分组不可用或当前用户没有使用权限' } : null
}
export function keyAllowsVm(scope, vm) {
  if (scope?.platform || !scope) return true
  if (scope.error || !(scope.allowed_vms || []).includes(vm?.id)) return false
  return scope.group_type === 'all' || vmGroupType(vm) === scope.group_type
}
export function keyAllowsModel(scope, model) {
  return !scope?.error && (!scope?.models?.length || scope.models.includes(model))
}

export function refreshKeyScope(scope) {
  if (!scope?.key_id || !isDbOpen()) return scope
  const record = new ApiKeysRepo(getDb()).getById(scope.key_id)
  if (!record || record.status !== 'active' || (record.expires_at && Date.parse(record.expires_at) <= Date.now()))
    return { ...scope, platform: false, error: 'key_unavailable', allowed_vms: [], allowed_endpoints: [] }
  if (record.user_id && new UsersRepo(getDb()).getById(record.user_id)?.status !== 'active')
    return { ...scope, platform: false, error: 'user_disabled', allowed_vms: [], allowed_endpoints: [] }
  if (scope.key_hash && record.key_hash !== scope.key_hash)
    return { ...scope, platform: false, error: 'key_unavailable', allowed_vms: [], allowed_endpoints: [] }
  if (scope.key_category && record.category !== scope.key_category)
    return { ...scope, platform: false, error: 'key_unavailable', allowed_vms: [], allowed_endpoints: [] }
  if (scope.client_ip && !permitsIp(record, scope.client_ip))
    return { ...scope, platform: false, error: 'ip_not_allowed', allowed_vms: [], allowed_endpoints: [] }
  if (Number(record.group_id) !== Number(scope.group_id))
    return { ...scope, platform: false, error: 'group_changed', allowed_vms: [], allowed_endpoints: [] }
  return {
    ...keyScopeFromRecord(record),
    key_hash: scope.key_hash,
    key_category: scope.key_category,
    client_ip: scope.client_ip,
  }
}

/** Commercial standalone search has no token-price contract yet. */
export function allowsStandaloneSearch(record, { api = false, groupType = 'all' } = {}) {
  return !record?.group_id && !api && ['openai', 'all'].includes(groupType)
}
