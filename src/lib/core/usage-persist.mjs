/**
 * Trim the upstream usage snapshot before it is written to usage_json.
 *
 * Upstream returns `usage.attribution.items`: a per-assistant-message token
 * attribution map keyed by message id. It grows with the conversation and has
 * no upper bound, so a long session rewrites a larger copy on every turn.
 * Stored verbatim it reached 502 KB in one row (43 KB average) and accounted
 * for 99% of usage_json bytes in both billing_charges and request_attempts.
 *
 * Billing reads token counts and the panel renders token counts; no reader
 * anywhere consumes attribution, so it is dropped rather than summarised.
 * The copy is shallow on purpose — this runs on the request path, and the
 * point is to write less, not to walk the object again.
 */
export function usageForStorage(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return usage
  if (!('attribution' in usage)) return usage
  const { attribution: _dropped, ...kept } = usage
  return kept
}
