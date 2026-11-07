/** Stable account row projection shared by portal and panel readers. */
export function projectVendorAccount(value) {
  if (!value || typeof value !== 'object') return value
  return Object.freeze({
    ...value,
    config: value.config && typeof value.config === 'object' ? Object.freeze({ ...value.config }) : value.config,
    groups: Array.isArray(value.groups)
      ? Object.freeze(value.groups.map((group) => Object.freeze({ ...group })))
      : value.groups,
    proxy: value.proxy && typeof value.proxy === 'object' ? Object.freeze({ ...value.proxy }) : value.proxy,
    telemetry:
      value.telemetry && typeof value.telemetry === 'object' ? Object.freeze({ ...value.telemetry }) : value.telemetry,
  })
}

export function projectVendorAccounts(values = []) {
  return Object.freeze((Array.isArray(values) ? values : []).map(projectVendorAccount))
}
