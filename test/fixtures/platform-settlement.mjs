import crypto from 'node:crypto'
import {
  createPlatformSettlement,
  previewPlatformSettlement,
} from '../../src/lib/vendor/vendor-settlements.mjs'

/** Preview then create a platform → tier-1 statement the way the admin UI does (server-side preview token). */
export async function platformSettlement(platform, vendorId, period, { actor = 'sa', key, preview } = {}) {
  const quote = preview || (await previewPlatformSettlement(platform, actor, { vendor_id: vendorId, ...period }))
  return createPlatformSettlement(platform, actor, {
    preview_token: quote.preview_token,
    idempotency_key: key || `platform-${crypto.randomUUID()}`,
  })
}
