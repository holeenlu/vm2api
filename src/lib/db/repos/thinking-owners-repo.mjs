/**
 * thinking_signature_owners repository — which account signed each thinking block (pool/thinking-owner.mjs).
 *
 * The table lives outside the versioned migrations so this local addition cannot take a migration number later;
 * `ensureTable()` creates it on first use per connection. 数据访问经 DbClient 异步执行（R6 B7b）。
 */
import { dbClient } from '../db-client.mjs'

const CREATE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS thinking_signature_owners (
      key TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`
const CREATE_INDEX_SQL =
  'CREATE INDEX IF NOT EXISTS idx_thinking_owner_created ON thinking_signature_owners(created_at)'
const OWNERS_SQL = 'SELECT key, account_id FROM thinking_signature_owners WHERE key IN (SELECT value FROM json_each(?))'
const REFRESH_SQL =
  'UPDATE thinking_signature_owners SET created_at = ? WHERE key IN (SELECT value FROM json_each(?)) AND created_at < ?'
const INSERT_SQL = 'INSERT OR IGNORE INTO thinking_signature_owners (key, account_id, created_at) VALUES (?, ?, ?)'
const PURGE_SQL = 'DELETE FROM thinking_signature_owners WHERE created_at < ?'

export class ThinkingOwnersRepo {
  constructor(db) {
    this.db = db
    this.client = dbClient(db)
  }

  async ensureTable() {
    await this.client.exec(CREATE_TABLE_SQL)
    await this.client.exec(CREATE_INDEX_SQL)
  }

  /** key → account_id for the keys that have a record. */
  async owners(keys) {
    return (await this.client.many(OWNERS_SQL, JSON.stringify(keys))).map((row) => [row.key, row.account_id])
  }

  /** Keep looked-up records alive: rows older than `staleBefore` get `now`. */
  async refresh(keys, now, staleBefore) {
    await this.client.run(REFRESH_SQL, now, JSON.stringify(keys), staleBefore)
  }

  /** First writer wins. */
  async insert(key, accountId, now) {
    await this.client.run(INSERT_SQL, key, accountId, now)
  }

  async purge(before) {
    return (await this.client.run(PURGE_SQL, before)).changes
  }
}
