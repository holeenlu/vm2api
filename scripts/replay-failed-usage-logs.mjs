#!/usr/bin/env node
/**
 * 补写落库失败的使用记录（中期技术债 M5 复审 P1-3）。
 *
 *   node scripts/replay-failed-usage-logs.mjs --data-dir data            # 只读预览：列出待补写的行数
 *   node scripts/replay-failed-usage-logs.mjs --data-dir data --apply    # 按 request_id 幂等补写，补写成功的从文件移除
 *
 * 控制面在使用记录落库失败时（结算可能已提交）把整行追加到 `data/request-logs/failed-usage-logs.jsonl`。
 * 补写走与运行时相同的 `insertSummaryIfAbsent`（同一事务写供应商用量事实，已存在的 request_id 跳过），
 * 处理前先把文件改名为 `failed-usage-logs.<时间>.done.jsonl`（作为归档），仍然失败的行追加回原文件。可在控制面运行时执行。
 */
import fs from 'node:fs'
import path from 'node:path'
import { openScriptDatabase } from '../src/lib/executor/repos/script-db-repo.mjs'
import { UsageLogsRepo } from '../src/lib/db/repos/usage-logs-repo.mjs'
import { FAILED_USAGE_LOGS_FILE } from '../src/lib/admin/request-log.mjs'

/** 读出待补写的行；损坏的行原样保留在 invalid 里。 */
export function readFailedUsageLogs(file) {
  if (!fs.existsSync(file)) return { entries: [], invalid: [] }
  const entries = []
  const invalid = []
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line)
      if (parsed?.summary && (parsed.summary.request_id || parsed.summary.id)) entries.push(parsed)
      else invalid.push(line)
    } catch {
      invalid.push(line)
    }
  }
  return { entries, invalid }
}

/** 补写；返回 { apply, total, inserted, existing, failed, invalid }。 */
export async function replayFailedUsageLogs({ db, file, apply = false, now = Date.now() }) {
  if (!apply) {
    const { entries, invalid } = readFailedUsageLogs(file)
    return { apply, total: entries.length, inserted: 0, existing: 0, failed: 0, invalid: invalid.length }
  }
  if (!fs.existsSync(file)) return { apply, total: 0, inserted: 0, existing: 0, failed: 0, invalid: 0 }
  // 先改名再读：控制面运行中继续追加的失败行落到新文件，不会被本次归档带走
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-')
  const processing = path.join(path.dirname(file), `failed-usage-logs.${stamp}.done.jsonl`)
  fs.renameSync(file, processing)
  const { entries, invalid } = readFailedUsageLogs(processing)
  const report = { apply, total: entries.length, inserted: 0, existing: 0, failed: 0, invalid: invalid.length }
  const repo = new UsageLogsRepo(db, { billingMaintenance: false })
  const remaining = []
  for (const entry of entries) {
    try {
      if (await repo.insertSummaryIfAbsent(entry.summary)) report.inserted++
      else report.existing++
    } catch (error) {
      report.failed++
      remaining.push(
        JSON.stringify({
          ...entry,
          retried_at: new Date(now).toISOString(),
          error: String(error?.message || error).slice(0, 300),
        }),
      )
    }
  }
  const left = [...remaining, ...invalid]
  if (left.length) fs.appendFileSync(file, `${left.join('\n')}\n`, { mode: 0o600 })
  return report
}

async function main(argv) {
  const value = (flag) => {
    const index = argv.indexOf(flag)
    return index >= 0 ? argv[index + 1] : null
  }
  const dataDir = value('--data-dir')
  if (!dataDir) {
    console.error('usage: node scripts/replay-failed-usage-logs.mjs --data-dir <dir> [--apply]')
    process.exit(2)
  }
  const apply = argv.includes('--apply')
  const file = path.join(dataDir, 'request-logs', FAILED_USAGE_LOGS_FILE)
  const db = openScriptDatabase({ dataDir, readOnly: !apply })
  try {
    console.log(JSON.stringify(await replayFailedUsageLogs({ db, file, apply }), null, 2))
  } finally {
    db.close()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main(process.argv.slice(2))
