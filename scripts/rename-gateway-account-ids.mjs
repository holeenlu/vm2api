#!/usr/bin/env node
/**
 * Gateway 账号统一编号：把早期的 `account_<uuid>` 账号离线改名为 `gw-NN`（与新账号同一序列，见 account-ids.mjs）。
 * 运行手册：docs/GATEWAY_ACCOUNT_ID_RENAME.md。控制面与所有 Worker 必须先停止。
 *
 *   node scripts/rename-gateway-account-ids.mjs --data-dir data --plan plan.json    # 只读：按创建时间分配编号，写出改名计划
 *   node scripts/rename-gateway-account-ids.mjs --data-dir data --apply plan.json   # 一个事务内按计划改名
 *   node scripts/rename-gateway-account-ids.mjs --data-dir data --worker plan.json  # Worker 侧离线改名（见下）
 *   node scripts/rename-gateway-account-ids.mjs --data-dir data --verify plan.json  # 只读：残留扫描与凭据解密校验
 *
 * 改名范围：旧 ID 是带 UUID 的唯一字符串，派生形式（运行账号 `gwacct_<ID>`、用量键 `gateway:<ID>`、绑定行
 * `binding_<ID>_<实例>`、JSON 里的账号字段）都把它原样包含在内，因此对每张表的文本列做“旧 ID → 新 ID”的子串替换。
 * 例外：
 *   - executor_credentials：附加认证数据含账号 ID，用旧 ID 解开、按新 ID 重新封装（vault.mjs resealCredentialForAccount）；
 *   - usage_cost_hourly / usage_stats_hourly：由 usage_logs 的更新触发器随之搬桶，直接改会重复计数；
 *   - operation_audit、vendor_audit_events、vendor_settlements、vendor_settlement_previews：审计与结算证据保持原样，
 *     另写一条 gateway.account_ids_renamed 审计记录完整映射；
 *   - 未完成的 OAuth 授权会话（密文里带旧 ID）立即过期，需要时重新生成授权链接。
 * Worker 侧（accounts.json 等）由 `kin-codex-gateway -rename-accounts plan.json` 完成；--worker 按控制面托管 Worker 的
 * 同一套环境（runtime-secrets 里的 bundle 密钥、数据目录、实例与 Redis 配置）调用它，不必手工拼环境变量。
 * 脚本不执行数据库迁移，库结构落后于本版本代码时报错；重复 --apply 已完成的计划不做任何改动。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadRuntimeSecretsReadOnly } from '../src/lib/core/runtime-secrets.mjs'
import { openScriptDatabase } from '../src/lib/executor/repos/script-db-repo.mjs'
import { loadKeyring, resealCredentialForAccount } from '../src/lib/executor/vault.mjs'
import {
  GATEWAY_ACCOUNT_ID_PREFIX,
  GATEWAY_ACCOUNT_SEQ_KEY,
  gatewayAccountNumber,
} from '../src/lib/gateway-worker/account-ids.mjs'
import { supervisedWorkerEnv } from '../src/lib/gateway-worker/worker-supervisor.mjs'

const PLAN_KIND = 'gateway-account-id-rename'
const LEGACY_ID = /^account_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const RUNTIME_PREFIX = 'gwacct_'
const ACTOR = 'ops:rename-gateway-account-ids'
// 不做子串替换的表（原因见文件头）；sqlite_ 内部表与迁移台账也跳过
const SPECIAL_TABLES = new Set(['executor_credentials'])
const TRIGGER_MAINTAINED = new Set(['usage_cost_hourly', 'usage_stats_hourly'])
const EVIDENCE_TABLES = new Set([
  'operation_audit',
  'vendor_audit_events',
  'vendor_settlements',
  'vendor_settlement_previews',
  'schema_migrations',
  'relay_migrations',
])

const quote = (name) => `"${String(name).replaceAll('"', '""')}"`
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function legacyGatewayAccounts(db) {
  return db
    .prepare(
      `SELECT id,name,status,created_at FROM vendor_resources
        WHERE resource_type='account' AND json_extract(config_json,'$.execution_kind')='gateway_worker'
          AND id NOT LIKE '${GATEWAY_ACCOUNT_ID_PREFIX}%'
        ORDER BY created_at, id`,
    )
    .all()
}

function highWaterMark(db) {
  const seq = Number(db.prepare('SELECT value FROM settings WHERE key=?').get(GATEWAY_ACCOUNT_SEQ_KEY)?.value || 0)
  const used = db
    .prepare(`SELECT id FROM vendor_resources WHERE id LIKE '${GATEWAY_ACCOUNT_ID_PREFIX}%'`)
    .all()
    .map((row) => gatewayAccountNumber(row.id))
  return Math.max(seq, 0, ...used)
}

/** 只读：按创建时间（同时刻按 ID）从当前高水位之后依次分配编号。 */
export function planRename(db, { now = () => new Date() } = {}) {
  const legacy = legacyGatewayAccounts(db)
  const odd = legacy.filter((row) => !LEGACY_ID.test(row.id))
  if (odd.length) throw new Error(`unexpected Gateway account ids: ${odd.map((row) => row.id).join(', ')}`)
  const start = highWaterMark(db)
  const runtimeOf = db.prepare(
    'SELECT DISTINCT runtime_account_id FROM gateway_worker_account_bindings WHERE account_resource_id=?',
  )
  const accounts = legacy.map((row, index) => {
    const resourceNew = GATEWAY_ACCOUNT_ID_PREFIX + String(start + index + 1).padStart(2, '0')
    const runtimes = runtimeOf.all(row.id).map((binding) => binding.runtime_account_id)
    if (runtimes.length > 1) throw new Error(`${row.id} has several runtime accounts: ${runtimes.join(', ')}`)
    const runtimeOld = runtimes[0] || RUNTIME_PREFIX + row.id
    if (!runtimeOld.includes(row.id)) throw new Error(`${row.id} runtime account ${runtimeOld} does not embed the id`)
    return {
      resource_id_old: row.id,
      resource_id_new: resourceNew,
      runtime_id_old: runtimeOld,
      runtime_id_new: runtimeOld.replaceAll(row.id, resourceNew),
      name: row.name,
      status: row.status,
      created_at: row.created_at,
    }
  })
  return { kind: PLAN_KIND, version: 1, created_at: now().toISOString(), seq_after: start + accounts.length, accounts }
}

function validatePlan(plan) {
  if (plan?.kind !== PLAN_KIND || plan.version !== 1 || !Array.isArray(plan.accounts) || !plan.accounts.length)
    throw new Error('not a gateway account rename plan')
  const mapping = new Map()
  const targets = new Set()
  for (const item of plan.accounts) {
    const from = item.resource_id_old
    const to = item.resource_id_new
    if (!LEGACY_ID.test(String(from || ''))) throw new Error(`invalid old id ${from}`)
    if (!gatewayAccountNumber(to)) throw new Error(`invalid new id ${to}`)
    if (mapping.has(from) || targets.has(to)) throw new Error(`plan repeats ${from} or ${to}`)
    if (item.runtime_id_new !== String(item.runtime_id_old || '').replaceAll(from, to))
      throw new Error(`runtime ids of ${from} do not follow the resource rename`)
    mapping.set(from, to)
    targets.add(to)
  }
  return mapping
}

function remapper(mapping) {
  const pattern = [...mapping.keys()].map(escapeRegExp).join('|')
  const probe = new RegExp(pattern)
  const global = new RegExp(pattern, 'g')
  return {
    hit: (value) => (typeof value === 'string' && value.includes('account_') && probe.test(value) ? 1 : 0),
    remap: (value) =>
      typeof value === 'string' && value.includes('account_') ? value.replace(global, (id) => mapping.get(id)) : value,
  }
}

function textColumns(db, table) {
  return db
    .prepare(`PRAGMA table_info(${quote(table)})`)
    .all()
    .filter((column) => {
      const type = String(column.type || '').toUpperCase()
      return type === '' || type.includes('TEXT') || type.includes('CHAR') || type.includes('CLOB') || type === 'JSON'
    })
    .map((column) => column.name)
}

function userTables(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name)
}

function registerFunctions(db, mapping) {
  const { hit, remap } = remapper(mapping)
  db.function('gwid_hit', { deterministic: true }, hit)
  db.function('gwid_remap', { deterministic: true }, remap)
}

/** 每张表里仍含旧 ID 的行数（按列），供 --verify 与 --apply 收尾校验。 */
function residuals(db, tables) {
  const found = {}
  for (const table of tables) {
    for (const column of textColumns(db, table)) {
      const n = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${quote(table)} WHERE gwid_hit(${quote(column)})`).get().n)
      if (n) found[`${table}.${column}`] = n
    }
  }
  return found
}

function accountState(db, plan) {
  const exists = db.prepare('SELECT 1 FROM vendor_resources WHERE id=?')
  const state = { pending: [], done: [] }
  for (const item of plan.accounts) {
    const hasOld = Boolean(exists.get(item.resource_id_old))
    const hasNew = Boolean(exists.get(item.resource_id_new))
    if (hasOld && hasNew) throw new Error(`both ${item.resource_id_old} and ${item.resource_id_new} exist`)
    if (!hasOld && !hasNew) throw new Error(`neither ${item.resource_id_old} nor ${item.resource_id_new} exists`)
    state[hasOld ? 'pending' : 'done'].push(item)
  }
  if (state.pending.length && state.done.length)
    throw new Error('plan is partially applied; restore the backup before retrying')
  return state
}

/** 一个事务内按计划改名；任何一步失败整体回滚。 */
export function applyRename(db, plan, { keyring, now = () => new Date() } = {}) {
  const mapping = validatePlan(plan)
  const state = accountState(db, plan)
  if (!state.pending.length) return { already_applied: true, accounts: plan.accounts.length }
  if (highWaterMark(db) >= gatewayAccountNumber(plan.accounts[0].resource_id_new))
    throw new Error('a gw- id at or above the planned range is already in use; create a fresh plan')
  registerFunctions(db, mapping)
  const stamp = now().toISOString()
  const report = { accounts: plan.accounts.length, credentials_resealed: 0, oauth_sessions_expired: 0, tables: {} }
  const olds = [...mapping.keys()]
  const marks = olds.map(() => '?').join(',')
  db.exec('BEGIN IMMEDIATE')
  try {
    // 父行（vendor_resources.id）与子表外键在同一事务里先后改写，提交时统一检查
    db.exec('PRAGMA defer_foreign_keys = ON')
    const credentials = db
      .prepare(`SELECT * FROM executor_credentials WHERE account_resource_id IN (${marks})`)
      .all(...olds)
    if (credentials.length && !keyring) throw new Error('credential master keys are required to reseal credentials')
    const reseal = db.prepare(
      'UPDATE executor_credentials SET account_resource_id=?,master_key_id=?,wrapped_key=?,ciphertext=? WHERE account_resource_id=? AND grant_kind=?',
    )
    for (const row of credentials) {
      const to = mapping.get(row.account_resource_id)
      const sealed = resealCredentialForAccount(keyring, row, to)
      reseal.run(
        to,
        sealed.master_key_id,
        sealed.wrapped_key,
        sealed.ciphertext,
        row.account_resource_id,
        row.grant_kind,
      )
      report.credentials_resealed++
    }
    report.oauth_sessions_expired = Number(
      db
        .prepare(
          `UPDATE gateway_worker_oauth_sessions SET expires_at=?,updated_at=? WHERE status='pending' AND expires_at>? AND account_resource_id IN (${marks})`,
        )
        .run(stamp, stamp, stamp, ...olds).changes,
    )
    for (const table of userTables(db)) {
      if (SPECIAL_TABLES.has(table) || TRIGGER_MAINTAINED.has(table) || EVIDENCE_TABLES.has(table)) continue
      const columns = textColumns(db, table)
      if (!columns.length) continue
      const set = columns.map((column) => `${quote(column)}=gwid_remap(${quote(column)})`).join(',')
      const where = columns.map((column) => `gwid_hit(${quote(column)})`).join(' OR ')
      const changes = Number(db.prepare(`UPDATE ${quote(table)} SET ${set} WHERE ${where}`).run().changes)
      if (changes) report.tables[table] = changes
    }
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
         WHERE CAST(settings.value AS INTEGER) < CAST(excluded.value AS INTEGER)`,
    ).run(GATEWAY_ACCOUNT_SEQ_KEY, String(plan.seq_after), stamp)
    db.prepare(
      'INSERT INTO operation_audit(actor,action,target,before_json,after_json,reason,created_at) VALUES(?,?,?,?,?,?,?)',
    ).run(
      ACTOR,
      'gateway.account_ids_renamed',
      'gateway_worker_accounts',
      JSON.stringify(olds),
      JSON.stringify(Object.fromEntries(mapping)),
      'Gateway 账号统一编号 gw-NN（docs/GATEWAY_ACCOUNT_ID_RENAME.md）',
      stamp,
    )
    const violations = Object.keys(report.tables).flatMap((table) =>
      db.prepare(`PRAGMA foreign_key_check(${quote(table)})`).all(),
    )
    if (violations.length) throw new Error(`foreign key violations: ${JSON.stringify(violations.slice(0, 5))}`)
    // 其余表刚按子串整体改写过；汇总表靠触发器搬桶，这里确认没有留下旧账号的桶（完整扫描见 --verify）
    const left = residuals(db, [...TRIGGER_MAINTAINED])
    if (Object.keys(left).length) throw new Error(`old ids remain in rollups: ${JSON.stringify(left)}`)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return report
}

/** 只读：残留扫描（审计与结算表单独列出）、凭据按新 ID 解密、绑定与高水位核对。 */
export function verifyRename(db, plan, { keyring } = {}) {
  const mapping = validatePlan(plan)
  registerFunctions(db, mapping)
  const tables = userTables(db)
  const result = {
    residual: residuals(
      db,
      tables.filter((table) => !EVIDENCE_TABLES.has(table)),
    ),
    evidence_kept: residuals(
      db,
      tables.filter((table) => EVIDENCE_TABLES.has(table)),
    ),
    credentials_checked: 0,
    problems: [],
  }
  const news = [...mapping.values()]
  const marks = news.map(() => '?').join(',')
  for (const row of db
    .prepare(`SELECT * FROM executor_credentials WHERE account_resource_id IN (${marks})`)
    .all(...news)) {
    try {
      resealCredentialForAccount(keyring, row, row.account_resource_id)
      result.credentials_checked++
    } catch (error) {
      result.problems.push(`credential ${row.account_resource_id}/${row.grant_kind}: ${error.code || error.message}`)
    }
  }
  const binding = db.prepare(
    'SELECT runtime_account_id FROM gateway_worker_account_bindings WHERE account_resource_id=?',
  )
  const exists = db.prepare('SELECT 1 FROM vendor_resources WHERE id=?')
  for (const item of plan.accounts) {
    if (!exists.get(item.resource_id_new)) result.problems.push(`missing account ${item.resource_id_new}`)
    for (const row of binding.all(item.resource_id_new))
      if (row.runtime_account_id !== item.runtime_id_new)
        result.problems.push(`binding ${item.resource_id_new} runtime ${row.runtime_account_id}`)
  }
  if (highWaterMark(db) < plan.seq_after) result.problems.push(`high-water mark below ${plan.seq_after}`)
  result.ok = !result.problems.length && !Object.keys(result.residual).length
  return result
}

/** Worker 侧改名：与控制面托管 Worker 相同的环境与二进制，执行 `-rename-accounts`；返回进程退出码。 */
export function renameWorkerAccounts({ planFile, root, dataDir, env = process.env, spawn = spawnSync }) {
  const base = { ...env }
  loadRuntimeSecretsReadOnly({ env: base, root })
  const workerEnv = supervisedWorkerEnv({ env: base, root, dataDir })
  const bin = workerEnv.KIN_CODEX_GATEWAY_BIN || path.join(root, 'bin', 'kin-codex-gateway')
  const result = spawn(bin, ['-rename-accounts', planFile], { env: workerEnv, stdio: 'inherit' })
  if (result.error) throw result.error
  return result.status
}

async function main(argv) {
  const value = (flag) => {
    const index = argv.indexOf(flag)
    return index >= 0 ? argv[index + 1] : null
  }
  const actions = ['--plan', '--apply', '--worker', '--verify'].filter((flag) => argv.includes(flag))
  if (actions.length !== 1 || !value(actions[0])) {
    console.error(
      'usage: rename-gateway-account-ids.mjs --data-dir <dir> [--key-file <file>] (--plan <out.json> | --apply <plan.json> | --worker <plan.json> | --verify <plan.json>)',
    )
    process.exitCode = 2
    return
  }
  const action = actions[0]
  const planFile = path.resolve(value(action))
  const dataDir = path.resolve(value('--data-dir') || process.env.KIN_DATA_DIR || 'data')
  const keyFile = path.resolve(
    value('--key-file') ||
      process.env.KIN_CREDENTIAL_MASTER_KEY_FILE ||
      path.join(dataDir, 'credential-master-keys.json'),
  )
  if (action === '--worker') {
    const root = path.resolve(
      value('--root') || process.env.KIN_PROJECT_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'),
    )
    process.exitCode = renameWorkerAccounts({ planFile, root, dataDir }) ?? 1
    return
  }
  const keyring = () => (fs.existsSync(keyFile) ? loadKeyring({ file: keyFile, create: false }) : null)
  const db = openScriptDatabase({ dataDir, readOnly: action !== '--apply' })
  try {
    if (action === '--plan') {
      const plan = planRename(db)
      fs.writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
      console.log(
        JSON.stringify({ plan: planFile, accounts: plan.accounts.length, seq_after: plan.seq_after }, null, 2),
      )
      return
    }
    const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'))
    const result =
      action === '--apply'
        ? applyRename(db, plan, { keyring: keyring() })
        : verifyRename(db, plan, { keyring: keyring() })
    console.log(JSON.stringify(result, null, 2))
    if (action === '--verify' && !result.ok) process.exitCode = 1
  } finally {
    db.close()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main(process.argv.slice(2))
