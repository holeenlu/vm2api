#!/usr/bin/env node
/**
 * 补写停机前没写进去的推理收口（中期技术债 M3 复审 P1-3）。
 *
 *   node scripts/replay-pending-commits.mjs --data-dir data            # 只读预览：列出待补写的条数与 request_id
 *   node scripts/replay-pending-commits.mjs --data-dir data --apply    # 按 request_id 幂等补写，补写成功的从文件移除
 *
 * 控制面数据库写不进去时，推理请求的收口（结算 + 使用记录）在后台重试（`src/lib/db/commit-retry.mjs`）；停机时仍未成功、
 * 或非数据库错误重试多次仍失败的条目追加到 `data/request-logs/pending-commits.jsonl`。每行只含补写需要的数据：
 * request_id、冻结的结算上下文（quote_json 等）与算好的金额、计费用量、模型、使用记录摘要（`src/lib/admin/settlement-replay.mjs`）。
 * 补写与运行时同一实现：`RelayBilling.settle` 按 request_id 抢占（已结算的不再扣款）、`insertSummaryIfAbsent` 跳过已存在的
 * 使用记录。处理前先把文件改名为 `pending-commits.<时间>.processing.jsonl`，处理完改为 `.done.jsonl`（作为归档），仍然失败的行追加回原文件。可在控制面运行时执行。
 */
import fs from 'node:fs'
import path from 'node:path'
import { openScriptDatabase } from '../src/lib/executor/repos/script-db-repo.mjs'
import { UsageLogsRepo } from '../src/lib/db/repos/usage-logs-repo.mjs'
import { ApiKeyStore } from '../src/lib/admin/api-keys.mjs'
import { PENDING_COMMITS_FILE } from '../src/lib/db/commit-retry.mjs'
import { pendingCommitId, replayPendingCommit } from '../src/lib/admin/settlement-replay.mjs'

/** 读出待补写的条目；损坏或版本不认识的行原样保留在 invalid 里。 */
export function readPendingCommits(file) {
  if (!fs.existsSync(file)) return { entries: [], invalid: [] }
  const entries = []
  const invalid = []
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line)
      if (pendingCommitId(parsed?.entry)) entries.push(parsed)
      else invalid.push(line)
    } catch {
      invalid.push(line)
    }
  }
  return { entries, invalid }
}

/** 补写；返回 { apply, total, replayed, inserted, existing, failed, invalid, request_ids }。 */
export async function replayPendingCommits({ db, file, apply = false, now = Date.now() }) {
  if (!apply) {
    const { entries, invalid } = readPendingCommits(file)
    return {
      apply,
      total: entries.length,
      replayed: 0,
      inserted: 0,
      existing: 0,
      failed: 0,
      invalid: invalid.length,
      request_ids: entries.map((line) => pendingCommitId(line.entry)),
    }
  }
  const report = { apply, total: 0, replayed: 0, inserted: 0, existing: 0, failed: 0, invalid: 0, request_ids: [] }
  if (!fs.existsSync(file)) return report
  // 先改名再读：控制面运行中继续追加的行落到新文件，不会被本次归档带走
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-')
  // 处理中用 .processing（中途崩溃时看得出没处理完，可改回原名重跑），处理完再改为 .done（复审二轮 P2-5）
  const processing = path.join(path.dirname(file), `pending-commits.${stamp}.processing.jsonl`)
  fs.renameSync(file, processing)
  const { entries, invalid } = readPendingCommits(processing)
  report.total = entries.length
  report.invalid = invalid.length
  const deps = { apiKeys: new ApiKeyStore({ db }), usageLogs: new UsageLogsRepo(db, { billingMaintenance: false }) }
  const remaining = []
  for (const line of entries) {
    const id = pendingCommitId(line.entry)
    report.request_ids.push(id)
    try {
      const result = await replayPendingCommit(db, line.entry, deps)
      report.replayed++
      if (result.inserted) report.inserted++
      else report.existing++
    } catch (error) {
      report.failed++
      remaining.push(
        JSON.stringify({
          ...line,
          retried_at: new Date(now).toISOString(),
          error: String(error?.message || error).slice(0, 300),
        }),
      )
    }
  }
  const left = [...remaining, ...invalid]
  if (left.length) fs.appendFileSync(file, `${left.join('\n')}\n`, { mode: 0o600 })
  fs.renameSync(processing, processing.replace(/\.processing\.jsonl$/, '.done.jsonl'))
  return report
}

async function main(argv) {
  const value = (flag) => {
    const index = argv.indexOf(flag)
    return index >= 0 ? argv[index + 1] : null
  }
  const dataDir = value('--data-dir')
  if (!dataDir) {
    console.error('usage: node scripts/replay-pending-commits.mjs --data-dir <dir> [--apply]')
    process.exit(2)
  }
  const apply = argv.includes('--apply')
  const file = path.join(dataDir, 'request-logs', PENDING_COMMITS_FILE)
  const db = openScriptDatabase({ dataDir, readOnly: !apply })
  try {
    console.log(JSON.stringify(await replayPendingCommits({ db, file, apply }), null, 2))
  } finally {
    db.close()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main(process.argv.slice(2))
