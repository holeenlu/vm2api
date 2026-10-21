import { panelIdentity } from './panel-acl.mjs'
import { normalizeOwnerId } from './resource-owner.mjs'

export function denyIfUserMissesKey(req, res, { apiKeyStore, json, keyId }) {
  const ident = panelIdentity(req)
  if (ident.role !== 'user') return false
  const rec = apiKeyStore?.repo?.getById?.(keyId) || null
  const owner = normalizeOwnerId(rec?.user_id)
  if (!rec || owner !== normalizeOwnerId(req.panelUserId)) {
    json(res, 404, { ok: false, error: { message: 'api key not found' } })
    return true
  }
  return false
}
