/**
 * Pure normalizers for request-log columns captured from the inbound request.
 * Kept dependency-free so protocol handlers can import them without the DB.
 */

export const REASONING_EFFORTS = new Set(['none', 'minimal', 'auto', 'low', 'medium', 'high', 'xhigh', 'max'])

/**
 * Requested thinking effort across inbound dialects: Anthropic
 * `output_config.effort`, OpenAI chat `reasoning_effort`, Responses
 * `reasoning.effort`. Message-level `output_config.effort` (pi mid-conversation
 * control) wins over the top-level field so the log matches the current turn.
 * Unknown values are dropped so the column stays a closed set.
 */
export function reasoningEffortOf(inbound) {
  if (!inbound || typeof inbound !== 'object') return null
  let raw = inbound.output_config?.effort ?? inbound.reasoning_effort ?? inbound.reasoning?.effort
  if (Array.isArray(inbound.messages)) {
    for (let i = inbound.messages.length - 1; i >= 0; i--) {
      const effort = inbound.messages[i]?.output_config?.effort
      if (effort != null && effort !== '') {
        raw = effort
        break
      }
    }
  }
  if (typeof raw !== 'string') return null
  const effort = raw.trim().toLowerCase()
  return REASONING_EFFORTS.has(effort) ? effort : null
}

const SESSION_ID_MAX = 200

/** Caller session ids come from client headers/bodies; cap them before they hit an index. */
export function sessionIdForLog(value) {
  const s = String(value ?? '').trim()
  return s ? s.slice(0, SESSION_ID_MAX) : null
}

/** Codex upstream_model is the outbound/billing model, not the response echo
 * (VM kernel, its Gateway fallback, and the Gateway Worker path).
 * Legacy non-Codex writers already record the response in upstream_model.
 * Keep that fallback until those retained rows/writers use response_model.
 */
export const OUTBOUND_MODEL_VIAS = ['codex-kernel', 'codex-kernel-fallback', 'gateway-worker']

export function responseModelForLog(row) {
  const raw = row.response_model ?? (OUTBOUND_MODEL_VIAS.includes(row.via) ? null : row.upstream_model)
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null
}

/** VM 槽位 Claude 内核实际请求的上游路径（Anthropic Messages）。 */
export const ANTHROPIC_MESSAGES_PATH = '/v1/messages'
/** Codex 槽位与 Gateway 原生通道的 Responses 上游路径。 */
export const CODEX_RESPONSES_PATH = '/backend-api/codex/responses'

/** 上游请求路径：只留 pathname（不含主机与查询串，避免泄露凭据参数），限长 200。 */
export function upstreamPathForLog(value) {
  const raw = String(value || '').trim()
  // 只认完整 URL 或以 / 开头的路径；相对片段不是可信的上游端点
  if (!raw.startsWith('/') && !/^(https?|wss?):\/\//i.test(raw)) return null
  try {
    return new URL(raw, 'http://local').pathname.slice(0, 200)
  } catch {
    return null
  }
}

export function transportForLog(value) {
  const v = String(value || '').toLowerCase()
  if (v === 'websocket' || v === 'ws') return 'websocket'
  if (v === 'http') return 'http'
  return null
}

/** Gateway Worker 经响应头回报本次实际发往上游的路径与传输方式。 */
export function applyGatewayUpstream(logBag, headers = {}) {
  const path = upstreamPathForLog(headers['x-kin-gateway-upstream-path'])
  if (path) logBag.upstream_path = path
  const transport = transportForLog(headers['x-kin-gateway-upstream-transport'])
  if (transport) logBag.upstream_transport = transport
}
