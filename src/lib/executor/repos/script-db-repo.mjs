import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { pendingMigrations, resolveDbPath } from '../../db/database.mjs'

// 待执行迁移的判定与 database.mjs 共用一份实现（启动前快照也用它）
export { pendingMigrations }

/**
 * 凭据迁移、主密钥轮换等运维脚本打开控制面数据库：不执行迁移（审计 U3：只读演练此前会提前升级库结构）。
 * 库结构落后于本版本代码时报 schema_outdated，要求先升级并启动控制面；readOnly 为 true 时以只读方式打开。
 */
export function openScriptDatabase({ dataDir, dbPath, migrationsDir, readOnly = false } = {}) {
  const file = resolveDbPath({ dataDir, dbPath })
  if (!fs.existsSync(file)) throw Object.assign(new Error(`database not found: ${file}`), { code: 'database_missing' })
  const db = new DatabaseSync(file, { readOnly })
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    if (!readOnly) db.exec('PRAGMA foreign_keys = ON')
    const pending = pendingMigrations(db, { migrationsDir })
    if (pending.length)
      throw Object.assign(
        new Error(
          `database schema is older than this code (${pending.length} pending migrations, first ${pending[0]}); upgrade and start the control plane first`,
        ),
        { code: 'schema_outdated' },
      )
    return db
  } catch (error) {
    db.close()
    throw error
  }
}
