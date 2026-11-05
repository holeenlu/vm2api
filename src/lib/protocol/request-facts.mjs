/** Immutable request facts captured at the protocol boundary. */
function text(value) {
  const result = String(value ?? '').trim()
  return result || null
}

function timestamp(value, fallback = null) {
  if (value == null || value === '') return fallback
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value))
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback
}

export function createRequestFacts(input = {}, { now = new Date() } = {}) {
  const source = input && typeof input === 'object' ? input : {}
  const receivedAt = timestamp(source.received_at ?? source.started_at, timestamp(now))
  return Object.freeze({
    request_id: text(source.request_id ?? source.id),
    protocol: text(source.protocol),
    method: text(source.method)?.toUpperCase() || null,
    path: text(source.path ?? source.route),
    model: text(source.model ?? source.requested_model),
    owner_user_id: text(source.owner_user_id ?? source.user_id),
    api_key_id: text(source.api_key_id),
    group_id: source.group_id == null ? null : String(source.group_id),
    received_at: receivedAt,
    client_request_id: text(source.client_request_id ?? source.session_id),
    stream: source.stream === true,
  })
}
