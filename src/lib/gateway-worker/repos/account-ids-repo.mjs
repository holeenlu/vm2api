/**
 * Gateway 账号编号高水位（settings）与已用编号读取。经 DbClient 异步访问（R6 B5）。
 */
import { dbClient } from '../../db/db-client.mjs'
import { GATEWAY_ACCOUNT_ID_PREFIX } from '../account-ids.mjs'

export async function settingValue(db, key) {
  return dbClient(db).one('SELECT value FROM settings WHERE key=?', key)
}

export async function gatewayAccountIds(db) {
  return dbClient(db).many(`SELECT id FROM vendor_resources WHERE id LIKE '${GATEWAY_ACCOUNT_ID_PREFIX}%'`)
}

export async function raiseSettingCounter(db, key, value, updatedAt) {
  return dbClient(db).run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
      WHERE CAST(settings.value AS INTEGER) < CAST(excluded.value AS INTEGER)`,
    key,
    value,
    updatedAt,
  )
}
