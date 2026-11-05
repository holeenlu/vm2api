#!/usr/bin/env node
/**
 * SQL 边界守卫（docs/DATA_ACCESS_AND_API_ARCHITECTURE_20261105.md 4.2、R1）：
 * SQL 只能写在仓储里——`src/lib/db/` 下、任意 `repos/` 目录中，或文件名以 `-repo.mjs` 结尾的文件。
 * 其他文件中的 SQL 调用点必须与基线 `scripts/sql-boundary-baseline.json` 完全一致：
 * 新增调用点直接失败；减少后也要同步改小基线，保证基线只减不增、始终反映现状。
 * 基线只收有依据的豁免（上游原有代码、连接基础设施、一次性迁移），见单测 test/unit/sql-boundary.test.mjs。
 *
 * SQL 调用点：`.prepare(` 后跟字符串、模板字符串或变量（排除 `.prepare({…})` 之类的非 SQL 接口），
 * 以及 `db.exec(` / `getDb().exec(` 等数据库对象上的 `exec`。
 *
 * 用法：node scripts/sql-boundary.mjs [--root <dir>] [--json]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const BASELINE_FILE = 'scripts/sql-boundary-baseline.json'

/** 仓储位置：这些文件里的 SQL 不受基线约束。 */
export function isRepositoryPath(rel) {
  const p = rel.split(path.sep).join('/')
  return p.startsWith('src/lib/db/') || p.includes('/repos/') || p.endsWith('-repo.mjs')
}

const PREPARE = /\.prepare\(\s*(.)/g
const EXEC = /(?:\b\w*(?:db|Db|DB|database)\w*|getDb\(\))\s*\.exec\(/g

/** 统计一段源码中的 SQL 调用点。 */
export function countSqlSites(source) {
  let count = 0
  for (const match of source.matchAll(PREPARE)) if (/['"`A-Za-z_$]/.test(match[1])) count++
  for (const _ of source.matchAll(EXEC)) count++
  return count
}

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.name.endsWith('.mjs')) out.push(full)
  }
  return out
}

/** 仓储以外、含 SQL 调用点的文件 → 调用点数。 */
export function scan(root) {
  const counts = {}
  for (const file of walk(path.join(root, 'src'), [])) {
    const rel = path.relative(root, file).split(path.sep).join('/')
    if (isRepositoryPath(rel)) continue
    const n = countSqlSites(fs.readFileSync(file, 'utf8'))
    if (n > 0) counts[rel] = n
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
}

/** 与基线逐文件比较；返回问题列表（空表示通过）。 */
export function compare(actual, baseline) {
  const problems = []
  const files = new Set([...Object.keys(actual), ...Object.keys(baseline)])
  for (const file of [...files].sort()) {
    const have = actual[file] ?? 0
    const allowed = baseline[file]?.count ?? 0
    if (have > allowed)
      problems.push(
        `${file}: ${have} 处 SQL 调用点，基线允许 ${allowed}——把 SQL 写进仓储（repos/ 或 *-repo.mjs）；同步上游带来的上游原有 SQL 按上游优先不搬，在基线登记为 exempt 并写明原因`,
      )
    else if (have < allowed)
      problems.push(`${file}: 已减少到 ${have} 处，请把基线中的 count 改为 ${have}（为 0 时删除该条）`)
  }
  return problems
}

export function loadBaseline(root) {
  const raw = JSON.parse(fs.readFileSync(path.join(root, BASELINE_FILE), 'utf8'))
  return raw.files || {}
}

function main(argv) {
  const rootIndex = argv.indexOf('--root')
  const root =
    rootIndex >= 0
      ? path.resolve(argv[rootIndex + 1])
      : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const actual = scan(root)
  const problems = compare(actual, loadBaseline(root))
  if (argv.includes('--json')) console.log(JSON.stringify({ actual, problems }, null, 2))
  else if (problems.length) console.error(problems.join('\n'))
  else console.log(`SQL 边界：仓储以外 ${Object.values(actual).reduce((a, b) => a + b, 0)} 处，与基线一致`)
  return problems.length ? 1 : 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2))
