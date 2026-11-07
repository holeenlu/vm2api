import {
  createDownstreamSettlement,
  createPlatformSettlement,
  mutateDownstreamSettlement,
  previewDownstreamSettlements,
  previewPlatformSettlement,
} from '../vendor-settlements.mjs'
import { settlementAction } from '../vendor-admin.mjs'

/** Mutation boundary for vendor settlements; idempotency and payment rules stay in legacy services. */
export function createSettlementCommandService() {
  return Object.freeze({
    previewDownstream: previewDownstreamSettlements,
    createDownstream: createDownstreamSettlement,
    mutateDownstream: mutateDownstreamSettlement,
    previewAdmin: previewPlatformSettlement,
    createAdmin: createPlatformSettlement,
    actionAdmin: settlementAction,
  })
}
