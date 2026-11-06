import { supplierBilling } from '../vendor-settlements.mjs'
import { listSettlements } from '../vendor-admin.mjs'

/** Read-only settlement boundary; it preserves existing authorization in adapters. */
export function createSettlementQueryService() {
  return Object.freeze({
    supplierBilling,
    adminList: listSettlements,
  })
}
