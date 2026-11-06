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

// 统计 Worker 线程（不在主线程）：本线程自己的只读连接，BEGIN / COMMIT 与 PRAGMA 是连接基础设施（sql-boundary 豁免）。
// 读事务用延迟 BEGIN（不能用 DbClient 的 BEGIN IMMEDIATE：那会占住写锁、挡住主线程写入）。
// billingStats 与成本维护 maintainBillingCosts 经 DbClient 读写，返回 Promise（R6 B6a / B8）；语句仍同步执行，BEGIN 与 COMMIT 之间不等待真实 I/O。
// 主线程同一时间只派发一条请求（UsageStatsWorker.active），消息不会交错进同一个读事务。
parentPort.on('message', async ({ id, opts }) => {
  try {
    const version = dataVersion.get().data_version
    if (version !== lastVersion) {
      repo._billingStatsCache.clear()
      lastVersion = version
    }
    if (!workerData.readOnly) await repo.maintainBillingCosts()
    db.exec('BEGIN')
    const value = await repo.billingStats(opts)
    db.exec('COMMIT')
    parentPort.postMessage({ id, value })
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {}
    parentPort.postMessage({ id, error: { message: error.message, code: error.code } })
  }
})
