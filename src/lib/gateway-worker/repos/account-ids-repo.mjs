/**
 * Gateway 账号编号高水位（settings）与已用编号读取。
 */
import { GATEWAY_ACCOUNT_ID_PREFIX } from '../account-ids.mjs'

export function settingValue(db, key) {
  return db.prepare('SELECT value FROM settings WHERE key=?').get(key)
}

export function gatewayAccountIds(db) {
  return db.prepare(`SELECT id FROM vendor_resources WHERE id LIKE '${GATEWAY_ACCOUNT_ID_PREFIX}%'`).all()
}

export function raiseSettingCounter(db, key, value, updatedAt) {
  return db
    .prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
      WHERE CAST(settings.value AS INTEGER) < CAST(excluded.value AS INTEGER)`)
    .run(key, value, updatedAt)
}
