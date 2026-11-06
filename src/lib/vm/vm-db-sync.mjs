/**
 * VM/credential DB mirror — write-through + reconcile + fs.watch.
 *
 * Policy (user requirement: credentials must live in the database):
 *   - vms/*.json stay the runtime single-writer surface (persistOauthToVm,
 *     CLI seed, execution context all read files — no behavior drift).
 *   - Every vm.json write is mirrored into the `vms` table:
 *       1. write-through hook installed on vm-file.atomicWriteJson
 *       2. explicit syncVmFile() calls from writers that bypass vm-file
 *       3. startup reconcile: newer file → upsert; missing file + DB row →
 *          rebuild the file from vm_json (disaster/restore pull-up)
 *       4. fs.watch on vms/ (debounced) catches external edits
 *   - active.json ↔ settings.active_vm mirrored the same way.
 *
 * All entry points no-op safely when the global DB is not open, so unit
 * tests that exercise oauth-credentials/vm-registry against bare temp dirs
 * keep working without a database.
 *
 * R6 B6c: reconcile, watch and delete paths read and write through the async
 * VmsRepo methods.
 *
 * R6 B8: the write-through hook no longer touches the database. The file write
 * stays synchronous (atomicWriteJson, ~140 callers incl. the inference hot
 * path); the hook only queues the file path. An async mirror queue, coalesced
 * per file (only the latest write of a VM is mirrored), re-reads the file and
 * upserts what the file holds now. It runs outside the writer's transaction
 * context (DbClient detached): statements wait for an open transaction to end
 * instead of joining it. The mirror therefore no longer commits or rolls back
 * with the transaction the file was written in — files are not transactional,
 * so the row now always follows the file (a rolled-back transaction that has
 * already rewritten a vm.json used to leave the row behind the file). Readers of
 * the `vms` table (usage-log VM names / ids, request-log owner attribution,
 * reconcile) tolerate the lag of a few microtasks; nothing reads the row inside
 * the transaction that wrote the file. A file that is gone by the time the queue
 * reaches it is skipped (deletes go through removeVmFromDb). flushVmMirror()
 * waits for the queue; flushWrites()/closeDatabase() wait for it as well
 * (trackBackgroundWrite). The fs.watch reconcile stays as the fallback.
 */

import fs from 'node:fs'
import path from 'node:path'
import { isDbOpen, getDb } from '../db/database.mjs'
import { dbClient } from '../db/db-client.mjs'
import { assertOutsideTransaction, trackBackgroundWrite } from '../db/write-behind.mjs'
import { VmsRepo } from '../db/repos/vms-repo.mjs'
import { setVmWriteHook, atomicWriteJson, isVmRecordFile } from './vm-file.mjs'
import { migrateScheduleFields, repairSlotSmbios, repairVmProxyCliEnabled } from './vm-registry.mjs'

let _repo = null
let _watcher = null
let _watchTimer = null
let _projectRoot = null

function repo() {
  if (!isDbOpen()) return null
  if (!_repo || _repo.db !== getDb()) _repo = new VmsRepo(getDb())
  return _repo
}

export function isVmJsonPath(filePath) {
  const base = path.basename(String(filePath || ''))
  const dir = path.basename(path.dirname(String(filePath || '')))
  if (dir !== 'vms') return false
  return isVmRecordFile(base) || base === 'active.json'
}

/** Mirror one vms/*.json file into the DB as it is now (safe no-op without DB or once the file is gone). */
export async function syncVmFile(filePath) {
  const r = repo()
  if (!r) return false
  try {
    const base = path.basename(filePath)
    if (base === 'active.json') {
      const a = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      if (a?.active_vm) await r.setActiveVmId(a.active_vm)
      return true
    }
    const vm = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    if (!vm?.id) return false
    const st = fs.statSync(filePath)
    await r.upsertFromVmJson(vm, { mtimeMs: st.mtimeMs })
    return true
  } catch {
    return false
  }
}

// 写入钩子的异步镜像队列：文件路径按到达顺序，同一文件只保留一项（之后的写入覆盖之前的）
const mirrorPending = new Set()
let mirrorRunning = null

/** Queue a written vms/*.json for mirroring (called by the vm-file write hook; returns at once). */
export function queueVmMirror(filePath) {
  if (!isDbOpen()) return false
  mirrorPending.delete(filePath)
  mirrorPending.add(filePath)
  if (!mirrorRunning) {
    // 脱离写入方的事务上下文：镜像语句排在对方事务之后，不落进对方事务
    mirrorRunning = trackBackgroundWrite(dbClient(getDb()).detached(drainVmMirror))
  }
  return true
}

async function drainVmMirror() {
  try {
    // 先让写入方当前的同步步骤跑完：同一步里对同一 VM 的多次写入只镜像最后一次
    await null
    while (mirrorPending.size) {
      const [file] = mirrorPending
      mirrorPending.delete(file)
      await syncVmFile(file)
    }
  } finally {
    mirrorRunning = null
  }
}

/** Wait until every queued vm.json write is mirrored (tests, shutdown, before reads that need the row now). */
export async function flushVmMirror() {
  if (isDbOpen()) assertOutsideTransaction('flushVmMirror()', getDb())
  while (mirrorRunning) await mirrorRunning
}

/** Remove a VM row (called when the vm.json file is deleted). */
export async function removeVmFromDb(id, actor) {
  const r = repo()
  if (!r || !id) return false
  // 已排队、尚未镜像的写入不再写回这个 VM 的行；正在执行的一项先结束，避免删除后又被写回
  for (const file of mirrorPending) if (path.basename(file) === `${id}.json`) mirrorPending.delete(file)
  await flushVmMirror()
  const removed = await r.remove(id, actor)
  return removed
}

/** Forget settings.active_vm so startup reconcile does not rewrite active.json. */
export async function clearActiveVmFromDb() {
  const r = repo()
  if (!r) return false
  await r.clearActiveVmId()
  return true
}

/**
 * Startup reconcile:
 *   - file newer than DB row (or row missing) → upsert from file
 *   - DB row exists but file missing → rebuild file from vm_json
 * @returns {{ upserted: number, rebuilt: number, active: string|null }}
 */
export async function reconcileVms(projectRoot) {
  const r = repo()
  if (!r) return { upserted: 0, rebuilt: 0, active: null }
  const dir = path.join(projectRoot, 'vms')
  const out = { upserted: 0, rebuilt: 0, active: null }
  const seen = new Set()

  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      if (!isVmRecordFile(f)) continue
      const file = path.join(dir, f)
      try {
        const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (!vm?.id) continue
        seen.add(vm.id)
        const st = fs.statSync(file)
        const row = await r.get(vm.id)
        if (!row || (row.file_mtime_ms || 0) < Math.floor(st.mtimeMs)) {
          await r.upsertFromVmJson(vm, { mtimeMs: st.mtimeMs })
          out.upserted += 1
        }
      } catch {}
    }
  }

  // DB rows without files → rebuild files (restore / disaster pull-up)
  for (const row of await r.list()) {
    if (seen.has(row.id) || !row.vm) continue
    try {
      fs.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, `${row.id}.json`)
      atomicWriteJson(file, row.vm, { mode: 0o600 })
      out.rebuilt += 1
    } catch {}
  }

  // active.json ↔ settings.active_vm
  const activeFile = path.join(dir, 'active.json')
  try {
    if (fs.existsSync(activeFile)) {
      const a = JSON.parse(fs.readFileSync(activeFile, 'utf8'))
      if (a?.active_vm) {
        await r.setActiveVmId(a.active_vm)
        out.active = a.active_vm
      }
    } else {
      const dbActive = r.getActiveVmId()
      if (dbActive) {
        fs.mkdirSync(dir, { recursive: true })
        atomicWriteJson(activeFile, { active_vm: dbActive, updated_at: new Date().toISOString() })
        out.active = dbActive
      }
    }
  } catch {}

  return out
}

/**
 * Install the write-through hook + directory watcher.
 * Call once at server startup, after openDatabase().
 */
export async function initVmDbSync(projectRoot, { watch = true } = {}) {
  _projectRoot = projectRoot
  setVmWriteHook((filePath) => {
    if (isVmJsonPath(filePath)) queueVmMirror(filePath)
  })
  const result = await reconcileVms(projectRoot)
  try {
    result.proxy_cli_repaired = repairVmProxyCliEnabled(projectRoot).length
  } catch {
    result.proxy_cli_repaired = 0
  }
  try {
    result.smbios_repaired = repairSlotSmbios(projectRoot).length
  } catch {
    result.smbios_repaired = 0
  }
  try {
    const migrated = migrateScheduleFields(projectRoot)
    result.schedule_migrated = migrated.length
    for (const row of migrated) {
      console.warn(
        `[vm] schedule state ${row.id}: ${row.from || '-'} -> ${row.state}${row.reason ? `:${row.reason}` : ''}`,
      )
    }
  } catch (error) {
    console.warn(`[vm] schedule state migration failed: ${error?.message || error}`)
    result.schedule_migrated = 0
  }
  if (watch) startVmWatch(projectRoot)
  return result
}

/** Debounced fs.watch on vms/ — catches external edits/manual fixes. */
export function startVmWatch(projectRoot) {
  stopVmWatch()
  const dir = path.join(projectRoot, 'vms')
  if (!fs.existsSync(dir)) return false
  try {
    _watcher = fs.watch(dir, () => {
      if (_watchTimer) clearTimeout(_watchTimer)
      _watchTimer = setTimeout(() => {
        _watchTimer = null
        reconcileDeletionsAndChanges(projectRoot).catch(() => {})
      }, 500)
      if (typeof _watchTimer.unref === 'function') _watchTimer.unref()
    })
    return true
  } catch {
    // non-fatal: write-through hook still covers the primary path
    _watcher = null
    return false
  }
}

async function reconcileDeletionsAndChanges(projectRoot) {
  const r = repo()
  if (!r) return
  await reconcileVmsChangesOnly(projectRoot, r)
}

/** Watch-triggered pass: upsert changed files; DO NOT rebuild deleted files
 *  (a panel-initiated VM delete must stay deleted — server removes the row). */
async function reconcileVmsChangesOnly(projectRoot, r) {
  const dir = path.join(projectRoot, 'vms')
  if (!fs.existsSync(dir)) return
  for (const f of fs.readdirSync(dir)) {
    if (!isVmRecordFile(f)) continue
    const file = path.join(dir, f)
    try {
      const st = fs.statSync(file)
      const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (!vm?.id) continue
      const row = await r.get(vm.id)
      if (!row || (row.file_mtime_ms || 0) < Math.floor(st.mtimeMs)) {
        await r.upsertFromVmJson(vm, { mtimeMs: st.mtimeMs })
      }
    } catch {}
  }
  const activeFile = path.join(dir, 'active.json')
  try {
    if (fs.existsSync(activeFile)) {
      const a = JSON.parse(fs.readFileSync(activeFile, 'utf8'))
      if (a?.active_vm && a.active_vm !== r.getActiveVmId()) await r.setActiveVmId(a.active_vm)
    }
  } catch {}
}

export function stopVmWatch() {
  if (_watchTimer) {
    clearTimeout(_watchTimer)
    _watchTimer = null
  }
  if (_watcher) {
    try {
      _watcher.close()
    } catch {}
    _watcher = null
  }
}

export function getVmSyncProjectRoot() {
  return _projectRoot
}
