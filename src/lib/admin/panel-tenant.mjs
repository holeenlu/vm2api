import { panelIdentity } from './panel-acl.mjs'
import { normalizeOwnerId } from './resource-owner.mjs'

export function denyIfUserMissesKey(req, res, { apiKeyStore, json, keyId }) {
  const ident = panelIdentity(req)
  const rec = apiKeyStore?.repo?.getById?.(keyId) || null
  const owner = normalizeOwnerId(rec?.user_id)
  const allowed =
    ident.role === 'user'
      ? owner === normalizeOwnerId(req.panelUserId)
      : ident.role === 'admin'
        ? !!owner && apiKeyStore?.users?.isInScope?.(owner, req.panelUserId)
        : true
  if (!rec || !allowed) {
    json(res, 404, { ok: false, error: { message: 'api key not found' } })
    return true
  }
  return false
}
