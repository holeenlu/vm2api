/**
 * 凭据刷新租约仓储（credential_refresh_leases，及其读写的 gateway_worker_account_bindings 代次）。
 * 只做数据访问；租约规则在 refresh-lease.mjs，事务由调用方持有。
 */
import { statementCache } from './statement-cache.mjs'

export function refreshLeaseRepo(db) {
  const stmt = statementCache(db)
  return {
    latestBindingRevision(accountResourceId) {
      return stmt(
        'SELECT MAX(credential_revision) AS r FROM gateway_worker_account_bindings WHERE account_resource_id=?',
      ).get(accountResourceId)?.r
    },
    get(accountResourceId, grant) {
      return stmt('SELECT * FROM credential_refresh_leases WHERE account_resource_id=? AND grant_kind=?').get(
        accountResourceId,
        grant,
      )
    },
    hold({ accountResourceId, grant, instanceId, runtimeAccountId, token, credentialRevision, expiresAt, at }) {
      stmt(
        `INSERT INTO credential_refresh_leases(account_resource_id,grant_kind,holder_instance_id,runtime_account_id,lease_token,credential_revision,state,outcome,expires_at,acquired_at,updated_at)
         VALUES(?,?,?,?,?,?,'held',NULL,?,?,?)
         ON CONFLICT(account_resource_id,grant_kind) DO UPDATE SET holder_instance_id=excluded.holder_instance_id,
           runtime_account_id=excluded.runtime_account_id,lease_token=excluded.lease_token,
           state='held',outcome=NULL,expires_at=excluded.expires_at,acquired_at=excluded.acquired_at,updated_at=excluded.updated_at`,
      ).run(accountResourceId, grant, instanceId, runtimeAccountId, token, credentialRevision, expiresAt, at, at)
    },
    markAmbiguous(accountResourceId, grant, expiresAt, updatedAt) {
      stmt(
        "UPDATE credential_refresh_leases SET state='ambiguous',outcome='ambiguous',expires_at=?,updated_at=? WHERE account_resource_id=? AND grant_kind=?",
      ).run(expiresAt, updatedAt, accountResourceId, grant)
    },
    release({ accountResourceId, grant, outcome, credentialRevision, tokenFingerprint, updatedAt }) {
      stmt(
        `UPDATE credential_refresh_leases SET state='released',outcome=?,
           credential_revision=CASE WHEN ?='rotated' THEN MAX(credential_revision,COALESCE(?,credential_revision)) ELSE credential_revision END,
           token_fingerprint=CASE WHEN ?='rotated' THEN COALESCE(?,token_fingerprint) ELSE token_fingerprint END,
           updated_at=? WHERE account_resource_id=? AND grant_kind=?`,
      ).run(outcome, outcome, credentialRevision, outcome, tokenFingerprint, updatedAt, accountResourceId, grant)
    },
    raiseBindingRevision(instanceId, runtimeAccountId, credentialRevision) {
      stmt(
        'UPDATE gateway_worker_account_bindings SET credential_revision=MAX(credential_revision,?) WHERE gateway_instance_id=? AND runtime_account_id=?',
      ).run(credentialRevision, instanceId, runtimeAccountId)
    },
    list(accountResourceId) {
      return stmt(
        'SELECT grant_kind,holder_instance_id,state,outcome,credential_revision,token_fingerprint,expires_at,acquired_at,updated_at FROM credential_refresh_leases WHERE account_resource_id=? ORDER BY grant_kind',
      ).all(accountResourceId)
    },
  }
}
