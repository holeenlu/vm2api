/**
 * Proxy command boundary. The callback is injected by the existing route
 * adapter so probing, quality, geo and lifecycle rules remain unchanged.
 */
export function createProxyCommandService(action) {
  if (typeof action !== 'function') throw new TypeError('proxy action is required')
  return Object.freeze({ action: (...args) => action(...args) })
}
