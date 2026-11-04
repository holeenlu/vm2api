/** Replay permission is independent of delivery and of HTTP error classification. */
export function codexSendState(result) {
  if (['not_sent', 'ambiguous', 'sent'].includes(result?.sendState)) return result.sendState
  if (result?.upstreamExecutions === 0) return 'not_sent'
  return Number(result?.status) > 0 ? 'sent' : 'ambiguous'
}

export function canReplayCodex(result) {
  if (!result || result.ok || result.committed || result.executionEffectObserved || result.replayBarrierReached)
    return false
  if (['group_unavailable', 'response_not_portable', 'codex_retry_deadline'].includes(result.body?.error?.code))
    return false
  const state = codexSendState(result)
  if (state === 'ambiguous') return false
  if (state === 'not_sent' || result.replaySafe === true || result.upstreamExecutions === 0) return true
  // Explicit upstream rejection is a different fact from a timeout after send.
  const status = Number(result.status)
  if ([401, 403, 429].includes(status)) return true
  const code = String(result.body?.error?.code || '')
  if (/^(usage_limit_reached|upstream_auth|no_credential)$/.test(code)) return true
  return (
    [500, 502, 503, 529].includes(status) &&
    /^(no_capacity|overloaded|overloaded_error|server_is_overloaded)$/.test(code)
  )
}

export function codexFeedbackKind(result) {
  if (result?.ok && result?.terminalState !== 'incomplete') return 'succeeded'
  if (codexSendState(result) !== 'sent' || result?.transportError || result?.terminalState === 'cancelled') return null
  const status = Number(result?.status)
  const code = String(result?.body?.error?.code || '')
  if (
    /content_policy|usage_policy|refusal|tool_arguments|group_unavailable/.test(code) ||
    (status !== 401 && /invalid_request/.test(code))
  )
    return null
  if (status === 429 || status === 529 || /overload|no_capacity/.test(code)) return 'capacity_rejected'
  return [401, 403, 500, 502, 503, 504].includes(status) ? 'failed' : null
}
