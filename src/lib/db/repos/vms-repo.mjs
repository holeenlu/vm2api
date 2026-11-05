/**
 * vms repository — VM records + OAuth credential mirror.
 *
 * The `vms/*.json` files remain the runtime metadata surface.
 * Live OAuth secrets stay in the slot worker credentials.json.
 * This table mirrors identity / expiry / presence flags only.
 * 行读写经 DbClient 异步访问（R6 B6c）；`…Sync` 版本与异步版本共用 SQL，只供同步写钩子（vm-file atomicWriteJson →
 * vm-db-sync syncVmFile）使用，见 docs/data-access/R6_PROGRESS.md。active_vm 存在 settings（同步快照），不在本批改造。
 */

import { getDb } from '../database.mjs'
import { dbClient } from '../db-client.mjs'
import { GroupsRepo } from './groups-repo.mjs'
import { SettingsRepo } from './settings-repo.mjs'
import { maybeEncrypt, maybeDecrypt, encryptionEnabled } from '../secure.mjs'
import { hasAccessPresence, hasRefreshPresence, stripCredentialSecrets } from '../../oauth/oauth-credentials.mjs'
import { normalizeOwnerId, vmOriginOf } from '../../admin/resource-owner.mjs'

const ACTIVE_VM_KEY = 'active_vm'

const GET_SQL = 'SELECT * FROM vms WHERE id = ?'
const LIST_SQL = 'SELECT * FROM vms ORDER BY id'
const IDS_SQL = 'SELECT id FROM vms ORDER BY id'
const COUNT_SQL = 'SELECT COUNT(*) c FROM vms'
const REMOVE_SQL = 'DELETE FROM vms WHERE id = ?'
const UPSERT_SQL = `
      INSERT INTO vms (
        id, name, status, schedulable, email, account_uuid, org_uuid,
        access_token, refresh_token, session_key, oauth_expires_at, oauth_source,
        proxy_id, claude_code_version, timezone, locale,
        owner_user_id, origin,
        vm_json, encrypted, file_mtime_ms, synced_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, status = excluded.status, schedulable = excluded.schedulable,
        email = excluded.email, account_uuid = excluded.account_uuid, org_uuid = excluded.org_uuid,
        access_token = excluded.access_token, refresh_token = excluded.refresh_token,
        session_key = excluded.session_key, oauth_expires_at = excluded.oauth_expires_at,
        oauth_source = excluded.oauth_source, proxy_id = excluded.proxy_id,
        claude_code_version = excluded.claude_code_version, timezone = excluded.timezone,
        locale = excluded.locale, owner_user_id = excluded.owner_user_id, origin = excluded.origin,
        vm_json = excluded.vm_json, encrypted = excluded.encrypted,
        file_mtime_ms = excluded.file_mtime_ms, synced_at = excluded.synced_at,
        updated_at = excluded.updated_at
    `

/** upsertFromVmJson 的参数（异步与同步版本共用）。 */
function upsertParams(vm, mtimeMs) {
  const now = new Date().toISOString()
  const c = vm.claude || {}
  const safeClaude = stripCredentialSecrets({
    ...c,
    has_access: hasAccessPresence(c),
    has_refresh: hasRefreshPresence(c),
  })
  const safeVm = { ...vm, claude: safeClaude }
  const enc = encryptionEnabled()
  return [
    vm.id,
    vm.name ?? null,
    vm.status ?? null,
    vm.schedulable === false ? 0 : 1,
    safeClaude.email ?? null,
    safeClaude.account_uuid ?? null,
    safeClaude.org_uuid ?? null,
    null,
    null,
    null,
    c.expires_at != null ? String(c.expires_at) : null,
    safeClaude.source ?? null,
    vm.proxy?.id ?? null,
    vm.claude_code_version ?? null,
    vm.timezone ?? null,
    vm.locale ?? null,
    normalizeOwnerId(vm.owner_user_id),
    vmOriginOf(vm),
    enc ? maybeEncrypt(JSON.stringify(safeVm)) : JSON.stringify(safeVm),
    enc ? 1 : 0,
    mtimeMs != null ? Math.floor(mtimeMs) : null,
    now,
    vm.created_at ?? now,
    now,
  ]
}

export class VmsRepo {
  constructor(db = getDb()) {
    this.db = db
    this.settings = new SettingsRepo(db)
  }

  /** Mirror a parsed vm.json object into the table. */
  async upsertFromVmJson(vm, { mtimeMs = null } = {}) {
    if (!vm?.id) return null
    await dbClient(this.db).run(UPSERT_SQL, ...upsertParams(vm, mtimeMs))
    return this.get(vm.id)
  }

  /**
   * R6 临时同步出口（B8 删除）：vm.json 写入钩子（vm-file atomicWriteJson → vm-db-sync syncVmFile）同步镜像。
   * atomicWriteJson 是同步文件写入，调用方遍布推理热路径与同步事务，钩子无法等待。
   */
  upsertFromVmJsonSync(vm, { mtimeMs = null } = {}) {
    if (!vm?.id) return null
    dbClient(this.db).runSync(UPSERT_SQL, ...upsertParams(vm, mtimeMs))
    return this.getSync(vm.id)
  }

  /** Returns {row, vm} — row has decrypted credential columns, vm is the parsed vm.json. */
  async get(id) {
    return this._decode(await dbClient(this.db).one(GET_SQL, id))
  }

  /** R6 临时同步出口（B8 删除）：同上，upsertFromVmJsonSync 写后读回。 */
  getSync(id) {
    return this._decode(dbClient(this.db).oneSync(GET_SQL, id))
  }

  async list() {
    return (await dbClient(this.db).many(LIST_SQL)).map((r) => this._decode(r))
  }

  async ids() {
    return (await dbClient(this.db).many(IDS_SQL)).map((r) => r.id)
  }

  async remove(id, actor = 'system') {
    return dbClient(this.db).tx(async (tx) => {
      const groups = new GroupsRepo(this.db)
      await groups.assignResource('vm', id, [], await groups.resourceVersion('vm', id), actor)
      return (await tx.run(REMOVE_SQL, id)).changes > 0
    })
  }

  async count() {
    return (await dbClient(this.db).one(COUNT_SQL)).c
  }

  getActiveVmId() {
    return this.settings.get(ACTIVE_VM_KEY, null)
  }

  // R6 临时同步出口，B8 删除：vm.json 同步写钩子与启动导入在同步上下文里记录活跃 VM
  setActiveVmId(id) {
    this.settings.setSync(ACTIVE_VM_KEY, id)
  }

  clearActiveVmId() {
    this.settings.removeSync(ACTIVE_VM_KEY)
  }

  _decode(row) {
    if (!row) return null
    let vm = null
    try {
      vm = JSON.parse(maybeDecrypt(row.vm_json))
    } catch {
      vm = null
    }
    return {
      id: row.id,
      name: row.name,
      status: row.status,
      schedulable: !!row.schedulable,
      email: row.email,
      account_uuid: row.account_uuid,
      org_uuid: row.org_uuid,
      access_token: maybeDecrypt(row.access_token),
      refresh_token: maybeDecrypt(row.refresh_token),
      session_key: maybeDecrypt(row.session_key),
      oauth_expires_at: row.oauth_expires_at,
      oauth_source: row.oauth_source,
      proxy_id: row.proxy_id,
      claude_code_version: row.claude_code_version,
      timezone: row.timezone,
      locale: row.locale,
      encrypted: !!row.encrypted,
      file_mtime_ms: row.file_mtime_ms,
      synced_at: row.synced_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
      vm,
    }
  }
}
