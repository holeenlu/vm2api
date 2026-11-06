import { usagePeriod, vendorUsage } from '../vendor-usage.mjs'
import { supplierUsage, supplierAccountUsage } from '../vendor-account-usage.mjs'
import { projectVendorUsage } from '../projections/usage-projection.mjs'
import { pooledVendorRead } from '../vendor-read-pool.mjs'

/** Query boundary for supplier usage projections; SQL remains in legacy adapters. */
export function createUsageQueryService() {
  return Object.freeze({
    admin: async (db, ids, query = {}) => {
      usagePeriod(query)
      return projectVendorUsage(
        await pooledVendorRead(db, 'vendorUsage', [ids, query], () => vendorUsage(db, ids, query)),
      )
    },
    supplier: async (platform, identity, query = {}) =>
      projectVendorUsage(await supplierUsage(platform, identity, { query })),
    account: async (platform, identity, accountId, query = {}) =>
      projectVendorUsage(await supplierAccountUsage(platform, identity, accountId, query)),
  })
}
