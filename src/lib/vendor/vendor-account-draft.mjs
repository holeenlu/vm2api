import crypto from 'node:crypto'

const TTL_MS = 30 * 60 * 1000
const drafts = new Map()

function id() {
  return `vendor_draft_${crypto.randomUUID()}`
}

function sweep(now = Date.now()) {
  for (const [key, draft] of drafts) {
    if (draft.expires_at <= now) drafts.delete(key)
  }
}

function ownerKey(identity) {
  return `${identity.user_id}:${identity.vendor.id}`
}

function publicDraft(draft) {
  return {
    id: draft.id,
    state: draft.state,
    expires_at: draft.expires_at,
    platform: draft.body.platform,
    authorization_kind: draft.body.authorization_kind,
    name: draft.body.name || '',
  }
}

export function createVendorAccountDraft(identity, body) {
  sweep()
  const key = String(body.idempotency_key || '').trim()
  if (key) {
    const owner = ownerKey(identity)
    for (const draft of drafts.values()) {
      if (draft.owner === owner && draft.body.idempotency_key === key) return draft
    }
  }
  const draft = {
    id: id(),
    owner: ownerKey(identity),
    vendor_id: identity.vendor.id,
    user_id: identity.user_id,
    body: structuredClone(body),
    state: 'awaiting_authorization',
    credential: null,
    result: null,
    created_at: Date.now(),
    expires_at: Date.now() + TTL_MS,
  }
  drafts.set(draft.id, draft)
  return draft
}

export function getVendorAccountDraft(identity, draftId) {
  sweep()
  const draft = drafts.get(String(draftId || ''))
  if (!draft || draft.owner !== ownerKey(identity)) return null
  return draft
}

export function requireVendorAccountDraft(identity, draftId) {
  const draft = getVendorAccountDraft(identity, draftId)
  if (!draft) {
    const error = new Error('授权草稿不存在或已过期，请重新填写账号资料')
    error.code = 'vendor_draft_not_found'
    error.status = 404
    throw error
  }
  if (draft.state === 'finalized') return draft
  return draft
}

export function authorizeVendorAccountDraft(identity, draftId, credential) {
  const draft = requireVendorAccountDraft(identity, draftId)
  if (draft.state === 'finalized') return draft
  draft.credential = structuredClone(credential)
  draft.state = 'authorized'
  draft.authorized_at = Date.now()
  return draft
}

export function finalizeVendorAccountDraft(identity, draftId, result) {
  const draft = requireVendorAccountDraft(identity, draftId)
  draft.state = 'finalized'
  draft.result = result
  draft.finalized_at = Date.now()
  return draft
}

export function publicVendorAccountDraft(draft) {
  return {
    ...publicDraft(draft),
    ...(draft.result ? { result: draft.result } : {}),
  }
}

export function resetVendorAccountDrafts() {
  drafts.clear()
}
