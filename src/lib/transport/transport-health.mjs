/** Stable transport health projection; preserves unknown values as null. */
export function projectTransportHealth(input = {}) {
  const status = Number.isSafeInteger(input.status) ? input.status : null
  const reachable = typeof input.reachable === 'boolean' ? input.reachable : null
  const processUp = typeof input.process_up === 'boolean' ? input.process_up : null
  const healthy = typeof input.healthy === 'boolean' ? input.healthy : null
  const ready = reachable != null && processUp != null && healthy != null ? reachable && processUp && healthy : null
  return Object.freeze({
    status,
    reachable,
    process_up: processUp,
    healthy,
    ready,
    error_code: input.error_code || null,
  })
}
