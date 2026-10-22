/** Public usage DTOs. Internal diagnostics and financial access are independent permissions. */
const PRIVATE_FIELDS = new Set([
  'vm_id',
  'vmId',
  'vmName',
  'vm_name',
  'vm_owner_user_id',
  'account_id',
  'accountId',
  'account_name',
  'final_account_id',
  'providerName',
  'providerChain',
  'account_ids',
  'vm_ids',
  'vms',
  'accounts',
  'providers',
  'users',
  'userName',
  'user_id',
  'userId',
  'ip',
  'ip_address',
  'clientIp',
  'headers',
  'inbound_body',
  'outbound_body',
  'response_body',
  'upstream_body',
  'body',
  'inbound_summary',
  'outbound_summary',
  'outbound_headers',
  'hop_meta',
  'capture',
  'debug',
  'debug_log',
  'response_capture',
  'upstream_model',
  'actualResponseModel',
  'pricing_model',
  'modelMismatch',
  'model_mismatch',
  'intercept',
  'attempts',
  'specialSettings',
  'api_key_presented',
  'apiKeyPresented',
  'config',
  'outbound_session_id',
  'via',
  'workspace',
  'owner_user_id',
  'costBreakdown',
  'request_body_snapshot',
  'response',
  'cache_prefix',
  'cache_continuity',
  'classifier',
  'user_agent',
  'userAgent',
  'input_cost',
  'output_cost',
  'cache_read_cost',
  'cache_creation_cost',
  'web_search_cost',
  'groupCostMultiplier',
  'rate_multiplier',
  'pricingModel',
  'price_source',
  'price_version',
  'provider_chain',
  'sessionId',
])
function financial(key) {
  return /cost|price|balance|revenue|profit|multiplier|billing|reserved|quota_usd/i.test(key)
}
export function projectUsage(value, role) {
  if (role === 'admin' || value == null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((v) => projectUsage(v, role))
  const result = {}
  for (const [key, raw] of Object.entries(value)) {
    if (role === 'user' && PRIVATE_FIELDS.has(key)) continue
    if (
      role === 'super' &&
      (financial(key) ||
        [
          'headers',
          'inbound_body',
          'outbound_body',
          'response_body',
          'upstream_body',
          'inbound_summary',
          'outbound_summary',
          'outbound_headers',
          'api_key_presented',
          'apiKeyPresented',
          'body',
          'debug',
          'capture',
          'response_capture',
          'request_body_snapshot',
          'response',
          'cache_prefix',
          'cache_continuity',
          'classifier',
          'access_token',
          'refresh_token',
          'id_token',
          'password',
          'password_hash',
          'key_secret',
          'secret',
          'authorization',
          'credentials',
          'credential_json',
          'api_key',
        ].includes(key))
    )
      continue
    let field = raw
    if (role === 'user') {
      if (key === 'total_cost' && 'actual_cost' in value) field = value.actual_cost ?? null
      if (key === 'costUsd') field = value.actualCostUsd ?? null
      if (key === 'cost' && 'actualCost' in value) field = value.actualCost
      if (key === 'totalCost') field = value.totalActualCost ?? null
      if (['error_message', 'errorMessage', 'blockedReason'].includes(key) && field)
        field = '请求未完成，请根据错误代码处理，或向站长提供请求 ID'
    }
    result[key] = projectUsage(field, role)
  }
  return result
}
export function projectPanelUsage(req, path, value) {
  const role = req?.apiKeyKind === 'master' ? 'admin' : req?.panelRole || 'user'
  if (/^\/api\/panel\/(request-logs|usage-logs|statistics)(\/|$)/.test(path) || /\/api-keys\/[^/]+\/stats$/.test(path))
    return projectUsage(value, role)
  if (role === 'super') return projectUsage(value, role)
  return value
}
