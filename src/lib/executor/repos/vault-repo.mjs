/**
 * 凭据库仓储（executor_credentials）。只做数据访问；加解密与代次规则在 vault.mjs，事务由调用方持有。
 */
import { statementCache } from './statement-cache.mjs'

/** 凭据库是否已有记录；表不存在时为 false。 */
export function hasCredentialRecords(db) {
  try {
    return !!db.prepare('SELECT 1 FROM executor_credentials LIMIT 1').get()
  } catch {
    return false
  }
}

export function vaultRepo(db) {
  const stmt = statementCache(db)
  // 与原实现一致：创建凭据库时即预编译（表不存在时在此报错）
  const select = stmt('SELECT * FROM executor_credentials WHERE account_resource_id=? AND grant_kind=?')
  return {
    get(accountResourceId, grant) {
      return select.get(accountResourceId, grant)
    },
    upsert(row) {
      stmt(
        `INSERT INTO executor_credentials(account_resource_id,grant_kind,revision,master_key_id,wrapped_key,ciphertext,token_fingerprint,expires_at,source,source_instance_id,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(account_resource_id,grant_kind) DO UPDATE SET revision=excluded.revision,master_key_id=excluded.master_key_id,
           wrapped_key=excluded.wrapped_key,ciphertext=excluded.ciphertext,token_fingerprint=excluded.token_fingerprint,
           expires_at=excluded.expires_at,source=excluded.source,source_instance_id=excluded.source_instance_id,updated_at=excluded.updated_at`,
      ).run(
        row.account_resource_id,
        row.grant_kind,
        row.revision,
        row.master_key_id,
        row.wrapped_key,
        row.ciphertext,
        row.token_fingerprint,
        row.expires_at,
        row.source,
        row.source_instance_id,
        row.updated_at,
      )
    },
    listOrdered() {
      return stmt('SELECT * FROM executor_credentials ORDER BY account_resource_id,grant_kind').all()
    },
    all() {
      return stmt('SELECT * FROM executor_credentials').all()
    },
    rewrap(accountResourceId, grant, masterKeyId, wrappedKey) {
      stmt(
        'UPDATE executor_credentials SET master_key_id=?,wrapped_key=? WHERE account_resource_id=? AND grant_kind=?',
      ).run(masterKeyId, wrappedKey, accountResourceId, grant)
    },
    /** 删除一个授权类别，或该账号的全部凭据；返回删除条数 */
    remove(accountResourceId, grant = null) {
      const result = grant
        ? stmt('DELETE FROM executor_credentials WHERE account_resource_id=? AND grant_kind=?').run(
            accountResourceId,
            grant,
          )
        : stmt('DELETE FROM executor_credentials WHERE account_resource_id=?').run(accountResourceId)
      return Number(result.changes || 0)
    },
    masterKeyIds() {
      return stmt('SELECT DISTINCT master_key_id FROM executor_credentials')
        .all()
        .map((row) => row.master_key_id)
    },
  }
}
