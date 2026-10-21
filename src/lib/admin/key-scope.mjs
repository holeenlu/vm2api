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
    return { platform: true, group_id: null, group_type: 'all', allowed_vms: [], allowed_endpoints: [], models: [] }
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
      : { id: null, role: 'admin', status: 'active' }
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
export function keyScopeFromRequest(req) {
  if (!req || req.apiKeyKind === 'master')
    return { platform: true, group_type: 'all', allowed_vms: [], allowed_endpoints: [], models: [] }
  return keyScopeFromRecord(req.apiKeyRecord)
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
    return { ...scope, error: 'key_unavailable', allowed_vms: [], allowed_endpoints: [] }
  if (Number(record.group_id) !== Number(scope.group_id))
    return { ...scope, error: 'group_changed', allowed_vms: [], allowed_endpoints: [] }
  return keyScopeFromRecord(record)
}
