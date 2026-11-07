/**
 * Gateway Worker 追加型表的保留期清理（审计阶段 1 W5，保留清单见 docs/data-retention.md）。
 *
 * 回执、派发、终态的对账任务与死信保留 30 天；授权会话在过期 7 天后删除。挂在使用记录的 10 分钟清理周期上
 * （request-log.mjs `cleanup`），按 batch-delete.mjs 分批、批间让出事件循环，经 DbClient 异步访问。
 *
 * 这几张表除授权会话外都没有时间列索引：按 rowid 取表头一批（最早写入的行，O(批大小)）再按时间过滤，
 * 行按写入顺序追加，表头就是最旧的行；不能删的行（未终态的对账任务等）只会让本批少删，不会让扫描退化成全表。
 * 没有外键引用这些表；派发行删除后迟到 30 天以上的回执不再改写使用记录（gateway-repo 要求派发行存在），
 * 使用记录本身默认只保留 7 天。
 */
import { dbClient } from '../../db/db-client.mjs'
import { deleteInBatches } from '../../db/batch-delete.mjs'

export const GATEWAY_HISTORY_RETAIN_DAYS = 30
export const GATEWAY_OAUTH_SESSION_RETAIN_DAYS = 7

const headBatch = (table, predicate) =>
  `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} ORDER BY rowid LIMIT ?) AND ${predicate}`

const PRUNES = [
  ['gateway_worker_receipts', headBatch('gateway_worker_receipts', 'created_at < ?')],
  ['gateway_worker_dispatches', headBatch('gateway_worker_dispatches', 'created_at < ?')],
  // 只删终态：pending / running 仍由对账循环处理。`+status` 不让规划器改走 (status, …) 索引去扫全部终态行
  [
    'gateway_worker_reconciliation_jobs',
    headBatch(
      'gateway_worker_reconciliation_jobs',
      "+status IN ('settled','unmetered','dead_letter') AND updated_at < ?",
    ),
  ],
  ['gateway_worker_dead_letters', headBatch('gateway_worker_dead_letters', 'created_at < ?')],
]
// 授权会话走迁移 130 的 (status, expires_at) 索引：列全状态让每个状态各取一段过期区间
const PRUNE_OAUTH_SESSIONS_SQL = `DELETE FROM gateway_worker_oauth_sessions WHERE session_id IN (
  SELECT session_id FROM gateway_worker_oauth_sessions
   WHERE status IN ('pending','completed','failed','expired','cancelled') AND expires_at < ? LIMIT ?)`

/** 删除超出保留期的 Gateway Worker 历史行，返回各表删除行数。 */
export async function pruneGatewayWorkerHistory(
  db,
  {
    now = Date.now(),
    retainDays = GATEWAY_HISTORY_RETAIN_DAYS,
    oauthSessionRetainDays = GATEWAY_OAUTH_SESSION_RETAIN_DAYS,
  } = {},
) {
  const client = dbClient(db)
  const cutoff = new Date(now - retainDays * 86400_000).toISOString()
  const result = {}
  for (const [table, sql] of PRUNES)
    result[table] = await deleteInBatches(async (limit) => (await client.run(sql, limit, cutoff)).changes, {
      untilEmpty: true,
    })
  const expiredBefore = new Date(now - oauthSessionRetainDays * 86400_000).toISOString()
  result.gateway_worker_oauth_sessions = await deleteInBatches(
    async (limit) => (await client.run(PRUNE_OAUTH_SESSIONS_SQL, expiredBefore, limit)).changes,
  )
  return result
}
