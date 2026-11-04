import { parentPort, workerData } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import { dbTuning } from '../db/database.mjs'
import { UsageLogsRepo } from '../db/repos/usage-logs-repo.mjs'

// Open the existing database only. Startup migrations belong to the gateway.
// Normal reporting retains the existing, rate-limited historical cost repair;
// readOnly is used by offline diagnostics, which must never modify the ledger.
const db = new DatabaseSync(workerData.dbPath, { readOnly: workerData.readOnly })
const { cacheKiB, mmapBytes } = dbTuning()
db.exec(`PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;
  PRAGMA cache_size = -${cacheKiB}; PRAGMA mmap_size = ${mmapBytes}`)
const repo = new UsageLogsRepo(db, { billingMaintenance: false })
const dataVersion = db.prepare('PRAGMA data_version')
let lastVersion = null

parentPort.on('message', ({ id, opts }) => {
  try {
    const version = dataVersion.get().data_version
    if (version !== lastVersion) {
      repo._billingStatsCache.clear()
      lastVersion = version
    }
    if (!workerData.readOnly) repo.maintainBillingCosts()
    db.exec('BEGIN')
    const value = repo.billingStats(opts)
    db.exec('COMMIT')
    parentPort.postMessage({ id, value })
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {}
    parentPort.postMessage({ id, error: { message: error.message, code: error.code } })
  }
})
