import { createHash } from 'node:crypto'
import { getDb } from '../database.mjs'
import { dbClient } from '../db-client.mjs'

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

const INSERT_SQL = `INSERT INTO codex_response_owners(scope_hash,response_hash,vm_id,identity_hash,session_id,expires_at,execution_kind,gateway_instance_id,runtime_account_id,credential_revision,account_resource_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope_hash, response_hash) DO UPDATE SET expires_at = excluded.expires_at,execution_kind=excluded.execution_kind,gateway_instance_id=excluded.gateway_instance_id,runtime_account_id=excluded.runtime_account_id,credential_revision=excluded.credential_revision,account_resource_id=excluded.account_resource_id
      WHERE vm_id = excluded.vm_id AND identity_hash = excluded.identity_hash AND session_id IS excluded.session_id`
const FIND_SQL = 'SELECT * FROM codex_response_owners WHERE scope_hash = ? AND response_hash = ? AND expires_at > ?'
const PRUNE_SQL = 'DELETE FROM codex_response_owners WHERE expires_at <= ?'

const sharedRepos = new WeakMap()

/** 每个数据库连接复用一个仓储：过期清理节流随之复用，不在每个请求上重复清理。 */
export function codexResponseOwners(db = getDb()) {
  let repo = sharedRepos.get(db)
  if (!repo) {
    repo = new CodexResponseOwnersRepo(db)
    sharedRepos.set(db, repo)
  }
  return repo
}

/** 经 DbClient 异步读写（R6 B7c）。 */
export class CodexResponseOwnersRepo {
  constructor(db = getDb()) {
    this.db = db
    this.client = dbClient(db)
    this.nextPrune = 0
  }
  async remember(
    scope,
    responseId,
    {
      vmId,
      identity,
      sessionId = null,
      executionKind = null,
      gatewayInstanceId = null,
      runtimeAccountId = null,
      credentialRevision = null,
      accountResourceId = null,
    },
    now = Date.now(),
  ) {
    if (!scope || !responseId || !identity || !vmId || String(responseId).length > 512) return false
    if (now >= this.nextPrune) {
      // 先登记下次清理时间再执行：并发的写入不会在同一时刻重复清理
      this.nextPrune = now + 60_000
      await this.client.run(PRUNE_SQL, now)
    }
    const result = await this.client.run(
      INSERT_SQL,
      scope,
      hash(responseId),
      vmId,
      identity,
      sessionId,
      now + 24 * 3600_000,
      executionKind,
      gatewayInstanceId,
      runtimeAccountId,
      credentialRevision,
      accountResourceId,
    )
    return result.changes === 1
  }
  async resolve(scope, responseId, now = Date.now()) {
    if (!scope || typeof responseId !== 'string' || !responseId || responseId.length > 512) return null
    return (await this.client.one(FIND_SQL, scope, hash(responseId), now)) || null
  }
}
