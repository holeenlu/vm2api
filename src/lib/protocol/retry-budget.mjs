/** Bounded retry budget shared by protocol and failover adapters. */
function integer(value, fallback, min = 0, max = 64) {
  const number = Number(value)
  if (!Number.isSafeInteger(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

export function createRetryBudget(input = {}) {
  const maxAttempts = integer(input.maxAttempts ?? input.max_attempts, 1, 1)
  const maxSwitches = integer(input.maxSwitches ?? input.max_switches, maxAttempts, 0)
  const deadlineAt = Number.isFinite(Number(input.deadlineAt ?? input.deadline_at))
    ? Number(input.deadlineAt ?? input.deadline_at)
    : null
  let attempts = 0
  let switches = 0
  return {
    get attempts() {
      return attempts
    },
    get switches() {
      return switches
    },
    maxAttempts,
    maxSwitches,
    deadlineAt,
    canAttempt(now = Date.now()) {
      return attempts < maxAttempts && (deadlineAt == null || now < deadlineAt)
    },
    consumeAttempt() {
      if (!this.canAttempt()) return false
      attempts += 1
      return true
    },
    canSwitch() {
      return switches < maxSwitches
    },
    consumeSwitch() {
      if (!this.canSwitch()) return false
      switches += 1
      return true
    },
    snapshot() {
      return Object.freeze({ attempts, switches, maxAttempts, maxSwitches, deadlineAt })
    },
  }
}
