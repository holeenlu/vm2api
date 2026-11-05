/**
 * 凭据库仓储（executor_credentials）。只做数据访问；加解密与代次规则在 vault.mjs，事务由调用方持有。
 * 经 DbClient 异步访问（R6 B3）。
 */
import { dbClient } from '../../db/db-client.mjs'

/** 凭据库是否已有记录；表不存在时为 false。启动期同步读取（决定主密钥文件能否自动生成），R6 B8 统一处理。 */
export function hasCredentialRecords(db) {
  try {
    return !!db.prepare('SELECT 1 FROM executor_credentials LIMIT 1').get()
  } catch {
    return false
  }
}

const SELECT_SQL = 'SELECT * FROM executor_credentials WHERE account_resource_id=? AND grant_kind=?'
const REMOVE_GRANT_SQL = 'DELETE FROM executor_credentials WHERE account_resource_id=? AND grant_kind=?'
const REMOVE_ACCOUNT_SQL = 'DELETE FROM executor_credentials WHERE account_resource_id=?'

export function vaultRepo(db) {
  const c = dbClient(db)
  // 与原实现一致：创建凭据库时即预编译一次，表不存在时在此报错（之后的语句由 DbClient 按 SQL 缓存）
  db.prepare(SELECT_SQL)
  return {
    async get(accountResourceId, grant) {
      return c.one(SELECT_SQL, accountResourceId, grant)
    },
    async upsert(row) {
      await c.run(
        `INSERT INTO executor_credentials(account_resource_id,grant_kind,revision,master_key_id,wrapped_key,ciphertext,token_fingerprint,expires_at,source,source_instance_id,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(account_resource_id,grant_kind) DO UPDATE SET revision=excluded.revision,master_key_id=excluded.master_key_id,
           wrapped_key=excluded.wrapped_key,ciphertext=excluded.ciphertext,token_fingerprint=excluded.token_fingerprint,
           expires_at=excluded.expires_at,source=excluded.source,source_instance_id=excluded.source_instance_id,updated_at=excluded.updated_at`,
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
    async listOrdered() {
      return c.many('SELECT * FROM executor_credentials ORDER BY account_resource_id,grant_kind')
    },
    async all() {
      return c.many('SELECT * FROM executor_credentials')
    },
    async rewrap(accountResourceId, grant, masterKeyId, wrappedKey) {
      await c.run(
        'UPDATE executor_credentials SET master_key_id=?,wrapped_key=? WHERE account_resource_id=? AND grant_kind=?',
        masterKeyId,
        wrappedKey,
        accountResourceId,
        grant,
      )
    },
    /** 删除一个授权类别，或该账号的全部凭据；返回删除条数 */
    async remove(accountResourceId, grant = null) {
      const result = grant
        ? await c.run(REMOVE_GRANT_SQL, accountResourceId, grant)
        : await c.run(REMOVE_ACCOUNT_SQL, accountResourceId)
      return result.changes
    },
    /**
     * R6 临时同步出口（B5 删除）：只供 credential-custody 的 forgetSync 使用——account-management 的 revokeBps
     * 在同步 withTransaction 里删除 BPS 凭据，B5 把该事务改为 db.tx 后删除。
     */
    removeSync(accountResourceId, grant = null) {
      const result = grant
        ? c.runSync(REMOVE_GRANT_SQL, accountResourceId, grant)
        : c.runSync(REMOVE_ACCOUNT_SQL, accountResourceId)
      return result.changes
    },
    async masterKeyIds() {
      return (await c.many('SELECT DISTINCT master_key_id FROM executor_credentials')).map((row) => row.master_key_id)
    },
  }
}
