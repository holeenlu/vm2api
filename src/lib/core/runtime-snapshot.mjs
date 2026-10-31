/**
 * Immutable request-time view of routing facts.
 *
 * routing.json remains the durable source. This holder freezes the normalized
 * object for requests already entering the data plane, so a panel update
 * cannot change their routing halfway through.
 */

const MIN_REVISION = 1

function clone(value) {
  return structuredClone(value == null ? {} : value)
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  for (const child of Object.values(value)) deepFreeze(child, seen)
  return Object.freeze(value)
}

function normalizeRevision(value) {
  const revision = Number(value)
  return Number.isSafeInteger(revision) && revision >= MIN_REVISION ? revision : MIN_REVISION
}

function makeSnapshot(routingConfig, configRevision) {
  return deepFreeze({
    config_revision: normalizeRevision(configRevision),
    routing: clone(routingConfig),
    published_at: new Date().toISOString(),
  })
}

export function createRuntimeSnapshot({ routingConfig = {}, configRevision = MIN_REVISION } = {}) {
  let current = makeSnapshot(routingConfig, configRevision)

  return {
    acquire() {
      return current
    },

    revision() {
      return current.config_revision
    },

    routing() {
      return current.routing
    },

    publish(nextRoutingConfig, nextRevision) {
      current = makeSnapshot(nextRoutingConfig, nextRevision)
      return current
    },
  }
}
