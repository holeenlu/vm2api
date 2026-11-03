const WINDOW_MS = 10 * 60_000
const RECOVERY_THRESHOLD = 2
const COOLDOWN_MS = 60_000

const states = new Map()

function keyOf(sessionId, model) {
  const session = String(sessionId || '').trim()
  const name = String(model || '').trim()
  return session && name ? `${session}\0${name}` : ''
}

function liveState(key, now = Date.now()) {
  const state = states.get(key)
  if (!state) return null
  if (now - state.lastAt > WINDOW_MS && !state.recoveryUsed) {
    states.delete(key)
    return null
  }
  if (state.cooldownUntil && state.cooldownUntil <= now) {
    states.delete(key)
    return null
  }
  return state
}

/** Remaining session cooldown in ms; 0 when the session may run. */
export function codexSessionOverloadRetryAfterMs(sessionId, model, now = Date.now()) {
  const state = liveState(keyOf(sessionId, model), now)
  return state?.cooldownUntil > now ? state.cooldownUntil - now : 0
}

export function noteCodexSessionOverload(sessionId, model, now = Date.now()) {
  const key = keyOf(sessionId, model)
  if (!key) return { count: 0, recoveryDue: false, stop: false }
  const current = liveState(key, now)
  const state = current || { count: 0, firstAt: now, lastAt: now, recoveryUsed: false, cooldownUntil: 0 }
  if (now - state.firstAt > WINDOW_MS) {
    state.count = 0
    state.firstAt = now
    state.recoveryUsed = false
  }
  state.count += 1
  state.lastAt = now
  states.set(key, state)
  return {
    count: state.count,
    recoveryDue: state.count >= RECOVERY_THRESHOLD && !state.recoveryUsed,
    stop: Boolean(state.cooldownUntil && state.cooldownUntil > now),
  }
}

export function codexSessionRecoveryDue(sessionId, model, now = Date.now()) {
  const state = liveState(keyOf(sessionId, model), now)
  return Boolean(state && state.count >= RECOVERY_THRESHOLD && !state.recoveryUsed)
}

export function markCodexSessionRecovery(sessionId, model, now = Date.now()) {
  const key = keyOf(sessionId, model)
  const state = liveState(key, now)
  if (!state) return false
  state.recoveryUsed = true
  states.set(key, state)
  return true
}

export function tripCodexSessionOverload(sessionId, model, now = Date.now()) {
  const key = keyOf(sessionId, model)
  const state = liveState(key, now) || { count: RECOVERY_THRESHOLD, firstAt: now, lastAt: now, recoveryUsed: true }
  state.recoveryUsed = true
  state.cooldownUntil = now + COOLDOWN_MS
  state.lastAt = now
  states.set(key, state)
  return { retryAfterMs: COOLDOWN_MS, cooldownUntil: state.cooldownUntil }
}

export function clearCodexSessionOverload(sessionId, model) {
  states.delete(keyOf(sessionId, model))
}

export function resetCodexSessionOverload() {
  states.clear()
}

export const CODEX_SESSION_OVERLOAD_THRESHOLD = RECOVERY_THRESHOLD
export const CODEX_SESSION_OVERLOAD_COOLDOWN_MS = COOLDOWN_MS
