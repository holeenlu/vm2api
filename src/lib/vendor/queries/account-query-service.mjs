import { supplierAccountUsage, vendorAccountRuntime } from '../vendor-account-usage.mjs'
import { projectVendorUsage } from '../projections/usage-projection.mjs'

/** Account query boundary used by vendor and supplier-admin routes. */
export function createAccountQueryService() {
  return Object.freeze({
    runtime: vendorAccountRuntime,
    usage: async (platform, identity, accountId, query = {}) =>
      projectVendorUsage(await supplierAccountUsage(platform, identity, accountId, query)),
  })
}
