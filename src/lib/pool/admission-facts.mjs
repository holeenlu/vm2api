/** Stable read-only admission result used by scheduler adapters and tests. */
export function normalizeAdmissionFacts(result = {}) {
  const source = result && typeof result === 'object' ? result : {}
  const ok = source.ok === true
  const detail = source.detail && typeof source.detail === 'object' ? Object.freeze({ ...source.detail }) : null
  return Object.freeze({
    ok,
    reason: source.reason == null ? null : String(source.reason),
    detail,
    retry_at: source.retry_at ?? source.retryAt ?? detail?.reset_at ?? null,
    warning: source.warning ?? null,
  })
}

export function admissionDenied(result, reason = null) {
  const facts = normalizeAdmissionFacts(result)
  return !facts.ok && (!reason || facts.reason === reason)
}
