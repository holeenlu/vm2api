/**
 * SQLite database layer — sub2api data-layer inspired, on node:sqlite.
 *
 * - Single-process gateway → embedded SQLite (WAL) instead of sub2api's
 *   PostgreSQL+Redis. Same patterns: versioned SQL migrations with SHA-256
 *   checksum verification (sub2api migrations_runner), repository modules,
 *   settings table, backup records.
 * - Zero new dependencies: uses the built-in `node:sqlite` DatabaseSync.
 *
 * Env:
 *   KIN_DB_PATH — override db file path (default <dataDir>/kin.db)
 *   KIN_DB_CACHE_KIB — page-cache ceiling in KiB (default 262144 = 256 MiB)
 *   KIN_DB_MMAP_BYTES — mmap ceiling in bytes (default 1 GiB; 0 disables mmap)
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { startSqlitePool, stopSqlitePool } from './sqlite-pool.mjs'
import {
  armWriteBehind,
  assertOutsideTransaction,
  discardPendingWrites,
  flushWrites,
  pendingWrites,
  writesIdle,
} from './write-behind.mjs'
import { armWriteHealth } from './write-health.mjs'
import { commitRetryStats, flushCommitRetries } from './commit-retry.mjs'
import { primeSettingsSnapshot } from './repos/settings-repo.mjs'
import { dbTime } from '../../shared/system-time.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = path.join(__dirname, 'migrations')

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex')
}

/** LF-canonical hash plus CRLF/raw variants so Windows-applied checksums still match. */
function migrationChecksums(sql) {
  const lf = sql.replace(/\r\n/g, '\n')
  const crlf = lf.replace(/\n/g, '\r\n')
  return {
    canonical: sha256Hex(lf),
    variants: new Set([sha256Hex(sql), sha256Hex(lf), sha256Hex(crlf)]),
  }
}

// 001 was published briefly before the proxy pool switched to its persisted
// record shape. Its checksum cannot be treated as the current 001: migration
// 018 assumes the newer columns and otherwise fails after accepting the hash.
const HISTORICAL_001_PROXY_CHECKSUMS = new Set([
  '376c686118bbd8aaa6db6ea13fb2ff0afecc0c7464bc3d668743a55c9ccafdde',
  'd6769ea311718b5af91e47295f97c3bf2722ece6d26acee7e89df84b88599ae2',
])

function reconcileHistorical001ProxySchema(db, checksum) {
  if (!HISTORICAL_001_PROXY_CHECKSUMS.has(checksum)) return false
  const columns = new Set(
    db
      .prepare('PRAGMA table_info(proxies)')
      .all()
      .map((row) => row.name),
  )
  const current = ['raw', 'enabled', 'consecutive_failures', 'last_error'].every((name) => columns.has(name))
  if (current && !columns.has('url')) return true
  const historical = ['url', 'failures', 'last_probe_ok', 'disabled_reason', 'updated_at'].every((name) =>
    columns.has(name),
  )
  if (!historical || columns.has('raw')) {
    throw new Error('historical migration 001 proxy schema is not recognized')
  }

  withTransaction(db, () => {
    db.exec(`
      ALTER TABLE proxies RENAME TO proxies_historical_001;
      CREATE TABLE proxies (
        id TEXT PRIMARY KEY,
        scheme TEXT DEFAULT 'socks5',
        host TEXT,
        port INTEGER,
        username TEXT,
        password TEXT,
        raw TEXT,
        status TEXT DEFAULT 'unknown',
        enabled INTEGER DEFAULT 1,
        bound_vm_id TEXT,
        consecutive_failures INTEGER DEFAULT 0,
        latency_ms INTEGER,
        last_probe_at TEXT,
        last_error TEXT,
        created_at TEXT
      );
      INSERT INTO proxies (
        id, scheme, host, port, username, password, raw, status, enabled,
        bound_vm_id, consecutive_failures, latency_ms, last_probe_at,
        last_error, created_at
      )
      SELECT
        id, scheme, host, port, username, password, url,
        CASE
          WHEN status IN ('unknown', 'ok', 'dead') THEN status
          WHEN last_probe_ok = 1 THEN 'ok'
          WHEN last_probe_ok = 0 THEN 'dead'
          ELSE 'unknown'
        END,
        CASE WHEN status = 'disabled' THEN 0 ELSE 1 END,
        bound_vm_id, COALESCE(failures, 0), latency_ms, last_probe_at,
        disabled_reason, created_at
      FROM proxies_historical_001;
      DROP TABLE proxies_historical_001;
    `)
  })
  return true
}
let _db = null
let _dbPath = null
let poolWanted = false

export function resolveDbPath({ dataDir, dbPath } = {}) {
  if (dbPath) return dbPath
  if (process.env.KIN_DB_PATH) return process.env.KIN_DB_PATH
  const dir = dataDir || path.join(process.cwd(), 'data')
  return path.join(dir, 'kin.db')
}

/**
 * Standalone (non-singleton) open: PRAGMAs + migrations applied.
 * Used by unit tests and by stores constructed without a global db.
 * @returns {DatabaseSync}
 */
export function createDatabase({ dataDir, dbPath, migrationsDir } = {}) {
  const file = resolveDbPath({ dataDir, dbPath })
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // 先改权限再打开（降级演练 M3）：文件被改成只读时 SQLite 会静默以只读方式打开，之后改回权限也不会变成可写
  if (fs.existsSync(file)) {
    try {
      fs.chmodSync(file, 0o600)
    } catch {}
  }
  const db = new DatabaseSync(file)
  try {
    fs.chmodSync(file, 0o600)
  } catch {}
  try {
    assertWritableConnection(db, file)
  } catch (error) {
    try {
      db.close()
    } catch {}
    throw error
  }
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA foreign_keys = ON')
  const { cacheKiB, mmapBytes } = dbTuning()
  // DatabaseSync 没有异步 API：面板的聚合查询跑多久，事件循环就冻多久，
  // 同一进程里所有流式推理连接一起卡住。SQLite 默认只给 2MB 页缓存，
  // 对 550MB+ 的库远远不够——生产 strace 实测每秒约 2 万次 pread64。
  // 线上实测 30 天维度聚合：297ms →（仅缓存）127ms →（缓存+mmap）112ms。
  // 两者都是上限而不是预分配，按需增长；内存紧张的部署用环境变量调小，
  // KIN_DB_MMAP_BYTES=0 可完全关闭 mmap。
  db.exec(`PRAGMA cache_size = -${cacheKiB}`)
  db.exec(`PRAGMA mmap_size = ${mmapBytes}`)
  try {
    snapshotBeforeMigrations(db, file, { migrationsDir })
  } catch (error) {
    try {
      db.close()
    } catch {}
    throw error
  }
  applyMigrations(db, { migrationsDir })
  cachePreparedStatements(db)
  // settings 快照（R6 B1）随连接打开一次载入，与迁移同属打开连接的同步步骤；之后的读取不再同步查库
  primeSettingsSnapshot(db)
  return db
}

/**
 * 只读打开的连接拒绝启动（降级演练 M3）：文件属主或挂载不允许写时 SQLite 不报错、退回只读打开，迁移已全部执行的库照常启动，
 * 之后每次写入都失败（使用记录、结算、回执、事件全部写不进去），且连接一直是只读，恢复权限后也要重启才可写。
 * 这里在打开时做一次写检查（BEGIN IMMEDIATE、建一张临时名字的表再回滚，不留痕迹；只读连接上建表即失败），
 * 只读时直接报错退出：控制面不可用期间 Worker 的回执与事件留在本地，恢复后重启控制面补交。
 * 写锁被占（SQLITE_BUSY）等暂时性错误不拦截，由运行期写入健康处理。
 */
export function assertWritableConnection(db, file) {
  try {
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec('CREATE TABLE _kin_readonly_check (x)')
    } finally {
      db.exec('ROLLBACK')
    }
  } catch (error) {
    if ((Number(error?.errcode) & 0xff) !== 8) return
    throw new Error(
      `database ${file} was opened read-only (${error.message}); ${readOnlyHint(file)}; fix it, then restart`,
    )
  }
}

// 只读打开的常见原因（M3 复审 P2-9）：库文件、WAL / 共享内存文件（-wal、-shm）或所在目录不可写
// （SQLite 要在目录里创建 -wal、-shm），以及只读挂载、不可变标志
function readOnlyHint(file) {
  const dir = path.dirname(file)
  const found = []
  for (const target of [file, `${file}-wal`, `${file}-shm`]) {
    if (!fs.existsSync(target)) continue
    try {
      fs.accessSync(target, fs.constants.W_OK)
    } catch {
      found.push(`${path.basename(target)} is not writable`)
    }
  }
  try {
    fs.accessSync(dir, fs.constants.W_OK)
  } catch {
    found.push(`directory ${dir} is not writable`)
  }
  const detail = found.length ? `${found.join(', ')}; ` : ''
  return `${detail}the file, its -wal and -shm files and directory ${dir} (where SQLite creates -wal / -shm) must all be writable by this process: check owner, mode, immutable flags and the mount`
}

// 各 repo 在构造函数和方法里随用随 prepare，热路径上每个请求都重新编译同一批 SQL（生产 CPU 分析：
// UsersRepo/ApiKeysRepo 构造、分组授权与 VM 分组查询合计约占主线程 7%）。与读池 sqlite-worker 的
// cachedPrepare 同一做法：同一 SQL 文本复用同一条语句，按最近使用保留 STATEMENT_CACHE_SIZE 条。
// 语句只在单线程内同步执行；没有 iterate 调用（R6 B4 起供应商结算明细经 DbClient 一次取回），不会在迭代中再执行同一 SQL。
const STATEMENT_CACHE_SIZE = 512

function cachePreparedStatements(db) {
  const prepare = db.prepare.bind(db)
  const cache = new Map()
  db.prepare = (sql) => {
    let stmt = cache.get(sql)
    if (stmt) {
      cache.delete(sql)
    } else {
      stmt = prepare(sql)
      if (cache.size >= STATEMENT_CACHE_SIZE) cache.delete(cache.keys().next().value)
    }
    cache.set(sql, stmt)
    return stmt
  }
  return db
}

/**
 * SQLite 页缓存与 mmap 上限，可按部署规模用环境变量覆盖。
 * @returns {{ cacheKiB: number, mmapBytes: number }}
 */
export function dbTuning() {
  const cache = Number.parseInt(process.env.KIN_DB_CACHE_KIB ?? '', 10)
  const mmap = Number.parseInt(process.env.KIN_DB_MMAP_BYTES ?? '', 10)
  return {
    cacheKiB: Number.isSafeInteger(cache) && cache > 0 ? cache : 262_144,
    mmapBytes: Number.isSafeInteger(mmap) && mmap >= 0 ? mmap : 1_073_741_824,
  }
}

/**
 * Open (or return the already-open) singleton database.
 * @returns {DatabaseSync}
 */
export function openDatabase({ dataDir, dbPath, migrationsDir, pooled = false } = {}) {
  if (pooled) poolWanted = true
  if (_db) {
    if (poolWanted) {
      startSqlitePool(_dbPath)
      armWriteBehind(_db)
      armWriteHealth(_db)
    }
    return _db
  }
  _db = createDatabase({ dataDir, dbPath, migrationsDir })
  _dbPath = resolveDbPath({ dataDir, dbPath })
  if (poolWanted) {
    startSqlitePool(_dbPath)
    armWriteBehind(_db)
    armWriteHealth(_db)
  }
  return _db
}

/**
 * Resolve the db a store should use: explicit db → global singleton →
 * standalone connection rooted at dataDir (test isolation path).
 */
export function resolveStoreDb({ db, dataDir } = {}) {
  if (db) return db
  if (_db) return _db
  return createDatabase({ dataDir })
}

/** Current db instance (throws when not opened). */
export function getDb() {
  if (!_db) throw new Error('database not opened — call openDatabase() first')
  return _db
}

export function isDbOpen() {
  return !!_db
}

export function getDbPath() {
  return _dbPath
}

/**
 * 先提交写回队列与登记的后台写入（代理池落盘、VM 文件镜像、请求日志），再关闭连接（R6 B8 改 async）。
 * 没有待写入时在调用当下同步关闭；调用方都要 await（停机、备份恢复、备份线程、测试）。
 */
export async function closeDatabase() {
  assertOutsideTransaction('closeDatabase()', _db)
  // 待重试的推理收口先尝试一次，剩余的落盘待补写（M3 复审 P1-3）
  if (_db && commitRetryStats().pending) await flushCommitRetries()
  if (!writesIdle()) await flushWrites()
  // 数据库写不进去时排空失败：剩余闭包计数、打日志，能落盘的落盘（M3 复审 P2-7）
  if (pendingWrites()) discardPendingWrites('database closed while writes are failing')
  armWriteBehind(null)
  armWriteHealth(null)
  stopSqlitePool()
  if (_db) {
    try {
      _db.close()
    } catch {}
  }
  _db = null
  _dbPath = null
}

/**
 * Versioned SQL migrations with checksum verification (sub2api-style).
 * Files: migrations/NNN_name.sql, applied in filename order inside a
 * transaction each. `schema_migrations` records version+checksum; a
 * checksum mismatch on an already-applied migration is a hard error.
 */
const PRE_MIGRATE_PREFIX = 'kin-pre-migrate-'
const PRE_MIGRATE_KEEP = 3

/**
 * 本版本代码中尚未应用到该库的迁移文件名（与 applyMigrations 同一版本口径），只读；全新库返回全部文件。
 * 运维脚本（`executor/repos/script-db-repo.mjs` 的 schema_outdated 检查）与启动前快照共用。
 */
export function pendingMigrations(db, { migrationsDir } = {}) {
  const dir = migrationsDir || MIGRATIONS_DIR
  const files = fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((f) => /^\d+.*\.sql$/.test(f))
        .sort()
    : []
  const ledger = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get()
  const rows = ledger ? db.prepare('SELECT version, name FROM schema_migrations').all() : []
  const counts = new Map()
  for (const file of files) {
    const prefix = file.split('_')[0]
    counts.set(prefix, (counts.get(prefix) || 0) + 1)
  }
  const names = new Set(rows.map((row) => row.name))
  const versions = new Set(rows.map((row) => row.version))
  return files.filter((file) => {
    if (names.has(file)) return false
    const prefix = file.split('_')[0]
    return !versions.has(counts.get(prefix) > 1 ? file.replace(/\.sql$/, '') : prefix)
  })
}

/** 已有库（迁移台账非空）里尚未执行的迁移；全新库返回空，不需要迁移前快照。 */
function pendingMigrationsOfExistingDatabase(db, options) {
  const ledger = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get()
  if (!ledger || !db.prepare('SELECT 1 FROM schema_migrations LIMIT 1').get()) return []
  return pendingMigrations(db, options)
}

/**
 * 启动时有待执行的迁移就先在库旁做一份一致快照（审计 P1-S7）：迁移会改写结构（包括破坏性迁移），出错或逻辑有误时
 * 只能靠迁移前的副本恢复。快照写到 `<库目录>/backups/auto/kin-pre-migrate-<时间>.sqlite`，quick_check 通过才继续，
 * 失败拒绝启动；只保留最近 3 份。`KIN_DB_PREMIGRATE_SNAPSHOT=0` 关闭（自行备份时）。
 */
export function snapshotBeforeMigrations(db, file, { migrationsDir } = {}) {
  if (String(process.env.KIN_DB_PREMIGRATE_SNAPSHOT || '').trim() === '0') return null
  if (!file || file === ':memory:') return null
  const pending = pendingMigrationsOfExistingDatabase(db, { migrationsDir })
  if (!pending.length) return null
  const dir = path.join(path.dirname(file), 'backups', 'auto')
  const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z'
  const dest = path.join(dir, `${PRE_MIGRATE_PREFIX}${stamp}.sqlite`)
  vacuumInto(db, dest)
  const copy = new DatabaseSync(dest, { readOnly: true })
  let check
  try {
    check = copy.prepare('PRAGMA quick_check').get()
  } finally {
    copy.close()
  }
  if (Object.values(check || {})[0] !== 'ok') {
    throw new Error(`pre-migration snapshot ${dest} failed quick_check; refusing to migrate`)
  }
  console.warn(`[db] ${pending.length} pending migration(s) (${pending[0]} …); snapshot written to ${dest}`)
  try {
    const old = fs
      .readdirSync(dir)
      .filter((name) => name.startsWith(PRE_MIGRATE_PREFIX) && name.endsWith('.sqlite'))
      .sort()
    for (const name of old.slice(0, Math.max(0, old.length - PRE_MIGRATE_KEEP)))
      fs.rmSync(path.join(dir, name), { force: true })
  } catch {}
  return dest
}

export function applyMigrations(db, { migrationsDir } = {}) {
  const dir = migrationsDir || MIGRATIONS_DIR
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    name TEXT,
    checksum TEXT,
    applied_at TEXT
  )`)

  const files = fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((f) => /^\d+.*\.sql$/.test(f))
        .sort()
    : []

  const appliedRows = db.prepare('SELECT version, name, checksum FROM schema_migrations').all()
  const applied = new Map(appliedRows.map((r) => [r.version, r.checksum]))
  const historical001Accepted = reconcileHistorical001ProxySchema(db, applied.get('001'))
  const insert = db.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)')

  // Published customization branches can allocate the same numeric prefix.
  // Keep their SQL files and historical ledger rows distinct by filename.
  const counts = new Map()
  for (const file of files) {
    const prefix = file.split('_')[0]
    counts.set(prefix, (counts.get(prefix) || 0) + 1)
  }
  const results = []
  for (const file of files) {
    const prefix = file.split('_')[0]
    const previous = appliedRows.find((row) => row.name === file)
    const version = previous?.version || (counts.get(prefix) > 1 ? file.replace(/\.sql$/, '') : prefix)
    const sql = fs.readFileSync(path.join(dir, file), 'utf8')
    const { canonical: checksum, variants } = migrationChecksums(sql)
    if (applied.has(version)) {
      const stored = applied.get(version)
      const historicalAccepted =
        version === '001' && historical001Accepted && HISTORICAL_001_PROXY_CHECKSUMS.has(stored)
      if (!variants.has(stored) && !historicalAccepted) {
        throw new Error(`migration checksum mismatch for ${file}: applied=${stored} current=${checksum}`)
      }
      if (stored !== checksum) {
        db.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = ?').run(checksum, version)
      }
      continue
    }
    // Table rebuilds must disable FK enforcement before the transaction.
    // Check the complete graph before commit and restore enforcement on error.
    const rebuildForeignKeys = sql.startsWith('-- foreign-keys: rebuild')
    if (rebuildForeignKeys) db.exec('PRAGMA foreign_keys = OFF')
    db.exec('BEGIN')
    try {
      db.exec(sql)
      if (rebuildForeignKeys && db.prepare('PRAGMA foreign_key_check').all().length)
        throw new Error('table rebuild left invalid foreign key references')
      insert.run(version, file, checksum, dbTime())
      db.exec('COMMIT')
    } catch (e) {
      try {
        db.exec('ROLLBACK')
      } catch {}
      throw new Error(`migration ${file} failed: ${e.message}`)
    } finally {
      if (rebuildForeignKeys) db.exec('PRAGMA foreign_keys = ON')
    }
    results.push(file)
  }
  return results
}

/**
 * 同步事务，只供本文件的迁移（打开连接时执行）使用；运行期代码经 DbClient 的 `db.tx`（R6 B8 起不再导出）。
 * Nested calls just run inline.
 */
function withTransaction(db, fn) {
  if (db.isTransaction) return fn()
  db.exec('BEGIN')
  try {
    const out = fn()
    db.exec('COMMIT')
    return out
  } catch (e) {
    if (db.isTransaction) {
      try {
        db.exec('ROLLBACK')
      } catch {}
    }
    throw e
  }
}

/**
 * Online-consistent snapshot of the live database (WAL-safe).
 * @returns {string} destination path
 */
export function vacuumInto(db, destPath) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true })
  try {
    fs.rmSync(destPath, { force: true })
  } catch {}
  const esc = String(destPath).replace(/'/g, "''")
  db.exec(`VACUUM INTO '${esc}'`)
  try {
    fs.chmodSync(destPath, 0o600)
  } catch {}
  return destPath
}
