import {
  createDownstreamSettlement,
  mutateDownstreamSettlement,
  previewDownstreamSettlements,
} from '../vendor-settlements.mjs'
import { createSettlement, settlementAction } from '../vendor-admin.mjs'

/** Mutation boundary for vendor settlements; idempotency and payment rules stay in legacy services. */
export function createSettlementCommandService() {
  return Object.freeze({
    previewDownstream: previewDownstreamSettlements,
    createDownstream: createDownstreamSettlement,
    mutateDownstream: mutateDownstreamSettlement,
    createAdmin: createSettlement,
    actionAdmin: settlementAction,
  })
}
