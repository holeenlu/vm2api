import { Worker } from 'node:worker_threads'
import { billingStatsCacheKey } from '../db/repos/usage-logs-repo.mjs'

const MAX_PENDING = 16
const TIMEOUT_MS = 30_000

/** One reporting thread per store; inference scheduling stays in the gateway. */
export class UsageStatsWorker {
  constructor(db, { readOnly = false } = {}) {
    this.dbPath = db
      .prepare('PRAGMA database_list')
      .all()
      .find((row) => row.name === 'main')?.file
    if (!this.dbPath) throw new Error('billing statistics require a file-backed database')
    this.readOnly = readOnly
    this.version = db.prepare('PRAGMA data_version')
    this.changes = db.prepare('SELECT total_changes() AS n')
    this.worker = null
    this.pending = new Map()
    this.active = null
    this.terminating = new Set()
    this.sequence = 0
    this.closed = false
  }

  billingStats(opts = {}) {
    if (this.closed) return Promise.reject(new Error('billing statistics worker is closed'))
    // A call after a committed write must not join a snapshot begun before it.
    const key = JSON.stringify([
      billingStatsCacheKey(opts.accountWindows),
      Object.hasOwn(opts, 'now') ? opts.now : null,
    ])
    const generation = this._generation()
    if (this.active?.key === key && this.active.generation === generation) return this.active.promise
    // Queued queries have not opened their snapshot yet. Merge refreshes here
    // even while new inference records arrive, instead of accumulating scans.
    if (this.pending.has(key)) return this.pending.get(key).promise
    if (this.pending.size >= MAX_PENDING) {
      return Promise.reject(Object.assign(new Error('billing statistics queue is full'), { code: 'stats_busy' }))
    }
    const id = ++this.sequence
    const entry = { id, key, opts: structuredClone(opts) }
    entry.promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        void this._stop(Object.assign(new Error('billing statistics timed out'), { code: 'stats_timeout' }))
      }, TIMEOUT_MS)
      Object.assign(entry, { resolve, reject, timer })
    })
    this.pending.set(key, entry)
    this._dispatch()
    return entry.promise
  }

  _generation() {
    return `${this.version.get().data_version}:${this.changes.get().n}`
  }

  _dispatch() {
    if (this.active || !this.pending.size) return
    const entry = this.pending.values().next().value
    this.pending.delete(entry.key)
    this.active = entry
    try {
      entry.generation = this._generation()
      const worker = this._start()
      worker.ref()
      worker.postMessage({ id: entry.id, opts: entry.opts })
    } catch (error) {
      void this._stop(error)
    }
  }

  _start() {
    if (this.worker) return this.worker
    const worker = new Worker(new URL('./usage-stats-thread.mjs', import.meta.url), {
      workerData: { dbPath: this.dbPath, readOnly: this.readOnly },
      execArgv: process.execArgv.filter((arg) => !arg.startsWith('--input-type')),
    })
    this.worker = worker
    worker.on('message', ({ id, value, error }) => {
      if (this.worker !== worker) return
      const pending = this.active
      if (!pending || pending.id !== id) return
      clearTimeout(pending.timer)
      this.active = null
      if (error) pending.reject(Object.assign(new Error(error.message), { code: error.code }))
      else pending.resolve(value)
      this._dispatch()
      if (!this.active) worker.unref()
    })
    worker.on('error', (error) => {
      if (this.worker === worker) void this._stop(error)
    })
    worker.on('exit', (code) => {
      if (this.worker === worker) void this._stop(new Error(`billing statistics worker exited (${code})`))
    })
    return worker
  }

  _stop(error) {
    const worker = this.worker
    this.worker = null
    for (const { reject, timer } of [...(this.active ? [this.active] : []), ...this.pending.values()]) {
      clearTimeout(timer)
      reject(error)
    }
    this.pending.clear()
    this.active = null
    if (worker) {
      const termination = worker.terminate()
      this.terminating.add(termination)
      void termination.then(() => this.terminating.delete(termination))
    }
    return Promise.all(this.terminating)
  }

  close() {
    this.closed = true
    return this._stop(new Error('billing statistics worker is closed'))
  }
}
