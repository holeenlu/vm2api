// Polled views share one snapshot of an expensive read. Within `freshMs` of its start a snapshot is reused
// as is; until `maxAgeMs` it still answers at once while a newer one loads in the background; older or
// missing, callers wait for the load. A failed load keeps the previous snapshot and is retried next call.
export function createSharedSnapshot(load, { freshMs = 10_000, maxAgeMs = 60_000, now = Date.now } = {}) {
  let value
  let at = Number.NEGATIVE_INFINITY
  let pending = null
  const refresh = () => {
    const started = now()
    // Settle state in the same callback that resolves callers, so a caller re-reading right away sees it.
    const run = Promise.resolve()
      .then(load)
      .then(
        (next) => {
          value = next
          at = started
          if (pending === run) pending = null
          return next
        },
        (error) => {
          if (pending === run) pending = null
          throw error
        },
      )
    pending = run
    // Background refreshes have no awaiting caller; their failure is not an unhandled rejection.
    run.catch(() => {})
    return run
  }
  return () => {
    const age = now() - at
    if (age >= freshMs && !pending) refresh()
    return age < maxAgeMs ? Promise.resolve(value) : pending
  }
}
