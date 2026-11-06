// Codex 入口的 VM 与 Gateway 两条执行路径共用的小工具。
import { advanceAttemptFacts } from './attempt-facts.mjs'
import { advanceDeliveryCommit } from './delivery-commit.mjs'

export function responseClosed(res) {
  return !!(res?.destroyed || res?.writableEnded || res?.closed)
}

export function commitCodexDelivery(req) {
  req.deliveryCommit = advanceDeliveryCommit(req.deliveryCommit, 'committed')
  req.attemptFacts = advanceAttemptFacts(req.attemptFacts, { downstream_committed: true, send_state: 'sent' })
}

export function sessionFrom(req, body) {
  const headers = req.headers || {}
  return {
    session_id:
      headers['x-session-id'] ||
      headers['session-id'] ||
      headers['x-conversation-id'] ||
      body?.conversation_id ||
      body?.session_id ||
      null,
    previous_response_id: body?.previous_response_id || null,
  }
}

export function normalizeServiceTier(raw) {
  if (typeof raw !== 'string') return null
  const tier = raw.trim().toLowerCase()
  return tier && tier.length <= 64 && !/[\x00-\x1f\x7f]/.test(tier) ? tier : null
}
