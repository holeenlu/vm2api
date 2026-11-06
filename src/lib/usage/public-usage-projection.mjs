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
  'outbound_headers_source',
  'worker_envelope_headers',
  'hop_meta',
  'capture',
  'debug',
  'debug_log',
  'response_capture',
  'upstream_model',
  'response_model',
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
  'error_kind',
  'errorKind',
  'authorization_mode',
  'authorizationMode',
  'upstream_path',
  'upstreamEndpoint',
  'upstream_transport',
  'upstreamTransport',
  'upstream_error_json',
  'upstreamError',
  'websocket_close_code',
  'websocketCloseCode',
  'continuation_unavailable_reason',
  'continuationUnavailableReason',
  'upstream_connection_exit_reason',
  'upstreamConnectionExitReason',
  'retry_after_ms',
  'retryAfterMs',
  'via',
  'workspace',
  'owner_user_id',
  'costBreakdown',
  // 119：上游原始 token 只给超管核对账号成本，客户与管理员只看计费口径
  'upstream_input_tokens',
  'upstream_cache_read_tokens',
  'upstream_cache_creation_tokens',
  'upstream_cache_creation_5m_tokens',
  'upstream_cache_creation_1h_tokens',
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

export function projectUsage(value, role) {
  if (role === 'super_admin' || value == null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((v) => projectUsage(v, role))
  const result = {}
  for (const [key, raw] of Object.entries(value)) {
    if (PRIVATE_FIELDS.has(key) && (role === 'user' || !['users', 'userName', 'user_id', 'userId'].includes(key)))
      continue
    let field = raw
    if (role === 'user') {
      if (key === 'total_cost' && 'actual_cost' in value) field = value.actual_cost ?? null
      if (key === 'costUsd') field = value.actualCostUsd ?? null
      if (key === 'cost' && 'actualCost' in value) field = value.actualCost
      if (key === 'totalCost') field = value.totalActualCost ?? null
      if (['error_message', 'errorMessage', 'blockedReason'].includes(key) && field)
        field = '请求未完成，请根据错误代码处理，或向管理员提供请求 ID'
    }
    result[key] = projectUsage(field, role)
  }
  return result
}

export function projectPanelUsage(req, path, value) {
  const role = req?.apiKeyKind === 'master' ? 'super_admin' : req?.panelRole || 'user'
  if (/^\/api\/panel\/(request-logs|usage-logs|statistics)(\/|$)/.test(path) || /\/api-keys\/[^/]+\/stats$/.test(path))
    return projectUsage(value, role)
  return value
}
