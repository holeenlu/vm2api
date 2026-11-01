import { isCodexVm } from '../vm/vm-kind.mjs'

/** Pure key scope predicates.  Database refresh and scope construction stay in key-scope.mjs. */
export function vmGroupType(vm) {
  return isCodexVm(vm) ? 'openai' : 'anthropic'
}

export function groupScopeDenial(scope) {
  return scope?.error ? { code: scope.error, message: '分组不可用或当前用户没有使用权限' } : null
}

export function keyAllowsVm(scope, vm) {
  if (scope?.platform || !scope) return true
  if (scope.error || !(scope.allowed_vms || []).includes(vm?.id)) return false
  return scope.group_type === 'all' || vmGroupType(vm) === scope.group_type
}

export function keyAllowsEndpoint(scope, endpoint) {
  if (scope?.platform || !scope) return true
  if (scope.error || !(scope.allowed_endpoints || []).includes(endpoint?.id)) return false
  return scope.group_type === 'all' || String(endpoint?.platform || '') === scope.group_type
}

export function keyAllowsModel(scope, model) {
  return !scope?.error && (!scope?.models?.length || scope.models.includes(model))
}
