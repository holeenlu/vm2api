/**
 * 推理请求收口的补写（中期技术债 M3 复审 P1-3）。
 *
 * 收口（handle-protocol 的 commitRelayLog）在一个事务里写结算（billing_charges + 钱包扣款 + Key 用量）、
 * Gateway 对账任务与使用记录。数据库写不进去时整个事务失败，收口交给 `src/lib/db/commit-retry.mjs` 在后台重试；
 * 停机时仍未成功的条目写入 `data/request-logs/pending-commits.jsonl`，由 `scripts/replay-pending-commits.mjs` 补写。
 *
 * 条目只含补写需要的数据，不持有 req / res / 请求体：
 *   { version, request_id, plan: { settle?, reconciliation?, key_usage? }, summary }
 *   - settle：`RelayBilling.authorize` 冻结的结算上下文（含 quote_json、media_json、分组倍率）、计费用量、模型、Key 编号，
 *     以及按冻结报价算好的 actual_micros（只用于核对，补写时 settle 按同一上下文重新计算，结果相同）；
 *   - reconciliation：流式 Gateway 请求等待回执时的对账任务参数；
 *   - key_usage：没有结算上下文（旧式 Key）时的 Key 用量；
 *   - summary：使用记录摘要（原始完成时刻的 ts / duration_ms，不含调试正文）。
 * 补写在一个事务里：结算按 request_id 抢占（billing_charges，已结算的不再扣款），对账任务按 (实例, dispatch) 合并，
 * 使用记录按 request_id 幂等（insertSummaryIfAbsent）；key_usage 只在本次插入了使用记录时记，重复补写不重复计数。
 */
import { dbClient } from '../db/db-client.mjs'
import { fromMicros } from '../core/money.mjs'
import { RelayBilling } from './relay-billing.mjs'
import { GatewayWorkerRepo } from '../gateway-worker/gateway-repo.mjs'
import { releaseInflight } from './billing-inflight.mjs'

export const PENDING_COMMIT_VERSION = 1

/** 结算结果对应的使用记录计费列（与 finalizeCommercial 写入 logBag、requestLog.finish 生成摘要的口径相同）。 */
export function applySettlementToSummary(summary, item) {
  if (!item) return summary
  summary.billing_status = item.status || 'unmetered'
  if (item.group_id != null) summary.billing_group_id = item.group_id
  summary.subscription_id = item.subscription_id || null
  if (Number.isFinite(Number(item.rate_multiplier))) summary.rate_multiplier = Number(item.rate_multiplier)
  if (summary.total_cost_micros != null) {
    summary.actual_cost_micros = item.actual_micros ?? null
    summary.actual_cost = fromMicros(summary.actual_cost_micros)
  }
  return summary
}

/** 校验并取出条目里的 request_id；格式不对时为 null。 */
export function pendingCommitId(entry) {
  if (!entry || typeof entry !== 'object' || entry.version !== PENDING_COMMIT_VERSION) return null
  const id = String(entry.request_id || entry.summary?.request_id || '')
  return id || null
}

/**
 * 补写一条收口。deps：apiKeys（ApiKeyStore，记 Key 用量）、usageLogs（UsageLogsRepo）。
 * 返回 { request_id, settled, inserted }：settled 为结算状态（没有结算时为 null），inserted 表示本次插入了使用记录。
 */
export async function replayPendingCommit(db, entry, { apiKeys, usageLogs }) {
  const requestId = pendingCommitId(entry)
  if (!requestId) throw new Error('invalid pending commit entry')
  const plan = entry.plan || {}
  return dbClient(db).tx(async () => {
    const summary = entry.summary ? { ...entry.summary } : null
    let settled = null
    if (plan.reconciliation) await new GatewayWorkerRepo(db).enqueueReconciliation(plan.reconciliation)
    if (plan.settle) {
      const { context, usage, model, api_key_id: apiKeyId } = plan.settle
      const item = await new RelayBilling(db).settle(context, usage, model, async (rate, actual, official) => {
        await apiKeys.recordUsage(apiKeyId, usage, {
          model,
          rateMultiplier: rate,
          actualCostMicros: actual,
          officialCostMicros: official,
        })
      })
      settled = item?.status || null
      if (summary) applySettlementToSummary(summary, item)
    }
    let inserted = false
    if (summary) {
      summary.vm_owner_user_id = await usageLogs.vmOwnerOf(summary.vm_id)
      inserted = await usageLogs.insertSummaryIfAbsent(summary)
    }
    // 旧式 Key 没有 billing_charges 抢占：以使用记录是否本次插入判定是否已补写过
    if (plan.key_usage && (inserted || !summary)) {
      const keyUsage = plan.key_usage
      await apiKeys.recordUsage(keyUsage.api_key_id, keyUsage.usage, {
        model: keyUsage.model,
        rateMultiplier: keyUsage.rate_multiplier ?? 1,
        officialCostMicros: keyUsage.official_micros ?? undefined,
      })
    }
    // 补写完成即释放在途记录（审计阶段 1 W2），否则扫描会把它当成中断请求
    await releaseInflight(db, requestId)
    return { request_id: requestId, settled, inserted }
  })
}
