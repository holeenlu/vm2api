import { RelayBilling } from '../admin/relay-billing.mjs'
import { dbClient } from '../db/db-client.mjs'
import { GatewayWorkerRepo } from './gateway-repo.mjs'
import { GatewayWorkerClient } from './gateway-client.mjs'
import { GatewayWorkerService } from './gateway-execution.mjs'
import { GatewayAccountManagement } from './account-management.mjs'
import { createExecutorEventIngest } from '../executor/event-ingest.mjs'
import { RequestAttemptsRepo } from '../db/repos/request-attempts-repo.mjs'
import { activeBpsGrantAccounts } from './repos/accounts-repo.mjs'
import { clearExpiredOAuthSessions } from './repos/oauth-sessions-repo.mjs'
import {
  getReceipt,
  hasBpsUsageLog,
  insertDeadLetter,
  linkChargeToReceipt,
  markUsageUnmetered,
  settleUsageLog,
} from './repos/receipts-repo.mjs'

// Worker 回执中不可能产生扣费的终态（completed 与 ambiguous 之外）
const UNSETTLED_TERMINAL_STATES = new Set(['upstream_error', 'incomplete', 'cancelled'])
// BPS 中断（截断、调用方中途断开、复制中断结果不明）与断流后本地补出的完成，按 Worker 累计的已消耗用量下限结算；
// 明确的上游失败仍不计量（审计 C1）
const BPS_LOWER_BOUND_STATES = new Set(['incomplete', 'cancelled', 'ambiguous', 'completed'])
// Worker 回执标记：BPS 上游在终态前断开，完成终态由转换器补出（与 worker attempt.go bpsCutoffCompleted 同名）
const BPS_CUTOFF_COMPLETED = 'bps_cutoff_completed'
// BPS 模型目录定时缓存（P4.5）：每 30 分钟检查一次，目录超过 6 小时未更新的账号经 Worker 补查，每轮最多 5 个、最久未更新的优先
const BPS_CATALOG_CHECK_MS = 30 * 60_000
const BPS_CATALOG_STALE_MS = 6 * 60 * 60_000
const BPS_CATALOG_BATCH = 5
const BPS_CATALOG_RETRY_MS = 60 * 60_000

export function createGatewayWorkerReconciler({
  db,
  apiKeyStore,
  intervalMs = 5000,
  replayIntervalMs = 60_000,
  client = null,
  now = () => Date.now(),
  eventsMode = null,
  onAccountState = null,
  accountManager = null,
} = {}) {
  const repo = new GatewayWorkerRepo(db)
  const gatewayClient =
    client || new GatewayWorkerClient({ repo, secret: process.env.KIN_CODEX_GATEWAY_INTERNAL_TOKEN || '' })
  // 执行契约事件发件箱（KIN_EXECUTOR_EVENTS=off|shadow|primary，默认 off）；账号终态变化后与心跳路径一样处理 BPS 403 移组
  let accounts = accountManager
  const manager = () =>
    (accounts ||= new GatewayAccountManagement({
      repo,
      service: new GatewayWorkerService({ repo, secret: process.env.KIN_CODEX_GATEWAY_INTERNAL_TOKEN || '' }),
    }))
  const events = createExecutorEventIngest({
    db,
    repo,
    client: gatewayClient,
    mode: eventsMode,
    now,
    attemptsRepo: new RequestAttemptsRepo(db),
    onAccountState: onAccountState || (() => manager().reconcileBpsBlocks()),
  })
  let timer = null
  let running = false
  let lastReplayAt = 0
  // 第一轮在启动一个检查周期之后；补查在后台进行，不阻塞回执补拉与事件消费（R4 审查 P2-6）
  let lastCatalogAt = now()
  let catalogRunning = false
  const catalogFailures = new Map()

  // 请求路径（/v1/models 的 BPS 推理强度）只读账号上缓存的目录；这里按时补查，失败不改动已保存的目录
  async function refreshBpsCatalogs() {
    const cutoff = now() - BPS_CATALOG_STALE_MS
    const due = (await activeBpsGrantAccounts(db))
      .map((row) => {
        const config = JSON.parse(row.config_json || '{}')
        const fetchedAt = Date.parse(config.bps_catalog?.fetched_at || '')
        return { id: row.id, grant: !!config.bps_grant, fetchedAt: Number.isFinite(fetchedAt) ? fetchedAt : 0 }
      })
      // 最久未更新的优先；失败的账号 1 小时内不再重试，长期失败的账号不会占满每轮的名额
      .filter((row) => row.grant && row.fetchedAt < cutoff && (catalogFailures.get(row.id) || 0) <= now())
      .sort((a, b) => a.fetchedAt - b.fetchedAt)
      .slice(0, BPS_CATALOG_BATCH)
    let refreshed = 0
    for (const row of due) {
      try {
        await manager().bpsModels(row.id)
        catalogFailures.delete(row.id)
        refreshed++
      } catch {
        catalogFailures.set(row.id, now() + BPS_CATALOG_RETRY_MS)
      }
    }
    return { due: due.length, refreshed }
  }

  // Worker 推送 Receipt 只尝试一次；推送失败或 ack 丢失的回执留在 Worker spool 中，
  // 这里定期从在线实例拉回并幂等入库，入库（含重复）后 ack 让 Worker 清理 spool。
  async function replayReceipts() {
    const replayed = { ingested: 0, duplicate: 0, rejected: 0, failed: 0 }
    const instances = (await repo.listInstances()).filter((item) => ['healthy', 'degraded'].includes(item.health_state))
    for (const instance of instances) {
      let result
      try {
        result = await gatewayClient.replayReceipts(instance.id)
      } catch {
        replayed.failed++
        continue
      }
      if (!result?.ok) {
        replayed.failed++
        continue
      }
      for (const receipt of Array.isArray(result.data?.items) ? result.data.items : []) {
        if (!receipt?.dispatch_id || receipt.gateway_instance_id !== instance.id) {
          replayed.rejected++
          continue
        }
        const ingested = await repo.ingestReceipt(receipt)
        if (ingested.rejected) {
          replayed.rejected++
          continue
        }
        if (ingested.duplicate) replayed.duplicate++
        else replayed.ingested++
        try {
          await gatewayClient.ackReceipt(instance.id, receipt.dispatch_id, ingested.receipt_id)
        } catch {}
      }
    }
    return replayed
  }

  async function tick() {
    if (running) return
    running = true
    try {
      try {
        await events.tick()
      } catch (error) {
        console.warn(`executor events: tick failed: ${error?.message || error}`)
      }
      if (now() - lastCatalogAt >= BPS_CATALOG_CHECK_MS && !catalogRunning) {
        lastCatalogAt = now()
        catalogRunning = true
        void refreshBpsCatalogs()
          .catch(() => {})
          .finally(() => {
            catalogRunning = false
          })
        // 过期授权会话里的 PKCE verifier 不再保留（R3 审查 P2-4）
        try {
          await clearExpiredOAuthSessions(db, new Date(now()).toISOString())
        } catch {}
      }
      if (now() - lastReplayAt >= replayIntervalMs) {
        lastReplayAt = now()
        try {
          await replayReceipts()
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
          // BPS 中断流按已消耗用量下限结算（对齐 sub2api）：Worker 回执带转换累计的 partial 用量时，
          // 截断、调用方中途断开、复制中断或断流补完成的 BPS 请求按这部分用量计费；原生与 VM 路径保持不计量
          const bpsLowerBound =
            BPS_LOWER_BOUND_STATES.has(receipt?.terminal_state) &&
            receipt?.usage_confidence === 'partial' &&
            usage &&
            (await hasBpsUsageLog(db, job.dispatch_id))
          // Worker 已确认请求失败、截断或取消：与 VM 路径一样不计量，不等待用量也不进 dead letter
          if (UNSETTLED_TERMINAL_STATES.has(receipt?.terminal_state) && !bpsLowerBound) {
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
          // BPS 断流补完成或复制中断（ambiguous）且没有任何用量：没有可结算的证据，明确记为不计量，不重试、不进死信
          const bpsInterrupted =
            (receipt?.terminal_state === 'completed' && receipt?.error_code === BPS_CUTOFF_COMPLETED) ||
            receipt?.terminal_state === 'ambiguous'
          if (!usage && bpsInterrupted && (await hasBpsUsageLog(db, job.dispatch_id))) {
            await repo.finishReconciliation(job.id, 'unmetered', { error: 'bps_cutoff_no_usage' })
            await markUsageUnmetered(db, job.dispatch_id)
            continue
          }
          if (!usage || (confidence !== 'complete' && !bpsLowerBound)) {
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
            const settled = await billing.settle(context, usage, model, async (rate, actualCost, officialCost) => {
              if (apiRecord && apiKeyStore?.recordUsage)
                await apiKeyStore.recordUsage(apiRecord, usage, {
                  model,
                  rateMultiplier: rate,
                  actualCost,
                  officialCost,
                })
            })
            await settleUsageLog(
              db,
              settled?.status || 'settled',
              settled?.actual_micros == null ? null : settled.actual_micros / 1e6,
              receipt?.receipt_id || null,
              bpsLowerBound ? 'partial' : 'complete',
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
    replayReceipts,
    refreshBpsCatalogs,
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
