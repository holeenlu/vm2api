import { createHash } from 'node:crypto'
import { getDb } from '../database.mjs'

const hash = (value) => createHash('sha256').update(String(value)).digest('hex')
export function codexClientScope(req) {
  const record = req?.apiKeyRecord
  if (record?.id) return hash(JSON.stringify(['key', record.user_id || '', record.id, record.group_id || '']))
  if (req?.apiKeyKind === 'master') return hash('platform-master')
  return null
}
export function codexAccountIdentity(accounts) {
  const identities = (accounts || [])
    .map((a) => a.chatgpt_account_id || a.account_id || (a.access_token ? hash(a.access_token) : null))
    .filter(Boolean)
    .sort()
  return identities.length ? hash(JSON.stringify(identities)) : null
}

export class CodexResponseOwnersRepo {
  constructor(db = getDb()) {
    this.db = db
    this.insert = db.prepare(`INSERT INTO codex_response_owners VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope_hash, response_hash) DO UPDATE SET expires_at = excluded.expires_at
      WHERE vm_id = excluded.vm_id AND identity_hash = excluded.identity_hash AND session_id IS excluded.session_id`)
    this.find = db.prepare(
      'SELECT * FROM codex_response_owners WHERE scope_hash = ? AND response_hash = ? AND expires_at > ?',
    )
    this.prune = db.prepare('DELETE FROM codex_response_owners WHERE expires_at <= ?')
    this.nextPrune = 0
  }
  remember(scope, responseId, { vmId, identity, sessionId = null }, now = Date.now()) {
    if (!scope || !responseId || !identity || !vmId || String(responseId).length > 512) return false
    if (now >= this.nextPrune) {
      this.prune.run(now)
      this.nextPrune = now + 60_000
    }
    return this.insert.run(scope, hash(responseId), vmId, identity, sessionId, now + 24 * 3600_000).changes === 1
  }
  resolve(scope, responseId, now = Date.now()) {
    if (!scope || typeof responseId !== 'string' || !responseId || responseId.length > 512) return null
    return this.find.get(scope, hash(responseId), now) || null
  }
}
