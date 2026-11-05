/** Attempt facts with monotonic send-state and downstream-commit semantics. */
export const ATTEMPT_SEND_STATES = Object.freeze(['not_sent', 'ambiguous', 'sent'])
const RANK = Object.freeze({ not_sent: 0, ambiguous: 1, sent: 2 })

function state(value, fallback = 'not_sent') {
  const normalized = String(value || '').trim()
  return ATTEMPT_SEND_STATES.includes(normalized) ? normalized : fallback
}

function text(value) {
  const result = String(value ?? '').trim()
  return result || null
}

export function createAttemptFacts(input = {}) {
  const source = input && typeof input === 'object' ? input : {}
  return Object.freeze({
    request_id: text(source.request_id),
    attempt_no: Number.isSafeInteger(source.attempt_no) ? source.attempt_no : null,
    vm_id: text(source.vm_id),
    account_id: text(source.account_id),
    model: text(source.model),
    selection_reason: text(source.selection_reason),
    send_state: state(source.send_state),
    downstream_committed: source.downstream_committed === true,
    upstream_status: Number.isSafeInteger(source.upstream_status) ? source.upstream_status : null,
    terminal_state: text(source.terminal_state),
  })
}

export function advanceAttemptFacts(current = {}, next = {}) {
  const before = createAttemptFacts(current)
  const update = createAttemptFacts({ ...before, ...next })
  const sendState = RANK[update.send_state] >= RANK[before.send_state] ? update.send_state : before.send_state
  return Object.freeze({
    ...update,
    send_state: sendState,
    downstream_committed: before.downstream_committed || update.downstream_committed,
  })
}
