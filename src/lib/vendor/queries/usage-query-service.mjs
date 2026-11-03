import { vendorUsage } from '../vendor-usage.mjs'
import { supplierUsage, supplierAccountUsage } from '../vendor-account-usage.mjs'
import { projectVendorUsage } from '../projections/usage-projection.mjs'

/** Query boundary for supplier usage projections; SQL remains in legacy adapters. */
export function createUsageQueryService() {
  return Object.freeze({
    admin: (db, ids, query = {}) => projectVendorUsage(vendorUsage(db, ids, query)),
    supplier: (platform, identity, query = {}) => projectVendorUsage(supplierUsage(platform, identity, { query })),
    account: (platform, identity, accountId, query = {}) =>
      projectVendorUsage(supplierAccountUsage(platform, identity, accountId, query)),
  })
}
