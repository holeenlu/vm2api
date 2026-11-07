import { parentPort, workerData } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import { runReconcile } from './billing-reconcile.mjs'

// 每日计费对账的 Worker 线程（不在主线程，审计阶段 2 W9）：自己的只读连接，全表求和不占主线程。
// 延迟 BEGIN 打开一个读事务，所有检查看同一个快照（结算扣费与使用记录在同一事务里写入，快照内不会出现半笔）；
// BEGIN / COMMIT 与 PRAGMA 是连接基础设施（sql-boundary 豁免），检查 SQL 经 DbClient 在 repos/billing-reconcile-repo.mjs。
// 只读连接写入会失败；一次运行一条消息，算完即退出。
const db = new DatabaseSync(workerData.dbPath, { readOnly: true })
try {
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA query_only = ON')
  db.exec('BEGIN')
  const value = await runReconcile(db, workerData.options || {})
  db.exec('COMMIT')
  parentPort.postMessage({ value })
} catch (error) {
  try {
    db.exec('ROLLBACK')
  } catch {}
  parentPort.postMessage({ error: { message: error?.message || String(error), code: error?.code } })
} finally {
  db.close()
}
