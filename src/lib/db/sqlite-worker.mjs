/**
 * One read-only SQLite connection for panel scans.
 *
 * The gateway's main thread also uses node:sqlite, and DatabaseSync methods
 * do not return until the query finishes. A /logs refresh runs several of
 * those scans at once; doing them here keeps the event loop free to write
 * SSE and answer the small requests that were queued behind them.
 *
 * The connection is query_only. Preparing an INSERT still succeeds (the repo
 * constructor prepares its write statements) but executing one fails.
 */
import { parentPort, workerData } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import { UsageLogsRepo } from './repos/usage-logs-repo.mjs'
import { UsageLogsView } from './repos/usage-logs-view.mjs'
import { readVendorUsage } from '../vendor/vendor-account-usage.mjs'
import { vendorUsage } from '../vendor/vendor-usage.mjs'
import { quotaForecastForAccount } from '../gateway-worker/quota-forecast.mjs'

const VIEW_METHODS = new Set([
  'listBatch',
  'ranking',
  'summary',
  'filterOptions',
  'activeSessions',
  'overview',
  'exportRows',
])
const REPO_METHODS = new Set(['totals', 'aggregate', 'windowStats'])
// Supplier usage reports and Gateway account forecasts take the connection first: (db, ...args).
const VENDOR_METHODS = new Map([
  ['readVendorUsage', readVendorUsage],
  ['vendorUsage', vendorUsage],
  ['quotaForecastForAccount', quotaForecastForAccount],
])

const cache = new Map()

function cachedPrepare(db) {
  const prepare = db.prepare.bind(db)
  db.prepare = (sql) => {
    let stmt = cache.get(sql)
    if (!stmt) {
      if (cache.size >= 128) cache.delete(cache.keys().next().value)
      stmt = prepare(sql)
      cache.set(sql, stmt)
    }
    return stmt
  }
  return db
}

let db = null
let view = null
let repo = null

function call(msg) {
  if (msg.kind === 'view') {
    if (!VIEW_METHODS.has(msg.method)) throw new Error(`usage view method not readable: ${msg.method}`)
    view.mutedErrorClasses = Array.isArray(msg.mutedErrorClasses) ? msg.mutedErrorClasses : []
    return view[msg.method](...(msg.args || []))
  }
  if (msg.kind === 'repo') {
    if (!REPO_METHODS.has(msg.method)) throw new Error(`usage repo method not readable: ${msg.method}`)
    return repo[msg.method](...(msg.args || []))
  }
  if (msg.kind === 'vendor') {
    const read = VENDOR_METHODS.get(msg.method)
    if (!read) throw new Error(`vendor usage method not readable: ${msg.method}`)
    return read(db, ...(msg.args || []))
  }
  throw new Error('unknown sqlite worker op')
}

try {
  db = cachedPrepare(new DatabaseSync(workerData.path, { readOnly: true }))
  db.exec('PRAGMA query_only = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA foreign_keys = ON')
  view = new UsageLogsView(db)
  repo = new UsageLogsRepo(db)
  parentPort.on('message', (msg) => {
    if (msg.op === 'all') {
      try {
        parentPort.postMessage({ id: msg.id, ok: true, result: db.prepare(msg.sql).all(...(msg.params || [])) })
      } catch (err) {
        parentPort.postMessage({ id: msg.id, ok: false, error: String(err?.message || err) })
      }
      return
    }
    // 使用记录视图（R6 B6a）与供应商用量报表（R6 B4）经 DbClient 读取，返回 Promise；语句仍同步执行，结果在本条消息的微任务内就绪
    Promise.resolve()
      .then(() => call(msg))
      .then(
        (result) => parentPort.postMessage({ id: msg.id, ok: true, result }),
        (err) => parentPort.postMessage({ id: msg.id, ok: false, error: String(err?.message || err) }),
      )
  })
  parentPort.postMessage({ ready: true })
} catch (err) {
  parentPort.postMessage({ ready: false, error: String(err?.message || err) })
}
