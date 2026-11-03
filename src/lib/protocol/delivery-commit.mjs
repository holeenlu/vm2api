/** Monotonic downstream delivery state. A committed response is terminal. */
export const DELIVERY_STATES = Object.freeze(['pending', 'ambiguous', 'committed'])
const RANK = Object.freeze({ pending: 0, ambiguous: 1, committed: 2 })

function normalize(value) {
  const state = String(value || '').trim()
  return DELIVERY_STATES.includes(state) ? state : 'pending'
}

export function advanceDeliveryCommit(current, next) {
  const before = normalize(current)
  const requested = normalize(next)
  return RANK[requested] >= RANK[before] ? requested : before
}

export function isDeliveryCommitted(state) {
  return normalize(state) === 'committed'
}
