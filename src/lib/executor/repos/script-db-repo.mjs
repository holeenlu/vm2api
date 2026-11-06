import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { resolveDbPath } from '../../db/database.mjs'

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migrations')

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

/** 本版本代码中尚未应用到该库的迁移文件名（与 database.mjs applyMigrations 同一版本口径），只读。 */
export function pendingMigrations(db, { migrationsDir = MIGRATIONS_DIR } = {}) {
  const files = fs.existsSync(migrationsDir)
    ? fs
        .readdirSync(migrationsDir)
        .filter((file) => /^\d+.*\.sql$/.test(file))
        .sort()
    : []
  const ledger = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get()
  const rows = ledger ? db.prepare('SELECT version, name FROM schema_migrations').all() : []
  const names = new Set(rows.map((row) => row.name))
  const versions = new Set(rows.map((row) => row.version))
  const counts = new Map()
  for (const file of files) {
    const prefix = file.split('_')[0]
    counts.set(prefix, (counts.get(prefix) || 0) + 1)
  }
  return files.filter((file) => {
    if (names.has(file)) return false
    const prefix = file.split('_')[0]
    return !versions.has(counts.get(prefix) > 1 ? file.replace(/\.sql$/, '') : prefix)
  })
}
