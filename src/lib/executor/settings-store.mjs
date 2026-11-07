/**
 * 执行服务设置存储（统一控制面重构 P4.2–P4.3，设计第 10 节）。
 *
 * 本地设置（上游 routing.json 之外的键，定义见 codex-settings.mjs）保存在控制面数据库 executor_settings，
 * 每次修改推进设置版本（config_revisions 记录每一版改了哪些键、由谁改），并写审计。对外字段名为 settings_revision，
 * 与上游 routing.json 的运行配置版本（usage_logs.config_revision）区分（R4 审查 P1-2）。
 *
 * 导入：控制面启动（以及从备份恢复）时，在加载 routing.json 之前调用 migrateRoutingFile：数据库还没有 codex 设置时
 * 把文件里的本地键写入数据库；已有设置时按合并基线、最近备份与默认值保守合并（回滚到旧版本期间改的设置再次升级时导入，
 * 最终审计 U1，见 mergeRollbackSettings）；然后备份原文件并删除这些键（R4 审查 P0-1、P1-4）。
 *
 * 读取（R6 B3）：请求路径同步调用 readCodexSettings / codexSettingsSnapshot / codexSettings，签名保持同步，返回进程内快照：
 *   - 快照 1 秒内直接返回；超过 1 秒仍立即返回现有快照，同时在后台发起一次异步刷新（同一数据库同一时刻只有一次），
 *     经 DbClient 读设置版本与设置行，刷新完成后后续读取即得到新值（多进程部署下最多约 1 秒加一次读取看到旧值）；
 *   - 服务启动时在 migrateRoutingFile 之后 await warmCodexSettings 预热（工具进程与测试同样先预热）；尚未预热就读取时
 *     （R6 B8 删除了同步冷读）返回“不可读”占位快照（默认值、版本 0、保存被拒绝，与从未读到有效值时相同），告警一次并在后台预热，
 *     预热完成后的读取得到真实值；
 *   - 写入后立即把新值放进快照，下次读取直接得到新值；写入期间开始的后台刷新结果作废；
 *   - 读取出错时保留上一份有效值并告警，不把默认值当成有效设置缓存（R4 审查 P1-3）。
 * 写入（R6 B3，竞态 R17）：新增设置版本（INSERT … RETURNING revision）与写设置行、审计在同一个 db.tx 里。
 */
import fs from 'node:fs'
import path from 'node:path'
import { getDb } from '../db/database.mjs'
import { dbClient } from '../db/db-client.mjs'
import { routingConfigFile } from '../core/config.mjs'
import { atomicWriteJson } from '../vm/vm-file.mjs'
import { insertOperationAudit } from '../admin/repos/relay-repo.mjs'
import { insertConfigRevision, latestConfigRevision, loadSettingsRow, upsertSettings } from './repos/settings-repo.mjs'
import {
  CODEX_LOCAL_SETTING_KEYS,
  DEFAULT_CODEX_SETTINGS,
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

const coldWarned = new WeakSet()

// 尚未预热就读取：不再同步查库（R6 B8），按“从未读到过有效值”处理并在后台预热。占位快照不缓存，预热完成后读到真实值。
function readCold(db) {
  if (!coldWarned.has(db)) {
    coldWarned.add(db)
    warn('settings read before warmCodexSettings; using defaults until the background warm-up finishes')
  }
  void refreshOnce(db)
  return unreadable()
}

/**
 * 读取 Codex 本地设置快照 { values, revision, stored }（values 已规范化）。数据库没有记录时为默认值与版本 0。
 * 同一请求应只取一次快照，信封、回执与请求尝试都用这份快照的版本。同步返回：过期时先返回现有快照并在后台刷新。
 */
export function readCodexSettings(db) {
  const cached = cache.get(db)
  if (!cached) return readCold(db)
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
      await insertOperationAudit(
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
  const merged = mergePatch(current.values, patch)
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

// 与键顺序无关的比较（同一份设置被不同版本写回时键顺序可能不同）
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`
  return JSON.stringify(value ?? null)
}

// 上一次从 routing.json 导入或合并之后数据库里的设置（合并基线，复核 J1、J2）。与设置同库保存，
// 从面板备份恢复数据库时随之恢复，基线与数据库始终是同一时刻的
const BASELINE_SCOPE = 'codex:routing-baseline'

async function loadMergeBaseline(db) {
  const row = await loadSettingsRow(db, BASELINE_SCOPE)
  if (!row) return null
  try {
    return normalizeCodexSettings(JSON.parse(row.values_json))
  } catch {
    return null
  }
}

// 设置读不出时（占位快照是默认值）不能拿来比较或写基线，按导入出错处理（复核 K5）
async function readableSettings(db) {
  const current = await currentCodexSettings(db)
  if (current.unreadable)
    throw Object.assign(new Error('codex settings are unreadable'), { code: 'settings_unavailable' })
  return current.values
}

async function saveMergeBaseline(db) {
  const values = await readableSettings(db)
  await upsertSettings(db, {
    scope: BASELINE_SCOPE,
    valuesJson: JSON.stringify(values),
    revision: Number(await latestRevision(db)) || 0,
    updatedAt: stamp(),
    updatedBy: 'migration:routing.json',
  })
}

/**
 * 数据库已有设置、文件又带本地键（回滚到旧版本期间旧版本写回了 routing.json，或手工放回了旧文件）时的保守合并
 * （最终审计 U1，复核 J1、J2、J3、J6）。按新版本的规范化逐键比较（键顺序、缺省子字段不算改动）。
 * 参照值：合并基线（上一次导入或合并后的数据库设置；还没有时用最近的时间戳备份）、所有时间戳备份、默认值（复核 L1）。
 * 旧版本的起点只可能是恢复的某一份备份或补了默认值的文件，所以文件值等于任一参照（或等于数据库当前值）都视为回滚期间没改（保留数据库的值）；
 * 运维在旧版本里改回这些值的情况无法区分，保守不导入并告警。与所有参照都不同的键是回滚期间改的：
 * 数据库仍等于合并基线时导入，数据库在新版本里也改过时视为冲突，保留数据库的值并告警。
 * 导入走正常保存（校验、推进设置版本、写审计，操作人 migration:routing.json-rollback）：先逐键校验筛出合法的键，
 * 再一次保存；校验不过的键跳过并告警。数据库错误等非校验错误向上抛出（调用方不清理文件）。
 * 合并基线和时间戳备份都没有时无法判断先后，维持忽略并告警。返回导入的键。
 */
async function mergeRollbackSettings(db, local, { stored = null, backups = [], start = null } = {}) {
  const keys = Object.keys(local)
  const norm = (source, key) => normalizeCodexSettings(source && key in source ? { [key]: source[key] } : {})[key]
  const baseline = stored || (backups.length ? normalizeCodexSettings(backups[0]) : null)
  if (!baseline) {
    warn(
      `routing.json carries ${keys.join(', ')} but the database already has codex settings and there is no merge baseline or routing.json.bak-<time>; the file values are ignored`,
    )
    return []
  }
  const same = (a, b) => stableJson(a) === stableJson(b)
  const current = await readableSettings(db)
  const candidates = {}
  const notes = { unchanged: [], conflict: [], invalid: [] }
  for (const key of keys) {
    const file = norm(local, key)
    // 知道旧版本从哪一份备份开始时（备份标记，审计 N1）只与那一份比较：与它不同即回滚期间改过，
    // 改回默认值或改回其他备份里的值也能识别。不知道时，任何一份有效备份都可能是起点（复核 L1），连同合并基线、默认值都按“未改”参照
    const references = start
      ? [norm(start, key)]
      : [baseline[key], DEFAULT_CODEX_SETTINGS[key], ...backups.map((backup) => norm(backup, key))]
    if (same(file, current[key]) || references.some((value) => same(file, value))) notes.unchanged.push(key)
    else if (!same(current[key], baseline[key]))
      notes.conflict.push(`${key} (database ${stableJson(current[key])}, file ${stableJson(file)})`)
    else {
      try {
        validateCodexSettingsPatch({ [key]: local[key] })
        candidates[key] = local[key]
      } catch (error) {
        if (!(error instanceof SchemaValidationError)) throw error
        notes.invalid.push(`${key} (${error.message})`)
      }
    }
  }
  let imported = Object.keys(candidates)
  if (imported.length) {
    const actor = 'migration:routing.json-rollback'
    try {
      await saveCodexSettings(db, candidates, actor)
    } catch (error) {
      if (!(error instanceof SchemaValidationError)) throw error
      // 合起来的跨字段校验不过：逐键重试（每个键各一版设置），只跳过确实不能单独保存的键（复核 K4）
      imported = []
      for (const [key, value] of Object.entries(candidates)) {
        try {
          await saveCodexSettings(db, { [key]: value }, actor)
          imported.push(key)
        } catch (keyError) {
          if (!(keyError instanceof SchemaValidationError)) throw keyError
          notes.invalid.push(`${key} (${keyError.message})`)
        }
      }
    }
  }
  if (imported.length)
    warn(`routing.json ${imported.join(', ')} changed while an older version ran; imported into the database`)
  if (notes.conflict.length)
    warn(`routing.json and the database both changed ${notes.conflict.join('; ')}; the database values are kept`)
  if (notes.invalid.length)
    warn(`routing.json values were not imported because they are invalid: ${notes.invalid.join('; ')}`)
  if (notes.unchanged.length && !start)
    warn(
      `routing.json ${notes.unchanged.join(', ')} match the last import, the last backup or the defaults (an older version may have refilled them); the database values are kept`,
    )
  return imported
}

/**
 * 把 routing 文档里的本地键导入数据库，返回去掉本地键的文档。数据库还没有 codex 设置时整体导入；
 * 已有记录而文档仍带本地键时保守合并（见 mergeRollbackSettings；merge 为 false 时以数据库为准）。
 */
export async function importCodexSettingsFromRouting(
  db,
  routing = {},
  { backups = [], merge = true, start = null } = {},
) {
  const codex = routing?.codex && typeof routing.codex === 'object' ? routing.codex : null
  const local = pickCodexLocalSettings(codex || {})
  const hasLocal = Object.keys(local).length > 0
  let imported = []
  // 导入：数据库还没有设置时整体写入；已有时按基线保守合并
  if (!(await load(db, 'codex')))
    await write(db, 'codex', normalizeCodexSettings(local), 'migration:routing.json', CODEX_LOCAL_SETTING_KEYS, null)
  else if (hasLocal && merge)
    imported = await mergeRollbackSettings(db, local, { stored: await loadMergeBaseline(db), backups, start })
  else if (hasLocal)
    warn(`routing.json carries ${Object.keys(local).join(', ')} after a restore; the restored database values are kept`)
  if (!hasLocal) return { routing, changed: false, imported }
  // 记下这次之后数据库里的设置，作为下一次回滚合并的基线
  await saveMergeBaseline(db)
  const strippedCodex = { ...codex }
  for (const key of CODEX_LOCAL_SETTING_KEYS) delete strippedCodex[key]
  return { routing: { ...routing, codex: strippedCodex }, changed: true, imported }
}

// 备份内容里的顶层标记：值为这份备份自己的时间戳。运维把备份复制回 routing.json 后，旧版本改写文件时保留不认识的顶层字段，
// 再次升级时据此知道旧版本从哪一份备份开始（审计 N1）；写回 routing.json 时去掉
const BACKUP_MARKER = '_tapmodels_backup'
// 备份内容里另存这次导入的起点标记：导入出错后从 .failed 重试时据此恢复起点（复核 T1）
const BACKUP_START = '_tapmodels_backup_start'
// 备份内容里的来源：面板恢复写出的备份记为 restore。恢复中途进程被杀留下的 .pending 在下一次启动重试时按恢复语义处理、
// 不合并（审计 N4）。只从未完成的备份里读，routing.json 里出现时（运维把备份复制回去）与标记一起去掉
const BACKUP_SOURCE = '_tapmodels_backup_source'
const withoutBackupKeys = (doc) => {
  const { [BACKUP_MARKER]: _marker, [BACKUP_START]: _start, [BACKUP_SOURCE]: _source, ...rest } = doc || {}
  return rest
}
const hasBackupKeys = (doc) =>
  doc?.[BACKUP_MARKER] !== undefined || doc?.[BACKUP_START] !== undefined || doc?.[BACKUP_SOURCE] !== undefined
// 两份本地键按新版本规范化后是否相同（与键顺序、缺省子字段无关）
const sameLocalSettings = (a, b) => stableJson(normalizeCodexSettings(a)) === stableJson(normalizeCodexSettings(b))
const backupId = (file, backupPath) => path.basename(backupPath).slice(`${path.basename(file)}.bak-`.length)

/** 标记指向的有效备份里的本地键；标记无效、备份不存在或读不出时返回 null（回到保守规则）。 */
function backupByMarker(file, marker) {
  if (typeof marker !== 'string' || !BACKUP_SUFFIX.test(`.bak-${marker}`)) return null
  try {
    const local = pickCodexLocalSettings(JSON.parse(fs.readFileSync(`${file}.bak-${marker}`, 'utf8'))?.codex || {})
    return Object.keys(local).length ? local : null
  } catch {
    return null
  }
}

// migrateRoutingFile 生成的备份名：routing.json.bak-<ISO 时间，冒号与小数点换成连字符>；手工命名或导入失败的备份不算基线（复核 J4、J3）
const backupName = (file) => `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
const BACKUP_SUFFIX = /^\.bak-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/

/**
 * 比最近的有效时间戳备份更新、尚未重试的未完成导入（routing.json.bak-<时间>.failed 或 .pending）：
 * 其中的本地键、起点标记与是否来自面板恢复。
 */
function unfinishedImport(file) {
  const dir = path.dirname(file)
  const base = path.basename(file)
  let names
  try {
    names = fs.readdirSync(dir).filter((name) => name.startsWith(base))
  } catch {
    return null
  }
  const stampOf = (name, suffix = '') => {
    const rest = name.slice(base.length)
    if (!rest.endsWith(suffix)) return null
    const core = rest.slice(0, rest.length - suffix.length)
    return BACKUP_SUFFIX.test(core) ? core : null
  }
  const latestValid =
    names
      .map((name) => stampOf(name))
      .filter(Boolean)
      .sort()
      .at(-1) || ''
  // .failed：导入出错；.pending：导入提交前进程被杀（复核 N2）
  const unfinished = (name) => stampOf(name, '.failed') || stampOf(name, '.pending')
  const failed = names
    .filter(unfinished)
    .sort()
    .reverse()
    .find((name) => unfinished(name) > latestValid)
  if (!failed) return null
  try {
    const content = JSON.parse(fs.readFileSync(path.join(dir, failed), 'utf8'))
    const local = pickCodexLocalSettings(content?.codex || {})
    // 起点标记存在备份内容里（routing.json 里的标记写出备份后就去掉了，复核 T1）
    return Object.keys(local).length
      ? {
          path: path.join(dir, failed),
          local,
          start: content?.[BACKUP_START],
          restore: content?.[BACKUP_SOURCE] === 'restore',
        }
      : null
  } catch {
    return null
  }
}

/** 最近一次带本地键启动时的备份（按时间戳取最新）里的本地键；没有或读不出时返回 null。 */
function validBackups(file) {
  const dir = path.dirname(file)
  const base = path.basename(file)
  let names
  try {
    names = fs
      .readdirSync(dir)
      .filter((name) => name.startsWith(base) && BACKUP_SUFFIX.test(name.slice(base.length)))
      .sort()
      .reverse()
  } catch {
    return []
  }
  const backups = []
  for (const name of names) {
    try {
      const local = pickCodexLocalSettings(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))?.codex || {})
      if (Object.keys(local).length) backups.push(local)
    } catch {}
  }
  return backups
}

// 写出新的有效备份后，比它旧、还没重试的导入失败备份已被这次导入取代，改名为 .superseded（复核 L3）
function supersedeFailed(file, backup) {
  const dir = path.dirname(file)
  const base = path.basename(file)
  const current = path.basename(backup).slice(base.length)
  try {
    for (const name of fs.readdirSync(dir)) {
      const rest = name.slice(base.length)
      const suffix = ['.failed', '.pending'].find((item) => rest.endsWith(item))
      if (!name.startsWith(base) || !suffix) continue
      const stamp = rest.slice(0, -suffix.length)
      if (BACKUP_SUFFIX.test(stamp) && stamp < current)
        fs.renameSync(path.join(dir, name), path.join(dir, `${name.slice(0, -suffix.length)}.superseded`))
    }
  } catch {}
}

/**
 * 控制面启动与从备份恢复时、加载 routing.json 之前调用（R4 审查 P0-1）：先备份原文件为 routing.json.bak-<时间>，
 * 再导入本地键并写回去掉本地键的文件。导入失败只告警；随后上游加载 routing.json 时可能把本地键去掉写回，
 * 所以备份先于导入，失败时从备份恢复（R4 复核新问题 4）。
 */
export async function migrateRoutingFile(db, file = routingConfigFile(), { mergeRollback = true } = {}) {
  let backup = null
  try {
    let doc
    try {
      doc = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') return { changed: false }
      throw error
    }
    let retried = null
    let borrowed = null
    const fileMarker = doc?.[BACKUP_MARKER]
    const fileLocal = pickCodexLocalSettings(doc?.codex || {})
    // 文件里的标记只用于这一次判断，读出后马上去掉：之后任何路径（导入出错、上游改写、面板恢复）都不能让它残留，
    // 否则一次“不复制备份”的回滚会让旧版本补的默认值被当成相对那份备份的修改导入（复核 T1）
    const stripMarker = () => {
      if (!hasBackupKeys(doc)) return
      atomicWriteJson(file, withoutBackupKeys(doc), { mode: 0o600 })
    }
    if (!Object.keys(fileLocal).length) {
      // 上一次导入出错后，同一次启动里上游加载 routing.json 时已把本地键删掉写回：本地键只剩在 .failed 备份里。
      // 比最近有效备份更新的 .failed 视为未完成的导入，把其中的本地键并回当前文件后重试（复核 K1）
      // 从面板备份恢复时以恢复的数据库为准，不重试启动时留下的失败导入（复核 L2）
      retried = mergeRollback ? unfinishedImport(file) : null
      stripMarker()
      if (!retried) return { changed: false }
      doc = { ...doc, codex: { ...(doc?.codex || {}), ...retried.local } }
    } else if (mergeRollback && fileMarker === undefined) {
      // 上一次导入去掉文件里的标记之后、提交之前进程被杀（或导入出错而上游没有改写文件）：文件仍带本地键却已无标记。
      // 比最近有效备份更新的 .pending / .failed 与文件的本地键一致时，借用其中存的起点（审计 N1b）；
      // 不一致（之后旧版本又改过文件、或手工改过）时不借，按保守规则
      const unfinished = unfinishedImport(file)
      if (
        unfinished &&
        (typeof unfinished.start === 'string' || unfinished.restore) &&
        sameLocalSettings(unfinished.local, fileLocal)
      )
        borrowed = unfinished
    }
    const resumed = retried || borrowed
    // 面板恢复留下的未完成导入按恢复语义重试：以数据库为准、不合并（审计 N4）
    const restoring = !mergeRollback || resumed?.restore === true
    // 参照备份取本次备份之前最新的时间戳备份；从面板备份恢复时数据库与磁盘上的备份不是同一时刻，不合并（复核 J5）
    const backups = restoring ? [] : validBackups(file)
    // 旧版本的起点：运维把某份备份复制回 routing.json 后，旧版本改写文件时保留顶层的备份标记（审计 N1）
    const startMarker = resumed ? resumed.start : fileMarker
    const start = restoring ? null : backupByMarker(file, startMarker)
    // 备份先以 .pending 写出，导入成功后才改成有效的时间戳名：进程在导入提交前被杀时，下一次启动不会把这份
    // 与文件相同的备份当作参照、把回滚期间的修改判为“没改”（复核 N2）。备份内容带上自己的标记、起点与来源
    const finalBackup = backupName(file)
    backup = `${finalBackup}.pending`
    const plain = withoutBackupKeys(doc)
    fs.writeFileSync(
      backup,
      `${JSON.stringify(
        {
          ...plain,
          [BACKUP_MARKER]: backupId(file, finalBackup),
          ...(typeof startMarker === 'string' ? { [BACKUP_START]: startMarker } : {}),
          ...(restoring ? { [BACKUP_SOURCE]: 'restore' } : {}),
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    )
    if (!retried) stripMarker()
    const { routing, changed, imported } = await importCodexSettingsFromRouting(db, plain, {
      backups,
      merge: !restoring,
      start,
    })
    fs.renameSync(backup, finalBackup)
    backup = finalBackup
    if (retried)
      try {
        fs.renameSync(retried.path, `${retried.path}.retried`)
      } catch {}
    supersedeFailed(file, backup)
    if (!changed) return { changed: false, backup }
    atomicWriteJson(file, routing, { mode: 0o600 })
    return {
      changed: true,
      backup,
      imported,
      ...(retried ? { retried: retried.path } : {}),
      ...(borrowed ? { borrowedStart: borrowed.path } : {}),
      ...(resumed?.restore ? { restoreRetry: true } : {}),
    }
  } catch (error) {
    // 去标记那次写入本身失败时再试一次（尽力而为，复核 U1）：标记残留会让之后一次不复制备份的回滚把默认值当成修改导入
    try {
      const current = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (hasBackupKeys(current)) atomicWriteJson(file, withoutBackupKeys(current), { mode: 0o600 })
    } catch {}
    // 导入失败：文件不清理；本次备份改名，不会被下一次启动当成基线（否则回滚期间的修改会被判为未改动，复核 J3）
    // 面板恢复路径出错时用另一个后缀：它不参与启动时的重试（复核 L2）
    const failedSuffix = mergeRollback ? '.failed' : '.restore-failed'
    if (backup)
      try {
        const failedPath = `${backup.replace(/\.pending$/, '')}${failedSuffix}`
        fs.renameSync(backup, failedPath)
        backup = failedPath
      } catch {}
    warn(
      `importing local codex settings from ${file} failed: ${error?.message || error}${backup ? `; the original file is kept at ${backup}` : ''}`,
    )
    return { changed: false, error: error?.message || String(error), ...(backup ? { backup } : {}) }
  }
}
