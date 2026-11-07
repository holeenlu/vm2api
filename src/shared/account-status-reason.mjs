const SPECIFIC_ACCOUNT_REASONS = new Set([
  'oauth_revoked',
  'oauth_invalid_grant',
  'oauth_no_refresh',
  'oauth_cleared',
  'oauth_expired',
  'credential_refresh_failed',
  'credential_blocked',
  'organization_disabled',
  'terms_not_accepted',
  'proxy_required',
  'proxy_desynced',
  'proxy_unavailable',
])

/** Convert upstream account prose into the stable code shared by both panels. */
export function normalizeAccountReason(value) {
  const text = String(value || '').trim()
  if (!text) return null
  const lower = text.toLowerCase()
  if (/oauth access token has been revoked|token has been revoked|oauth_revoked|invalid_grant/.test(lower)) {
    return /invalid_grant/.test(lower) && !/revoked/.test(lower) ? 'oauth_invalid_grant' : 'oauth_revoked'
  }
  if (
    /oauth authentication is currently not allowed|organization.*(?:blocked|banned|disabled)|organization_disabled/.test(
      lower,
    )
  ) {
    return 'organization_disabled'
  }
  if (/oauth access token has expired|re-authenticate to continue|oauth_expired/.test(lower)) {
    return 'oauth_expired'
  }
  if (
    /consumer terms and privacy policy|accept them in claude\.ai|terms.*privacy.*claude\.ai|terms_not_accepted/.test(
      lower,
    )
  ) {
    return 'terms_not_accepted'
  }
  if (
    /代理不可用|proxy.*(?:unavailable|error)|no upstream response before the cli['’]?s model validation deadline/.test(
      lower,
    )
  ) {
    return 'proxy_unavailable'
  }
  if (SPECIFIC_ACCOUNT_REASONS.has(text) || /^[a-z][a-z0-9_:-]{1,80}$/.test(text)) return text
  return null
}

export function isSpecificAccountReason(value) {
  return SPECIFIC_ACCOUNT_REASONS.has(String(value || '').trim())
}
