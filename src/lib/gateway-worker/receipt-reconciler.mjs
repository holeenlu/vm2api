import { RelayBilling } from '../admin/relay-billing.mjs'
import { dbClient } from '../db/db-client.mjs'
import { GatewayWorkerRepo } from './gateway-repo.mjs'
import { GatewayWorkerClient } from './gateway-client.mjs'
import { createExecutorEventIngest } from '../executor/event-ingest.mjs'
import { RequestAttemptsRepo } from '../db/repos/request-attempts-repo.mjs'
import { clearExpiredOAuthSessions } from './repos/oauth-sessions-repo.mjs'
import {
  getReceipt,
  insertDeadLetter,
  linkChargeToReceipt,
  markUsageUnmetered,
  settleUsageLog,
} from './repos/receipts-repo.mjs'

// Worker 回执中不可能产生扣费的终态（completed 与 ambiguous 之外）
const UNSETTLED_TERMINAL_STATES = new Set(['upstream_error', 'incomplete', 'cancelled'])
// 过期授权会话的清理周期：PKCE verifier 不在库里久留（R3 审查 P2-4）
const OAUTH_SESSION_CLEANUP_MS = 30 * 60_000

export function createGatewayWorkerReconciler({
  db,
  apiKeyStore,
  intervalMs = 5000,
  client = null,
  now = () => Date.now(),
} = {}) {
  const repo = new GatewayWorkerRepo(db)
  const gatewayClient =
    client || new GatewayWorkerClient({ repo, secret: process.env.KIN_CODEX_GATEWAY_INTERNAL_TOKEN || '' })
  // 执行契约事件发件箱（结算与账号运行态的唯一通道，2026-11-07 S2）
  const events = createExecutorEventIngest({
    db,
    repo,
    client: gatewayClient,
    now,
    attemptsRepo: new RequestAttemptsRepo(db),
  })
  let timer = null
  let running = false
  // 第一轮在启动一个清理周期之后
  let lastCleanupAt = now()

  async function tick() {
    if (running) return
    running = true
    try {
      try {
        await events.tick()
      } catch (error) {
        console.warn(`executor events: tick failed: ${error?.message || error}`)
      }
      if (now() - lastCleanupAt >= OAUTH_SESSION_CLEANUP_MS) {
        lastCleanupAt = now()
        try {
          await clearExpiredOAuthSessions(db, new Date(now()).toISOString())
        } catch {}
      }
      for (const job of await repo.dueReconciliation(25)) {
        const leaseUntil = new Date(Date.now() + 30_000).toISOString()
        // 任务抢占：条件更新 status='pending'→'running' 并检查 changes，并发的对账轮次（或多个对账器）只有一方拿到任务
        if (!(await repo.leaseReconciliation(job.id, leaseUntil))) continue
        try {
          const receipt = await getReceipt(db, job.gateway_instance_id, job.dispatch_id)
          const usage = receipt?.usage_json
            ? JSON.parse(receipt.usage_json)
            : job.usage_json
              ? JSON.parse(job.usage_json)
              : null
          const confidence = receipt?.usage_confidence || 'unknown'
          if (receipt)
            await repo.applyReceiptToUsage(
              receipt,
              await repo.findAccountByRuntime(receipt.gateway_instance_id, receipt.runtime_account_id),
            )
          // Worker 已确认请求失败、截断或取消：与 VM 路径一样不计量，不等待用量也不进 dead letter
          if (UNSETTLED_TERMINAL_STATES.has(receipt?.terminal_state)) {
            await repo.finishReconciliation(job.id, 'unmetered', { error: 'request_not_completed' })
            await markUsageUnmetered(db, job.dispatch_id)
            continue
          }
          const context = job.context_json ? JSON.parse(job.context_json) : null
          // 只有实时日志判定待结算时才带计费上下文；没有上下文说明实时日志已结算或不计量，
          // 上下文随后到达会重新打开任务
          // 任务关闭为不计量时同步收口实时日志：只改仍为 settlement_pending 的行，已结算的不受影响
          if (!context) {
            await repo.finishReconciliation(job.id, 'unmetered', { error: 'billing_context_missing' })
            await markUsageUnmetered(db, job.dispatch_id)
            continue
          }
          if (!usage || confidence !== 'complete') {
            if (Number(job.attempts || 0) >= 10) {
              // 重试用尽仍无可信用量：不按 0 元结算，记为不计量并留 dead letter 供人工核对；
              // 实时日志不能停在 settlement_pending（否则请求永远显示待结算）
              await repo.finishReconciliation(job.id, 'unmetered', { error: 'usage_evidence_incomplete' })
              await markUsageUnmetered(db, job.dispatch_id)
              await writeDeadLetter(repo, job, 'usage_evidence_incomplete')
            } else
              await repo.finishReconciliation(job.id, 'pending', {
                error: 'usage_evidence_incomplete',
                retryAt: new Date(Date.now() + Math.min(300_000, 2 ** Number(job.attempts || 1) * 1000)).toISOString(),
              })
            continue
          }
          const billing = new RelayBilling(db)
          const model = job.model || receipt?.upstream_model || null
          const apiRecord =
            context.api_key_id && apiKeyStore?.repo?.getById ? await apiKeyStore.repo.getById(context.api_key_id) : null
          // 结算（R19）：扣费、使用记录收口、回执关联与任务完成在同一事务里，中途失败整体回滚、任务按重试处理。
          // 同一请求只扣一次：RelayBilling.settle 先按 billing_charges 主键（request_id）抢占再扣款（竞态 R4），
          // 推理路径 finalizeCommercial 直接结算与这里对同一 request_id 的结算因此互斥
          await dbClient(db).tx(async () => {
            const settled = await billing.settle(
              context,
              usage,
              model,
              async (rate, actualCostMicros, officialCostMicros) => {
                if (apiRecord && apiKeyStore?.recordUsage)
                  await apiKeyStore.recordUsage(apiRecord, usage, {
                    model,
                    rateMultiplier: rate,
                    actualCostMicros,
                    officialCostMicros,
                  })
              },
            )
            await settleUsageLog(
              db,
              settled?.status || 'settled',
              settled?.actual_micros ?? null,
              receipt?.receipt_id || null,
              'complete',
              job.dispatch_id,
            )
            if (receipt?.receipt_id)
              await linkChargeToReceipt(db, receipt.receipt_id, 'gateway_worker_receipt', job.request_id)
            await repo.finishReconciliation(job.id, settled?.status === 'unmetered' ? 'unmetered' : 'settled')
          })
        } catch (error) {
          const attempts = Number(job.attempts || 0)
          if (attempts >= 10) {
            const message = String(error?.message || error)
            await repo.finishReconciliation(job.id, 'dead_letter', { error: message })
            await writeDeadLetter(repo, job, message)
          } else
            await repo.finishReconciliation(job.id, 'pending', {
              error: String(error?.message || error),
              retryAt: new Date(Date.now() + Math.min(300_000, 2 ** attempts * 1000)).toISOString(),
            })
        }
      }
    } finally {
      running = false
    }
  }

  return {
    start() {
      if (timer) return
      // tick 自带重入保护（上一轮未完成时直接返回）；拒绝在这里收口，不成为未处理的 Promise 拒绝
      const run = () =>
        void tick().catch((error) => console.warn(`gateway reconciler: tick failed: ${error?.message || error}`))
      timer = setInterval(run, intervalMs)
      timer.unref?.()
      run()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
    tick,
    events,
    repo,
  }
}

async function writeDeadLetter(repo, job, message) {
  try {
    await insertDeadLetter(
      repo.db,
      `dead_${job.id}`,
      'receipt_reconciliation',
      job.id,
      JSON.stringify({
        gateway_instance_id: job.gateway_instance_id,
        dispatch_id: job.dispatch_id,
        request_id: job.request_id,
        receipt_id: job.receipt_id,
      }),
      'settlement_pending',
      String(message).slice(0, 1000),
      Number(job.attempts || 0),
      new Date().toISOString(),
    )
  } catch {}
}
