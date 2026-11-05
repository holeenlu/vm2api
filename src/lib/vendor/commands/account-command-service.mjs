import {
  authorizeVendorAccountDraft,
  createVendorAccountDraft,
  finalizeVendorAccountDraft,
  publicVendorAccountDraft,
  requireVendorAccountDraft,
} from '../vendor-account-draft.mjs'

/** Draft/authorization command boundary; credential exchange remains unchanged. */
export function createAccountCommandService() {
  return Object.freeze({
    createDraft: createVendorAccountDraft,
    requireDraft: requireVendorAccountDraft,
    authorizeDraft: authorizeVendorAccountDraft,
    finalizeDraft: finalizeVendorAccountDraft,
    projectDraft: publicVendorAccountDraft,
  })
}
