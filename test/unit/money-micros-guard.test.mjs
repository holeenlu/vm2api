// 金额整数化（技术债 M6）守卫：权威值是整数列 `<name>_micros`，REAL 金额列只是由整数派生的展示镜像。
// 扫描 src 下全部 .mjs，以下写法只允许出现在豁免清单列出的文件里，且每个文件的处数与清单完全一致
// （新增直接失败；减少后要同步改小清单，清单只减不增）：
//   - SQL：对 REAL 金额列求和（SUM/TOTAL/AVG/MIN/MAX，含 `SUM(${… 'total_cost' …})` 这类动态拼接）、在 CASE 中取 REAL 金额
//     参与聚合、对 REAL 金额列做加减乘除或大小比较（>= <= > <）；
//   - SQL：UPDATE … SET / INSERT INTO 写 REAL 金额列，而同一条语句没有写对应的 `_micros` 列；
//   - SQL：动态列表的写入（`UPDATE t SET ${…}`、`INSERT INTO t (${…})`、`'INSERT INTO t (' + FIELDS.join(…)`）计一处，豁免写明列表来源；
//   - JS：对金额字段（total_cost、actual_cost、quota_used、cost_usd、amount_usdt…）做加减乘除、`+=`、大小比较（含 quota），
//     或把 REAL 金额读进局部变量（`const c = Number(row.total_cost)`，随后的运算无法再按字段名识别）。注释不计。
// 另外：新库的每个 REAL 列都要在 src/lib/core/money-columns.mjs 归类（金额镜像、比例或非金额），
// 金额镜像都要有整数列；127 之后的新迁移不得新增 REAL 金额列；各写入方写入后 REAL 与整数列逐行一致。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { MONEY_INTEGER_ONLY, MONEY_MIRRORS, NON_MONEY_REAL, RATIO_COLUMNS } from '../../src/lib/core/money-columns.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/** REAL 金额列名（所有表合并；`cost` 只在 usage_stats_hourly，SQL 规则单独按表处理）。 */
const SQL_MONEY = [...new Set(Object.values(MONEY_MIRRORS).flat())].filter((c) => c !== 'cost' && c !== 'value')
/** JS 里按字段名识别的金额（同名的非金额字段——如账号额度对象 `quota`——由豁免清单说明）。 */
const JS_MONEY = [
  'input_cost',
  'output_cost',
  'cache_read_cost',
  'cache_creation_cost',
  'web_search_cost',
  'image_cost',
  'total_cost',
  'actual_cost',
  'cost_usd',
  'amount_usdt',
  'paid_usdt',
  'quota_used',
  'usage_5h',
  'usage_1d',
  'usage_7d',
  'rate_limit_5h',
  'rate_limit_1d',
  'rate_limit_7d',
  'image_price_1k',
  'image_price_2k',
  'image_price_4k',
  'web_search_price_per_call',
  'balance',
  'quota',
]

/**
 * 豁免清单：文件 → { sql, write, js, reason }（各类处数，缺省为 0）。
 * 只收展示层的比较/排序、与金额同名的非金额字段，以及迁移前后都必须保留的兼容入口。
 */
export const MONEY_GUARD_EXEMPTIONS = {
  'src/lib/vendor/repos/account-usage-repo.mjs': {
    sql: 1,
    reason: '账号用量 ORDER BY cost_usd：cost_usd 是 VENDOR_USAGE_SELECT 里由整数列求和换算的别名，排序顺序与整数相同',
  },
  'src/lib/admin/repos/billing-reconcile-repo.mjs': {
    sql: 3,
    reason:
      '计费对账（审计 W9，原 scripts/audit-money-micros.mjs）的旧口径对照：小时汇总与明细的 REAL 合计、结算扣费与使用记录 REAL 实际价之差、供应商已付 REAL 合计，只报告与整数口径的偏差，判定只用整数列',
  },
  'src/lib/admin/billing-reconcile.mjs': {
    js: 1,
    reason: '计费对账的余额镜像漂移计数：比较 users.balance（REAL 镜像）与 balance_micros / 1e6，只报告，不参与判定',
  },
  'src/lib/admin/notify.mjs': {
    js: 1,
    reason: '通知文案的今日费用（todayCost）：取账单汇总里已由整数换算的美元值，只用于格式化展示，不参与计算',
  },
  'src/lib/vendor/projections/usage-projection.mjs': {
    js: 1,
    reason: '供应商用量的展示投影：把已由整数换算的 cost_usd 规范成数字或 null，不参与计算',
  },
  'src/lib/db/repos/api-keys-repo.mjs': {
    write: 2,
    reason:
      'INSERT / UPDATE 的列表来自 WRITE_COLUMNS = COLUMNS + 全部 *_micros，toValue 让 REAL 由整数派生；money-micros.test 的写入方用例覆盖',
  },
  'src/lib/db/repos/groups-repo.mjs': {
    write: 2,
    reason:
      'INSERT / UPDATE 的列表来自 FIELDS，含四个媒体单价的 *_micros；patchFields 两列同写，money-micros.test 覆盖',
  },
  'src/lib/db/repos/usage-logs-repo.mjs': {
    sql: 1,
    write: 4,
    reason:
      'INSERT / INSERT OR IGNORE 的列表来自 SUMMARY_COLUMNS（含全部 *_micros，toRow 让 REAL 由整数派生）；重新定价的 UPDATE 与启动补齐的 UPDATE 由 REPRICE_MONEY / USAGE_LOG_MONEY_COLUMNS 生成，两列同写或只写整数列；分组统计 ORDER BY cost_usd 排的是同一查询里由整数列求和换算的别名，顺序与整数相同',
  },
  'src/lib/db/repos/users-repo.mjs': {
    write: 2,
    reason: 'INSERT 的列表来自 COLUMNS，含 balance 与 balance_micros（REAL 由整数派生）；UPDATE_COLUMNS 不含余额两列',
  },
  'src/lib/admin/relay-migration.mjs': {
    js: 1,
    reason:
      '迁移预检报告 rounding_difference = balance_micros / 1e6 − balance：专门展示 REAL 余额与整数余额的舍入差，只读诊断，不参与记账',
  },
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.name.endsWith('.mjs')) out.push(full)
  }
  return out
}

/** 源码里的字符串与模板字符串（粗略切分，足够识别 SQL 片段）。 */
function literals(source) {
  const out = []
  const re = /`(?:\\[\s\S]|[^`\\])*`|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g
  for (const m of source.matchAll(re)) out.push(m[0].slice(1, -1))
  return out
}

const SQL_HINT = /\b(SELECT|UPDATE|INSERT|SUM|COALESCE|CASE|WHERE)\b/
const col = (c) => `(?:\\b[a-z]\\.)?\\b${c}\\b(?!_micros|\\w)`

export function countSqlMoney(source) {
  const any = SQL_MONEY.join('|')
  const agg = new RegExp(
    `\\b(?:SUM|TOTAL|AVG|MIN|MAX)\\s*\\(\\s*(?:IFNULL\\(|COALESCE\\()?\\s*${col(`(?:${any})`)}`,
    'g',
  )
  const caseThen = new RegExp(`\\bTHEN\\s+(?:IFNULL\\(|COALESCE\\()?\\s*${col(`(?:${any})`)}`, 'g')
  // 按 REAL 金额排序（例：ORDER BY total_cost DESC）
  const orderBy = new RegExp(
    `\\bORDER\\s+BY\\s+(?:[\\w.]+(?:\\s+(?:ASC|DESC))?\\s*,\\s*)*(?:IFNULL\\(|COALESCE\\()?\\s*${col(`(?:${any})`)}`,
    'gi',
  )
  const arith = new RegExp(`${col(`(?:${any})`)}\\s*[-+*/]\\s*[\\w(]|[\\w)]\\s*[-+*/]\\s*${col(`(?:${any})`)}`, 'g')
  // 比较：额度、窗口与金额的大小判断（例：quota_used>=quota、total_cost > 0）
  const compare = new RegExp(
    `${col(`(?:${any})`)}\\s*(?:<=|>=|<(?!>)|>)|(?:<=|>=|<|(?<![<=-])>)\\s*${col(`(?:${any})`)}`,
    'g',
  )
  // 动态拼接：聚合的参数是插值表达式，且其中出现金额列名字符串（例：SUM(${k ? 'actual_cost' : 'total_cost'})）
  const dynamicAgg = new RegExp(
    `\\b(?:SUM|TOTAL|AVG|MIN|MAX)\\s*\\(\\s*\\$\\{(?!\\s*(?:moneySql|microsSumSql|usdSumSql)\\()[^}]*'(?:${any})'[^}]*\\}`,
    'g',
  )
  let n = 0
  for (const text of literals(source)) {
    if (!SQL_HINT.test(text)) continue
    for (const re of [agg, caseThen, orderBy, arith, compare, dynamicAgg]) n += (text.match(re) || []).length
  }
  return n
}

export function countSqlWrites(source) {
  let n = 0
  for (const text of literals(source)) {
    const update = /\bUPDATE\s+(\w+)\s+SET\b/i.exec(text)
    const insert = /\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+(\w+)\s*\(([^)]*)\)/i.exec(text)
    const table = update?.[1] || insert?.[1]
    // 动态列表（UPDATE t SET ${…}、INSERT INTO t (${…})、'INSERT INTO t (' + FIELDS.join(…)）：静态看不出写了哪些列，
    // 计一处，由豁免清单写明列表来源（必须含全部 *_micros）
    const dynamic =
      /\bUPDATE\s+(\w+)\s+SET\s*(?:\$\{|$)|\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+(\w+)\s*\(\s*(?:\$\{|$)/i.exec(text)
    if (dynamic && MONEY_MIRRORS[dynamic[1] || dynamic[2]]) {
      n++
      continue
    }
    if (!table || !MONEY_MIRRORS[table]) continue
    for (const c of MONEY_MIRRORS[table]) {
      const written = update
        ? new RegExp(`(?:^|[\\s,])${c}\\s*=`).test(text.slice(update.index))
        : new RegExp(`(?:^|[\\s,(])${c}(?:[\\s,)]|$)`).test(insert[2])
      if (written && !new RegExp(`\\b${c}_micros\\b`).test(text)) n++
    }
  }
  return n
}

export function countJsMoney(source) {
  const code = source
    .replace(/`(?:\\[\s\S]|[^`\\])*`|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
  const any = JS_MONEY.join('|')
  const field = `(?:\\.|\\?\\.)(?:${any})\\b(?!_micros|\\w)`
  // `quota` 也是账号额度对象（vm.quota、account.quota）与权重的名字，只在比较规则里按金额看待
  const amountField = `(?:\\.|\\?\\.)(?:${JS_MONEY.filter((f) => f !== 'quota').join('|')})\\b(?!_micros|\\w)`
  const re = new RegExp(
    `${amountField}\\s*\\)?\\s*(?:[-+*/](?![-+=*/>])|[-+*/]=)|(?:[-+*/](?!/)|[-+*/]=)\\s*(?:Number\\()?[\\w$.?\\[\\]]*${amountField}`,
    'g',
  )
  // 比较：(rec.quota_used ?? 0) >= rec.quota、Number(rec.usage_5h) >= …（箭头函数的 => 不算）
  const compare = new RegExp(
    `${field}\\s*(?:\\?\\?\\s*[\\w.]+\\s*)?\\)?\\s*(?:<=|>=|<(?![<=])|(?<![=>])>(?![>=]))|(?:<=|>=|<(?![<=])|(?<![=>-])>(?![>=]))\\s*\\(?(?:Number\\()?[\\w$.?\\[\\]]*${field}`,
    'g',
  )
  // 把 REAL 金额读进局部变量（随后的运算识别不了）：const c = Number(row.total_cost)
  const local = new RegExp(
    `\\b(?:const|let|var)\\s+[\\w$]+\\s*=\\s*(?:Number\\()?[\\w$.?\\[\\]]*${amountField}(?!\\s*\\)?\\s*[-+*/])`,
    'g',
  )
  // 带兜底的读取再参与运算：(x.total_cost || 0) * k、sum + (r.actual_cost ?? 0)
  const fallback = new RegExp(
    `${amountField}\\s*(?:\\|\\||\\?\\?)\\s*[\\w.]+\\s*\\)\\s*(?:[-+*/](?![-+=*/>])|[-+*/]=)|(?:[-+*/](?!/)|[-+*/]=)\\s*\\(\\s*(?:Number\\()?[\\w$.?\\[\\]]*${amountField}\\s*(?:\\|\\||\\?\\?)`,
    'g',
  )
  return [re, compare, local, fallback].reduce((n, r) => n + (code.match(r) || []).length, 0)
}

export function scanMoney(root = ROOT) {
  const out = {}
  for (const file of walk(path.join(root, 'src'))) {
    const rel = path.relative(root, file).split(path.sep).join('/')
    const source = fs.readFileSync(file, 'utf8')
    const counts = { sql: countSqlMoney(source), write: countSqlWrites(source), js: countJsMoney(source) }
    if (counts.sql || counts.write || counts.js) out[rel] = counts
  }
  return out
}

test('REAL 金额列不再被求和、计算或单独写入（豁免清单逐文件逐类相等）', () => {
  const found = scanMoney()
  const problems = []
  const files = new Set([...Object.keys(found), ...Object.keys(MONEY_GUARD_EXEMPTIONS)])
  for (const file of [...files].sort()) {
    const got = found[file] || {}
    const want = MONEY_GUARD_EXEMPTIONS[file] || {}
    for (const kind of ['sql', 'write', 'js']) {
      if ((got[kind] || 0) !== (want[kind] || 0))
        problems.push(`${file}: ${kind} ${got[kind] || 0}（清单 ${want[kind] || 0}）`)
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'))
  for (const [file, entry] of Object.entries(MONEY_GUARD_EXEMPTIONS)) assert.ok(entry.reason, `${file}: 豁免要写原因`)
})

test('扫描规则识别 SQL 聚合、单独写 REAL 与 JS 金额运算', () => {
  assert.equal(countSqlMoney('db.one(`SELECT SUM(total_cost) FROM usage_logs`)'), 1)
  assert.equal(countSqlMoney('db.one(`SELECT SUM(u.actual_cost) FROM usage_logs u`)'), 1)
  assert.equal(countSqlMoney('db.one(`SELECT SUM(CASE WHEN ok THEN total_cost ELSE 0 END) FROM usage_logs`)'), 1)
  assert.equal(countSqlMoney("db.one('SELECT total_cost * 2 FROM usage_logs')"), 1)
  assert.equal(countSqlMoney('db.one(`SELECT SUM(total_cost_micros) / 1000000.0 AS total_cost FROM usage_logs`)'), 0)
  assert.equal(countSqlWrites("db.run('UPDATE usage_logs SET actual_cost=? WHERE id=?')"), 1)
  assert.equal(countSqlWrites("db.run('UPDATE usage_logs SET actual_cost_micros=?,actual_cost=? WHERE id=?')"), 0)
  assert.equal(countSqlWrites("db.run('INSERT INTO vendor_payments (id,amount_usdt) VALUES (?,?)')"), 1)
  assert.equal(
    countSqlWrites("db.run('INSERT INTO vendor_payments (id,amount_usdt,amount_usdt_micros) VALUES (?,?,?)')"),
    0,
  )
  assert.equal(countJsMoney('const x = row.total_cost * rate'), 1)
  // 复审 P2-3 的漏检写法
  assert.equal(countJsMoney('const y = (x.total_cost || 0) * k'), 1)
  assert.equal(countJsMoney('const t = rows.reduce((sum, r) => sum + (r.actual_cost ?? 0), 0)'), 1)
  assert.equal(
    countSqlMoney('db.one(`SELECT SUM(CASE WHEN ok THEN IFNULL(total_cost,0) ELSE 0 END) FROM usage_logs`)'),
    1,
  )
  assert.equal(countSqlMoney('db.many(`SELECT id FROM usage_logs ORDER BY total_cost DESC`)'), 1)
  assert.equal(countSqlMoney('db.many(`SELECT id FROM usage_logs ORDER BY created_at DESC, actual_cost`)'), 1)
  assert.equal(countJsMoney('acc.cost += Number(r.actual_cost)'), 1)
  assert.equal(countJsMoney('total += row.cost_usd'), 1)
  assert.equal(countJsMoney('const x = row.total_cost_micros * rate'), 0)
  assert.equal(countJsMoney('const x = fromMicros(row.total_cost_micros)'), 0)
  // 比较（审查补充）：JS 与 SQL 的额度、窗口、金额大小判断
  assert.equal(countJsMoney('if ((rec.quota_used ?? 0) >= rec.quota) block()'), 1)
  assert.equal(countJsMoney('if (Number(rec.usage_5h) >= Number(rec.rate_limit_5h)) block()'), 1)
  assert.equal(countJsMoney('rows.sort((a, b) => b.total_cost - a.total_cost)'), 1)
  assert.equal(countJsMoney('const c = Number(row.total_cost); total = total + c'), 1)
  assert.equal(countJsMoney('rows.map((r) => r.total_cost)'), 0, '箭头函数不算比较')
  assert.equal(countJsMoney('if (rec.quota_micros >= rec.quota_used_micros) block()'), 0)
  assert.equal(countJsMoney('// account.state / account.quota 是快照'), 0, '注释不计')
  assert.equal(
    countSqlMoney("db.run(`UPDATE api_keys SET status='quota_exhausted' WHERE quota>0 AND quota_used>=quota`)"),
    2,
  )
  assert.equal(countSqlMoney('db.many(`SELECT * FROM usage_logs WHERE total_cost > 0`)'), 1)
  assert.equal(countSqlMoney('db.many(`SELECT * FROM usage_logs WHERE total_cost_micros > 0`)'), 0)
  assert.equal(countSqlMoney("db.one(`SELECT SUM(${k ? 'actual_cost' : 'total_cost'}) FROM usage_logs`)"), 1)
  assert.equal(countSqlMoney("db.one(`SELECT SUM(${moneySql('actual_cost')}) FROM usage_logs`)"), 0)
  assert.equal(countSqlWrites('db.run(`UPDATE api_keys SET ${cols.map((c) => c + "=?").join(",")} WHERE id=?`)'), 1)
  assert.equal(countSqlWrites("db.run('INSERT INTO groups (' + FIELDS.join(',') + ') VALUES (?)')"), 1)
})

test('新库的每个 REAL 列都已归类，金额镜像都有整数列', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'money-guard-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const db = createDatabase({ dataDir: dir })
  t.after(() => db.close())
  const classified = (table, column) =>
    [MONEY_MIRRORS, RATIO_COLUMNS, NON_MONEY_REAL].some((group) => group[table]?.includes(column))
  const problems = []
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
    const columns = db.prepare(`PRAGMA table_info(${name})`).all()
    const names = new Set(columns.map((c) => c.name))
    for (const c of columns)
      if (/REAL|FLOA|DOUB|NUMERIC|DECIMAL/i.test(c.type) && !classified(name, c.name))
        problems.push(`${name}.${c.name}（${c.type}）未在 money-columns.mjs 归类`)
    for (const c of MONEY_MIRRORS[name] || []) {
      const micros = c === 'balance' && name === 'users' ? 'balance_micros' : `${c}_micros`
      if (!names.has(micros)) problems.push(`${name}.${c} 没有整数列 ${micros}`)
      else if (columns.find((x) => x.name === micros).type !== 'INTEGER')
        problems.push(`${name}.${micros} 不是 INTEGER`)
    }
    for (const c of MONEY_INTEGER_ONLY[name] || [])
      if (!names.has(c)) problems.push(`${name}.${c} 不存在（登记表过期）`)
  }
  for (const [table, cols] of Object.entries(MONEY_MIRRORS))
    for (const c of cols)
      if (
        !db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .some((x) => x.name === c)
      )
        problems.push(`${table}.${c} 不存在（登记表过期）`)
  assert.deepEqual(problems, [], problems.join('\n'))
})

test('127 之后的新迁移不得新增 REAL 金额列', () => {
  const dir = path.join(ROOT, 'src/lib/db/migrations')
  const MONEY_NAME = /(cost|price|balance|amount|quota|usd|usdt|fee|charge|spend|credit|budget|refund|payment)/i
  const problems = []
  for (const file of fs.readdirSync(dir).filter((f) => /^\d+.*\.sql$/.test(f))) {
    if (Number(file.split('_')[0]) <= 127) continue
    const sql = fs.readFileSync(path.join(dir, file), 'utf8').replace(/--[^\n]*/g, '')
    for (const m of sql.matchAll(/\b(\w+)\s+(REAL|FLOAT|DOUBLE|NUMERIC|DECIMAL)\b/gi))
      if (MONEY_NAME.test(m[1])) problems.push(`${file}: ${m[1]} ${m[2]}（金额用 INTEGER 的 *_micros，见 M6 约定）`)
  }
  assert.deepEqual(problems, [], problems.join('\n'))
})

test('126/127 只新增整数金额列', () => {
  for (const file of ['126_money_micros.sql', '127_money_micros_rollups.sql']) {
    const sql = fs.readFileSync(path.join(ROOT, 'src/lib/db/migrations', file), 'utf8')
    for (const m of sql.matchAll(/ADD COLUMN (\w+) (\w+)/g)) {
      assert.match(m[1], /_micros$/, `${file}: ${m[1]}`)
      assert.equal(m[2], 'INTEGER', `${file}: ${m[1]}`)
    }
  }
})
