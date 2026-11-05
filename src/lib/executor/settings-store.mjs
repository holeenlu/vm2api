/**
 * 执行服务设置存储（统一控制面重构 P4.2–P4.3，设计第 10 节）。
 *
 * 本地设置（上游 routing.json 之外的键，定义见 codex-settings.mjs）保存在控制面数据库 executor_settings，
 * 每次修改推进设置版本（config_revisions 记录每一版改了哪些键、由谁改），并写审计。对外字段名为 settings_revision，
 * 与上游 routing.json 的运行配置版本（usage_logs.config_revision）区分（R4 审查 P1-2）。
 *
 * 导入：控制面启动（以及从备份恢复）时，在加载 routing.json 之前调用 migrateRoutingFile：数据库还没有 codex 设置时
 * 把文件里的本地键写入数据库；然后备份原文件并删除这些键（R4 审查 P0-1、P1-4）。
 *
 * 读取（R6 B3）：请求路径同步调用 readCodexSettings / codexSettingsSnapshot / codexSettings，签名保持同步，返回进程内快照：
 *   - 快照 1 秒内直接返回；超过 1 秒仍立即返回现有快照，同时在后台发起一次异步刷新（同一数据库同一时刻只有一次），
 *     经 DbClient 读设置版本与设置行，刷新完成后后续读取即得到新值（多进程部署下最多约 1 秒加一次读取看到旧值）；
 *   - 服务启动时在 migrateRoutingFile 之后 await warmCodexSettings 预热；冷启动且尚未预热时（单测、工具进程）
 *     同步读一次（R6 临时同步出口，B8 删除）；
 *   - 写入后立即把新值放进快照，下次读取直接得到新值；写入期间开始的后台刷新结果作废；
 *   - 读取出错时保留上一份有效值并告警，不把默认值当成有效设置缓存（R4 审查 P1-3）。
 * 写入（R6 B3，竞态 R17）：新增设置版本（INSERT … RETURNING revision）与写设置行、审计在同一个 db.tx 里。
 */
import fs from 'node:fs'
import { getDb } from '../db/database.mjs'
import { dbClient } from '../db/db-client.mjs'
import { routingConfigFile } from '../core/config.mjs'
import { atomicWriteJson } from '../vm/vm-file.mjs'
import { insertOperationAudit } from '../admin/repos/relay-repo.mjs'
import {
  insertConfigRevision,
  latestConfigRevision,
  latestConfigRevisionSync,
  loadSettingsRow,
  loadSettingsRowSync,
  upsertSettings,
} from './repos/settings-repo.mjs'
import {
  CODEX_LOCAL_SETTING_KEYS,
  DEFAULT_CODEX_SETTINGS,
  linkCodexSettings,
  normalizeCodexSettings,
  pickCodexLocalSettings,
} from './codex-settings.mjs'
import { SchemaValidationError, validateCodexSettingsPatch } from './settings-schema.mjs'
import { normalizeCodexScheduling } from '../pool/codex-scheduling-policy.mjs'

export const SETTINGS_SCOPES = Object.freeze(['codex'])
const CACHE_CHECK_MS = 1000

// 每个数据库对象一份：快照、进行中的后台刷新、写入代数（写入开始与结束各加一，刷新期间变过则结果作废）
const cache = new Map()
const refreshing = new Map()
const generations = new Map()

function stamp() {
  return new Date().toISOString()
}

function warn(message) {
  console.warn(`executor settings: ${message}`)
}

const generationOf = (db) => generations.get(db) || 0
const bumpGeneration = (db) => generations.set(db, generationOf(db) + 1)

async function latestRevision(db) {
  return Number((await latestConfigRevision(db)) || 0)
}

/** 当前设置版本（没有任何本地设置写入时为 0）；读取失败返回 null。 */
export async function currentSettingsRevision(db) {
  try {
    return await latestRevision(db)
  } catch {
    return null
  }
}

const parseRow = (row) => (row ? { values: JSON.parse(row.values_json || '{}'), revision: Number(row.revision) } : null)

async function load(db, scope) {
  return parseRow(await loadSettingsRow(db, scope))
}

// 从未读到过有效设置时的占位：请求路径按默认值执行，保存被拒绝（不能以默认值为基础覆盖数据库里的设置）
const unreadable = () => ({
  values: DEFAULT_CODEX_SETTINGS,
  revision: 0,
  stored: false,
  checkedAt: 0,
  unreadable: true,
})

// 由设置行得到快照并放进缓存
function remember(db, stored, revision) {
  const value = {
    values: stored ? normalizeCodexSettings(stored.values) : DEFAULT_CODEX_SETTINGS,
    // 版本取设置行自身的版本，与值来自同一条记录（版本表与设置行分两次读取，多进程下可能错开，终审 A8）
    revision: stored ? stored.revision : revision,
    stored: !!stored,
    checkedAt: Date.now(),
  }
  cache.set(db, value)
  return value
}

/**
 * 经 DbClient 重新读取：版本未变只刷新检查时间；读取失败保留上一份有效值并告警。返回读取后的快照
 * （从未读到过有效值时为占位快照）。写入期间开始的刷新不改缓存。
 */
async function refresh(db) {
  const generation = generationOf(db)
  const revision = await currentSettingsRevision(db)
  if (revision === null) {
    warn('reading the settings revision failed; keeping the last good settings')
    return cache.get(db) || unreadable()
  }
  const cached = cache.get(db)
  // 读取期间有写入：以写入放进快照的值为准；写入尚未完成时重读一次
  if (generation !== generationOf(db)) return cached || refresh(db)
  if (cached && cached.revision === revision) {
    cached.checkedAt = Date.now()
    return cached
  }
  let stored
  try {
    stored = await load(db, 'codex')
  } catch (error) {
    warn(`reading codex settings failed: ${error?.message || error}; keeping the last good settings`)
    return cache.get(db) || unreadable()
  }
  if (generation !== generationOf(db)) return cache.get(db) || refresh(db)
  return remember(db, stored, revision)
}

// 同一数据库同一时刻只有一次刷新；刷新本身不抛错（意外错误按读取失败处理）
function refreshOnce(db) {
  let running = refreshing.get(db)
  if (running) return running
  running = Promise.resolve()
    .then(() => refresh(db))
    .catch((error) => {
      warn(`refreshing codex settings failed: ${error?.message || error}; keeping the last good settings`)
      return cache.get(db) || unreadable()
    })
    .finally(() => {
      if (refreshing.get(db) === running) refreshing.delete(db)
    })
  refreshing.set(db, running)
  return running
}

/**
 * R6 临时同步出口（B8 删除）：冷启动且尚未预热时（单测、不接服务启动流程的工具进程）同步读一次。
 * 逻辑同 refresh；读取失败返回占位快照且不缓存，下次读取再试。
 */
function readColdSync(db) {
  let revision
  try {
    revision = Number(latestConfigRevisionSync(db) || 0)
  } catch {
    warn('reading the settings revision failed; keeping the last good settings')
    return unreadable()
  }
  let stored
  try {
    stored = parseRow(loadSettingsRowSync(db, 'codex'))
  } catch (error) {
    warn(`reading codex settings failed: ${error?.message || error}; keeping the last good settings`)
    return unreadable()
  }
  return remember(db, stored, revision)
}

/**
 * 读取 Codex 本地设置快照 { values, revision, stored }（values 已规范化）。数据库没有记录时为默认值与版本 0。
 * 同一请求应只取一次快照，信封、回执与请求尝试都用这份快照的版本。同步返回：过期时先返回现有快照并在后台刷新。
 */
export function readCodexSettings(db) {
  const cached = cache.get(db)
  if (!cached) return readColdSync(db)
  if (Date.now() - cached.checkedAt >= CACHE_CHECK_MS) void refreshOnce(db)
  return cached
}

/** 服务启动（migrateRoutingFile 之后）预热快照：之后的读取不再同步查库。返回读取后的快照。 */
export async function warmCodexSettings(db) {
  return refreshOnce(db)
}

// 写入前取当前值：快照 1 秒内直接用，否则等一次刷新（与改造前“超过 1 秒先复查版本”一致）
async function currentCodexSettings(db) {
  const cached = cache.get(db)
  if (cached && Date.now() - cached.checkedAt < CACHE_CHECK_MS) return cached
  return refreshOnce(db)
}

let detached = null

/**
 * 数据库未打开时使用的设置（单测与不接数据库的工具进程）：传 null 恢复为默认值。数据库打开后不生效。
 */
export function setDetachedCodexSettings(values = null) {
  detached = values ? normalizeCodexSettings(values) : null
}

/** 请求路径与后台任务读取 Codex 本地设置快照；数据库未打开（部分单测、启动早期）时为默认值与版本 0。 */
export function codexSettingsSnapshot(db = null) {
  let handle = db
  if (!handle) {
    try {
      handle = getDb()
    } catch {
      return { values: detached || DEFAULT_CODEX_SETTINGS, revision: 0, stored: false }
    }
  }
  return readCodexSettings(handle)
}

/** 只要值时的简写。 */
export function codexSettings(db = null) {
  return codexSettingsSnapshot(db).values
}

async function write(db, scope, values, actor, changedKeys, before) {
  const valuesJson = JSON.stringify(values)
  bumpGeneration(db)
  try {
    const revision = await dbClient(db).tx(async () => {
      const at = stamp()
      const revision =
        Number(
          await insertConfigRevision(db, {
            scope,
            keysJson: JSON.stringify(changedKeys),
            actor: String(actor || 'system'),
            createdAt: at,
          }),
        ) || (await latestRevision(db))
      await upsertSettings(db, {
        scope,
        valuesJson,
        revision,
        updatedAt: at,
        updatedBy: String(actor || 'system'),
      })
      const pick = (source) => Object.fromEntries(changedKeys.map((key) => [key, source?.[key] ?? null]))
      insertOperationAudit(
        db,
        String(actor || 'system'),
        'executor.settings.updated',
        `executor_settings:${scope}`,
        before ? JSON.stringify(pick(before)) : null,
        JSON.stringify({ revision, keys: changedKeys, values: pick(values) }),
        '',
        at,
      )
      return revision
    })
    // 写入后立即生效：快照直接换成刚写入的值（与重新读库得到的结果相同）
    remember(db, { values: JSON.parse(valuesJson), revision }, revision)
    return revision
  } finally {
    bumpGeneration(db)
  }
}

// 合并语义：补丁里的对象按键与当前值合并一层（scheduling.smart_weights 再合并一层），数组与标量整体替换（R4 审查 P2-2）
function mergePatch(current, patch) {
  const merged = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    const base = current[key]
    if (value && typeof value === 'object' && !Array.isArray(value) && base && typeof base === 'object') {
      merged[key] = { ...base, ...value }
      if (key === 'scheduling' && value.smart_weights)
        merged.scheduling.smart_weights = { ...base.smart_weights, ...value.smart_weights }
    } else merged[key] = value
  }
  return merged
}

/**
 * 保存 Codex 本地设置的补丁：按设置描述校验（非法值整体拒绝，error.code=invalid_executor_settings），
 * 与当前值合并、按联动规则收敛被条件隐藏的字段后再校验与规范化；没有变化时不推进版本。
 * expectedRevision 给定且与当前版本不同时拒绝（settings_revision_conflict，乐观锁，R4 审查 P2-3）。
 * 返回 { values, revision, changed }。
 */
export async function saveCodexSettings(db, patch = {}, actor = 'system', { expectedRevision = null } = {}) {
  validateCodexSettingsPatch(patch)
  const current = await currentCodexSettings(db)
  if (current.unreadable)
    throw Object.assign(new Error('codex settings are unreadable; retry later'), {
      code: 'settings_unavailable',
      status: 503,
    })
  if (expectedRevision !== null && expectedRevision !== undefined && Number(expectedRevision) !== current.revision)
    throw Object.assign(new Error(`settings changed (revision ${current.revision}); reload and retry`), {
      code: 'settings_revision_conflict',
      status: 409,
      revision: current.revision,
    })
  const merged = linkCodexSettings(mergePatch(current.values, patch), current.values)
  validateCodexSettingsPatch(patch, merged)
  try {
    normalizeCodexScheduling(merged.scheduling, { strict: true })
  } catch (error) {
    throw new SchemaValidationError([{ field: 'scheduling.smart_weights', reason: error.message }])
  }
  const next = normalizeCodexSettings(merged)
  const changed = CODEX_LOCAL_SETTING_KEYS.filter(
    (key) => JSON.stringify(next[key]) !== JSON.stringify(current.values[key]),
  )
  if (!changed.length && current.stored) return { values: current.values, revision: current.revision, changed }
  const revision = await write(
    db,
    'codex',
    next,
    actor,
    changed.length ? changed : CODEX_LOCAL_SETTING_KEYS,
    current.stored ? current.values : null,
  )
  return { values: next, revision, changed }
}

/**
 * 把 routing 文档里的本地键导入数据库（数据库还没有 codex 设置时），返回去掉本地键的文档。
 * 数据库已有记录而文档仍带本地键时，这些键被忽略并告警（例如从旧备份恢复了 routing.json）。
 */
export async function importCodexSettingsFromRouting(db, routing = {}) {
  const codex = routing?.codex && typeof routing.codex === 'object' ? routing.codex : null
  const local = pickCodexLocalSettings(codex || {})
  const hasLocal = Object.keys(local).length > 0
  if (!(await load(db, 'codex')))
    await write(db, 'codex', normalizeCodexSettings(local), 'migration:routing.json', CODEX_LOCAL_SETTING_KEYS, null)
  else if (hasLocal)
    warn(
      `routing.json carries ${Object.keys(local).join(', ')} but the database already has codex settings; the file values are ignored`,
    )
  if (!hasLocal) return { routing, changed: false }
  const strippedCodex = { ...codex }
  for (const key of CODEX_LOCAL_SETTING_KEYS) delete strippedCodex[key]
  return { routing: { ...routing, codex: strippedCodex }, changed: true }
}

/**
 * 控制面启动与从备份恢复时、加载 routing.json 之前调用（R4 审查 P0-1）：先备份原文件为 routing.json.bak-<时间>，
 * 再导入本地键并写回去掉本地键的文件。导入失败只告警；随后上游加载 routing.json 时可能把本地键去掉写回，
 * 所以备份先于导入，失败时从备份恢复（R4 复核新问题 4）。
 */
export async function migrateRoutingFile(db, file = routingConfigFile()) {
  let backup = null
  try {
    let doc
    try {
      doc = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') return { changed: false }
      throw error
    }
    if (!Object.keys(pickCodexLocalSettings(doc?.codex || {})).length) return { changed: false }
    backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
    fs.copyFileSync(file, backup)
    const { routing, changed } = await importCodexSettingsFromRouting(db, doc)
    if (!changed) return { changed: false, backup }
    atomicWriteJson(file, routing, { mode: 0o600 })
    return { changed: true, backup }
  } catch (error) {
    warn(
      `importing local codex settings from ${file} failed: ${error?.message || error}${backup ? `; the original file is kept at ${backup}` : ''}`,
    )
    return { changed: false, error: error?.message || String(error), ...(backup ? { backup } : {}) }
  }
}
