/**
 * One-time import of legacy JSON stores into SQLite.
 *
 * Sources (all optional — skipped when missing/corrupt):
 *   data/api-keys.json          → api_keys
 *   data/account-stats.json     → accounts + account_allocations
 *   data/sticky-map.json        → sticky_sessions
 *   data/proxy-pool.json        → proxies + settings.proxy_pool_config
 *   data/request-logs/*.jsonl   → request_logs   (recent retainDays)
 *   data/request-logs/debug/**  → request_log_debug
 *   vms/*.json + active.json    → vms + settings.active_vm
 *
 * Idempotent: guarded by settings.legacy_import_done. Original files are
 * left untouched as a rollback safety net (they are no longer read/written,
 * except vms/*.json which stay the runtime mirror surface).
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { getDb } from './database.mjs'
import { dbClient } from './db-client.mjs'
import { SettingsRepo } from './repos/settings-repo.mjs'
import { ApiKeysRepo } from './repos/api-keys-repo.mjs'
import { AccountsRepo } from './repos/accounts-repo.mjs'
import { StickyRepo } from './repos/sticky-repo.mjs'
import { ProxiesRepo } from './repos/proxies-repo.mjs'
import { VmsRepo } from './repos/vms-repo.mjs'
import { UsageLogsRepo } from './repos/usage-logs-repo.mjs'
import { isVmRecordFile } from '../vm/vm-file.mjs'

const IMPORT_FLAG = 'legacy_import_done'

function readJson(file) {
  try {
    if (!fs.existsSync(file)) return null
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined // corrupt (≠ missing)
  }
}

export async function runLegacyImport({ dataDir, projectRoot, db = null, retainDays = 7 } = {}) {
  const d = db || getDb()
  const settings = new SettingsRepo(d)
  const existing = settings.get(IMPORT_FLAG)
  if (existing) return { imported: false, already: existing }

  const counts = {
    api_keys: 0,
    accounts: 0,
    allocations: 0,
    sticky: 0,
    proxies: 0,
    request_logs: 0,
    request_log_debug: 0,
    vms: 0,
    errors: 0,
  }

  // 事务内只有数据库操作与同步文件读取（R6 B6c：代理与 VM 镜像仓储已改 async，其余仓储仍同步执行于同一事务）
  await dbClient(d).tx(async () => {
    // --- api keys ---
    try {
      const raw = readJson(path.join(dataDir, 'api-keys.json'))
      if (raw === undefined) counts.errors += 1
      const repo = new ApiKeysRepo(d)
      for (const k of raw?.keys || []) {
        if (!k?.id || !k?.key || (await repo.getById(k.id)) || (await repo.getByKey(k.key))) continue
        // legacy `quota_used` was a request counter; the column is USD now
        const { quota_used, ...rest } = k
        await repo.insert({
          ...rest,
          quota_requests_used: k.quota_requests_used ?? quota_used ?? 0,
          category: String(k.category || 'oauth').toLowerCase() === 'api' ? 'api' : 'oauth',
        })
        counts.api_keys += 1
      }
    } catch {
      counts.errors += 1
    }

    // --- account stats ---
    try {
      const raw = readJson(path.join(dataDir, 'account-stats.json'))
      if (raw === undefined) counts.errors += 1
      const repo = new AccountsRepo(d)
      for (const acc of Object.values(raw?.accounts || {})) {
        if (!acc?.account_id || (await repo.get(acc.account_id))) continue
        await repo.insert(acc)
        counts.accounts += 1
        for (const alloc of acc.allocations || []) {
          await repo.addAllocation(acc.account_id, alloc)
          counts.allocations += 1
        }
      }
    } catch {
      counts.errors += 1
    }

    // --- sticky sessions ---
    try {
      const raw = readJson(path.join(dataDir, 'sticky-map.json'))
      if (raw === undefined) counts.errors += 1
      const repo = new StickyRepo(d)
      for (const [key, ent] of Object.entries(raw?.sessions || {})) {
        if (!key || (await repo.get(key))) continue
        await repo.upsert(key, ent)
        counts.sticky += 1
      }
    } catch {
      counts.errors += 1
    }

    // --- proxy pool ---
    try {
      const raw = readJson(path.join(dataDir, 'proxy-pool.json'))
      if (raw === undefined) counts.errors += 1
      if (raw?.proxies?.length || raw?.config) {
        const repo = new ProxiesRepo(d)
        if (raw.config) repo.setConfig(raw.config)
        const current = await repo.loadAll()
        if (!current.length && Array.isArray(raw.proxies)) {
          await repo.replaceAll(raw.proxies)
          counts.proxies = raw.proxies.length
        }
      }
    } catch {
      counts.errors += 1
    }

    // --- request logs (normal summaries, recent days) ---
    try {
      const repo = new UsageLogsRepo(d)
      const root = path.join(dataDir, 'request-logs')
      if (fs.existsSync(root)) {
        const cutoff = Date.now() - retainDays * 86400_000
        for (const f of fs.readdirSync(root)) {
          if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) continue
          const dayMs = Date.parse(f.slice(0, 10) + 'T00:00:00Z')
          if (Number.isFinite(dayMs) && dayMs < cutoff) continue
          try {
            const lines = fs.readFileSync(path.join(root, f), 'utf8').split('\n').filter(Boolean)
            for (const line of lines) {
              try {
                const rec = JSON.parse(line)
                if (!rec?.id) rec.id = 'log_' + crypto.randomBytes(6).toString('hex')
                if (repo.insertSummaryIfAbsent(rec)) counts.request_logs += 1
              } catch {
                counts.errors += 1
              }
            }
          } catch {
            counts.errors += 1
          }
        }
        // --- debug records ---
        const dbgRoot = path.join(root, 'debug')
        if (fs.existsSync(dbgRoot)) {
          for (const day of fs.readdirSync(dbgRoot)) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue
            const dayMs = Date.parse(day + 'T00:00:00Z')
            if (Number.isFinite(dayMs) && dayMs < cutoff) continue
            const dir = path.join(dbgRoot, day)
            let files = []
            try {
              files = fs.readdirSync(dir).filter((x) => x.endsWith('.json'))
            } catch {
              continue
            }
            for (const f of files) {
              try {
                const rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
                const reqId = rec?.request_id || f.replace(/\.json$/, '')
                if (repo.insertDebugIfAbsent(reqId, rec?.ts || new Date(dayMs).toISOString(), rec)) {
                  counts.request_log_debug += 1
                }
              } catch {
                counts.errors += 1
              }
            }
          }
        }
      }
    } catch {
      counts.errors += 1
    }

    // --- vms + active ---
    try {
      const repo = new VmsRepo(d)
      const vmsDir = projectRoot ? path.join(projectRoot, 'vms') : null
      if (vmsDir && fs.existsSync(vmsDir)) {
        for (const f of fs.readdirSync(vmsDir)) {
          if (!isVmRecordFile(f)) continue
          try {
            const file = path.join(vmsDir, f)
            const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
            if (!vm?.id || (await repo.get(vm.id))) continue
            const st = fs.statSync(file)
            await repo.upsertFromVmJson(vm, { mtimeMs: st.mtimeMs })
            counts.vms += 1
          } catch {
            counts.errors += 1
          }
        }
        const active = readJson(path.join(vmsDir, 'active.json'))
        if (active?.active_vm) repo.setActiveVmId(active.active_vm)
      }
    } catch {
      counts.errors += 1
    }

    // R6 临时同步出口：启动期一次性导入在同步事务里写完成标记（B8 处理）
    settings.setSync(IMPORT_FLAG, { at: new Date().toISOString(), counts })
  })

  return { imported: true, counts }
}
