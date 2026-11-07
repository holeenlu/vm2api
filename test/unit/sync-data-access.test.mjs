// 数据访问分层 R6 B8 守卫：主线程代码不再同步访问数据库。
// 扫描 src 下全部 .mjs（含仓储），以下同步访问只允许出现在豁免清单列出的文件里，且每个文件的处数与清单完全一致
// （新增直接失败；减少后要同步改小清单，清单只减不增）：
//   - DatabaseSync 上的 `.prepare(…)`（后跟 SQL 字符串、模板字符串或变量）与数据库对象上的 `.exec(…)`；
//   - `withTransaction(`（同步事务）；
//   - DbClient 已删除的同步方法 `oneSync` / `manySync` / `runSync`；
//   - `new DatabaseSync(`（另开连接）。
// 运行期代码经 DbClient（src/lib/db/db-client.mjs）异步访问；临时同步出口（R6_PROGRESS“临时同步出口”表）已全部删除，下面逐个断言不再导出。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { countSqlSites } from '../../scripts/sql-boundary.mjs'
import * as database from '../../src/lib/db/database.mjs'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { createDbClient } from '../../src/lib/db/db-client.mjs'
import * as writeBehind from '../../src/lib/db/write-behind.mjs'
import { SettingsRepo } from '../../src/lib/db/repos/settings-repo.mjs'
import { ProxiesRepo } from '../../src/lib/db/repos/proxies-repo.mjs'
import { VmsRepo } from '../../src/lib/db/repos/vms-repo.mjs'
import { ClusterNodesRepo } from '../../src/lib/db/repos/cluster-nodes-repo.mjs'
import { UsageLogsRepo } from '../../src/lib/db/repos/usage-logs-repo.mjs'
import * as vendorUsage from '../../src/lib/vendor/vendor-usage.mjs'
import * as vendorUsageRepo from '../../src/lib/vendor/repos/usage-repo.mjs'
import * as executorSettingsRepo from '../../src/lib/executor/repos/settings-repo.mjs'
import * as vaultRepo from '../../src/lib/executor/repos/vault-repo.mjs'
import * as vault from '../../src/lib/executor/vault.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/**
 * 豁免清单：文件 → { sql, tx, sync, open, reason }（各类同步访问的处数，缺省为 0）。
 * 只收主线程以外的代码（Worker 线程、运维脚本进程）、打开连接与迁移的步骤，以及异步接口自身的实现。
 */
export const SYNC_ACCESS_EXEMPTIONS = {
  'src/lib/db/database.mjs': {
    sql: 31,
    tx: 2,
    open: 2,
    reason:
      '打开连接：PRAGMA、版本化迁移与校验和（含历史 001 代理表重建的同步事务：withTransaction 的定义与唯一调用，已不导出）、预编译语句缓存、只读连接检查（写探测并回滚，M3）、迁移前快照（有待执行迁移时 VACUUM INTO 并只读打开快照做 quick_check，审计 P1-S7）与待执行迁移判定（运维脚本共用）；其余 VACUUM INTO 快照只在备份 Worker 线程调用',
  },
  'src/lib/db/db-client.mjs': {
    sql: 15,
    reason:
      'DbClient 自身：async 接口的底层实现（预编译、BEGIN IMMEDIATE / SAVEPOINT / COMMIT / ROLLBACK），写入健康的写探测（专用单行表 upsert 并提交，M3 复审 P1-2 多一处 COMMIT）与 busy_timeout 调整（M3），调用方只能经它访问',
  },
  'src/lib/db/sqlite-worker.mjs': {
    sql: 4,
    open: 1,
    reason: '读池 Worker 线程（不在主线程）：自己的只读连接与 PRAGMA；查询经 UsageLogsRepo / UsageLogsView（DbClient）',
  },
  'src/lib/admin/usage-stats-thread.mjs': {
    sql: 5,
    open: 1,
    reason:
      '统计 Worker 线程（不在主线程）：自己的连接、PRAGMA、data_version 与延迟 BEGIN 读事务边界；业务查询经 DbClient',
  },
  'src/lib/admin/billing-reconcile-thread.mjs': {
    sql: 4,
    open: 1,
    reason:
      '每日计费对账 Worker 线程（不在主线程，审计阶段 2 W9）：自己的只读连接、PRAGMA 与延迟 BEGIN 读事务边界；检查 SQL 经 DbClient（repos/billing-reconcile-repo.mjs）',
  },
  'src/lib/admin/usage-stats-worker.mjs': {
    sql: 3,
    reason:
      '主线程上的统计线程调度：PRAGMA database_list（构造时取库文件路径）与 PRAGMA data_version / total_changes() 连接元数据，不读表；同步判定统计快照能否合并，改 async 会让判定与派发之间插入写入',
  },
  'src/lib/db/repos/settings-repo.mjs': {
    sql: 2,
    reason:
      'settings 快照（R6 B1）在连接打开时（createDatabase 迁移之后）同步载入一次整表与 data_version（primeSettingsSnapshot），与迁移同属打开连接的步骤；运行期重载与事务结算经 DbClient',
  },
  'src/lib/executor/repos/script-db-repo.mjs': {
    sql: 2,
    open: 1,
    reason: '运维脚本进程（凭据迁移、主密钥轮换，不在服务主线程）打开数据库；未应用迁移的判定在 database.mjs',
  },
}

const TX = /\bwithTransaction\s*\(/g
const SYNC = /\b(?:oneSync|manySync|runSync)\b/g
const OPEN = /\bnew\s+DatabaseSync\s*\(/g

function sources(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) sources(full, out)
    else if (entry.name.endsWith('.mjs')) out.push(full)
  }
  return out
}

// 去掉注释（行注释与块注释），避免说明文字里的名字被计数；字符串与模板字符串原样保留
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
}

export function syncAccessCounts(text) {
  const code = stripComments(text)
  const count = (re) => [...code.matchAll(re)].length
  return { sql: countSqlSites(code), tx: count(TX), sync: count(SYNC), open: count(OPEN) }
}

test('main-thread code has no synchronous data access outside the exemption list', () => {
  const problems = []
  const seen = new Set()
  for (const file of sources(path.join(ROOT, 'src'))) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/')
    const have = syncAccessCounts(fs.readFileSync(file, 'utf8'))
    const allowed = SYNC_ACCESS_EXEMPTIONS[rel] || {}
    if (SYNC_ACCESS_EXEMPTIONS[rel]) seen.add(rel)
    for (const kind of ['sql', 'tx', 'sync', 'open']) {
      const want = allowed[kind] || 0
      if (have[kind] > want)
        problems.push(
          `${rel}: ${have[kind]} synchronous ${kind} site(s), allowed ${want} — use DbClient (db.one/many/run/tx)`,
        )
      else if (have[kind] < want)
        problems.push(`${rel}: ${kind} dropped to ${have[kind]}; lower the exemption to ${have[kind]} (delete it at 0)`)
    }
  }
  for (const rel of Object.keys(SYNC_ACCESS_EXEMPTIONS))
    if (!seen.has(rel)) problems.push(`${rel}: exempted file no longer exists; delete the entry`)
  assert.deepEqual(problems, [], problems.join('\n'))
})

test('every exemption names a reason and a positive count', () => {
  for (const [file, entry] of Object.entries(SYNC_ACCESS_EXEMPTIONS)) {
    assert.ok(entry.reason, `${file}: an exemption needs a reason`)
    assert.ok(
      ['sql', 'tx', 'sync', 'open'].some((kind) => entry[kind] > 0),
      `${file}: an exemption without sites should be deleted`,
    )
  }
})

test('the scan counts prepares, execs, sync transactions, sync helpers and new connections, not comments', () => {
  const text = [
    "db.prepare('SELECT 1').get()",
    "getDb().exec('BEGIN')",
    'withTransaction(db, () => {})',
    'client.oneSync(sql)',
    'new DatabaseSync(file)',
    '// db.prepare("SELECT 2") withTransaction( oneSync new DatabaseSync(',
    '/* client.runSync(sql) */',
    'regex.exec(text)',
  ].join('\n')
  assert.deepEqual(syncAccessCounts(text), { sql: 2, tx: 1, sync: 1, open: 1 })
})

test('removed synchronous exits are no longer exported', async (t) => {
  const db = createDatabase({ dbPath: ':memory:' })
  t.after(() => db.close())
  // DbClient 同步方法与主线程同步事务
  const client = createDbClient(db)
  for (const name of ['oneSync', 'manySync', 'runSync']) assert.equal(client[name], undefined, name)
  assert.equal(database.withTransaction, undefined)
  // 临时同步出口（R6_PROGRESS 出口表，B8 全部删除）
  assert.equal(executorSettingsRepo.latestConfigRevisionSync, undefined)
  assert.equal(executorSettingsRepo.loadSettingsRowSync, undefined)
  assert.equal(vendorUsage.recordVendorUsageSync, undefined)
  for (const name of ['gatewayAccountResourceSync', 'vmAccountResourceSync', 'insertUsageFactSync'])
    assert.equal(vendorUsageRepo[name], undefined, name)
  assert.equal(ProxiesRepo.prototype.replaceAllSync, undefined)
  assert.equal(ClusterNodesRepo.prototype.platformSync, undefined)
  assert.equal(VmsRepo.prototype.upsertFromVmJsonSync, undefined)
  assert.equal(VmsRepo.prototype.getSync, undefined)
  assert.equal(SettingsRepo.prototype.setSync, undefined)
  assert.equal(SettingsRepo.prototype.removeSync, undefined)
  // 改为 async 的同步入口
  assert.ok(vaultRepo.hasCredentialRecords(db) instanceof Promise)
  assert.ok(vault.vaultHasRecords(db) instanceof Promise)
  assert.equal(typeof vault.openCredentialVault, 'function')
  assert.ok(writeBehind.flushWrites() instanceof Promise)
  // 使用记录仓储全部经 DbClient：写入与读取都返回 Promise
  const logs = new UsageLogsRepo(db)
  const pending = [logs.count(), logs.totals(), logs.vmOwnerOf('vm-x'), logs.cleanup({ retainDays: 1 })]
  for (const promise of pending) assert.ok(promise instanceof Promise)
  await Promise.all(pending)
})

test('removed exit names do not appear in src', () => {
  const names =
    /\b(?:readColdSync|latestConfigRevisionSync|loadSettingsRowSync|recordVendorUsageSync|gatewayAccountResourceSync|vmAccountResourceSync|insertUsageFactSync|replaceAllSync|platformSync|upsertFromVmJsonSync|setSync|removeSync)\b|\.getSync\(/
  const offenders = []
  for (const file of sources(path.join(ROOT, 'src'))) {
    const code = stripComments(fs.readFileSync(file, 'utf8'))
    if (names.test(code)) offenders.push(path.relative(ROOT, file))
  }
  assert.deepEqual(offenders, [])
})
