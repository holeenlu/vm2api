import { RelayBilling } from '../admin/relay-billing.mjs'
import { GatewayWorkerRepo } from './gateway-repo.mjs'
import { GatewayWorkerClient } from './gateway-client.mjs'
import { GatewayWorkerService } from './gateway-execution.mjs'
import { GatewayAccountManagement } from './account-management.mjs'
import { createExecutorEventIngest } from '../executor/event-ingest.mjs'
import { RequestAttemptsRepo } from '../db/repos/request-attempts-repo.mjs'

// Worker 回执中不可能产生扣费的终态（completed 与 ambiguous 之外）
const UNSETTLED_TERMINAL_STATES = new Set(['upstream_error', 'incomplete', 'cancelled'])
// BPS 中断（截断、调用方中途断开）按 Worker 累计的已消耗用量下限结算；明确的上游失败仍不计量
const BPS_LOWER_BOUND_STATES = new Set(['incomplete', 'cancelled'])
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
    const due = db
      .prepare(`SELECT id,config_json FROM vendor_resources WHERE status='active' AND config_json LIKE '%"bps_grant"%'`)
      .all()
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
    const instances = repo.listInstances().filter((item) => ['healthy', 'degraded'].includes(item.health_state))
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
        const ingested = repo.ingestReceipt(receipt)
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
          db.prepare(
            'UPDATE gateway_worker_oauth_sessions SET session_json=NULL WHERE session_json IS NOT NULL AND expires_at<?',
          ).run(new Date(now()).toISOString())
        } catch {}
      }
      if (now() - lastReplayAt >= replayIntervalMs) {
        lastReplayAt = now()
        try {
          await replayReceipts()
        } catch {}
      }
      for (const job of repo.dueReconciliation(25)) {
        const leaseUntil = new Date(Date.now() + 30_000).toISOString()
        if (!repo.leaseReconciliation(job.id, leaseUntil)) continue
        try {
          const receipt = db
            .prepare('SELECT * FROM gateway_worker_receipts WHERE gateway_instance_id=? AND dispatch_id=?')
            .get(job.gateway_instance_id, job.dispatch_id)
          const usage = receipt?.usage_json
            ? JSON.parse(receipt.usage_json)
            : job.usage_json
              ? JSON.parse(job.usage_json)
              : null
          const confidence = receipt?.usage_confidence || 'unknown'
          if (receipt)
            repo.applyReceiptToUsage(
              receipt,
              repo.findAccountByRuntime(receipt.gateway_instance_id, receipt.runtime_account_id),
            )
          // BPS 中断流按已消耗用量下限结算（对齐 sub2api）：Worker 回执带转换累计的 partial 用量时，
          // 截断或调用方中途断开的 BPS 请求仍按这部分用量计费；原生与 VM 路径保持不计量
          const bpsLowerBound =
            BPS_LOWER_BOUND_STATES.has(receipt?.terminal_state) &&
            receipt?.usage_confidence === 'partial' &&
            usage &&
            db
              .prepare(
                "SELECT 1 FROM usage_logs WHERE execution_kind='gateway_worker' AND dispatch_id=? AND authorization_mode='bps' LIMIT 1",
              )
              .get(job.dispatch_id)
          // Worker 已确认请求失败、截断或取消：与 VM 路径一样不计量，不等待用量也不进 dead letter
          if (UNSETTLED_TERMINAL_STATES.has(receipt?.terminal_state) && !bpsLowerBound) {
            repo.finishReconciliation(job.id, 'unmetered', { error: 'request_not_completed' })
            db.prepare(
              "UPDATE usage_logs SET billing_status='unmetered' WHERE execution_kind='gateway_worker' AND dispatch_id=? AND billing_status='settlement_pending'",
            ).run(job.dispatch_id)
            continue
          }
          const context = job.context_json ? JSON.parse(job.context_json) : null
          // 只有实时日志判定待结算时才带计费上下文；没有上下文说明实时日志已结算或不计量，
          // 上下文随后到达会重新打开任务
          if (!context) {
            repo.finishReconciliation(job.id, 'unmetered', { error: 'billing_context_missing' })
            continue
          }
          if (!usage || (confidence !== 'complete' && !bpsLowerBound)) {
            if (Number(job.attempts || 0) >= 10) {
              repo.finishReconciliation(job.id, 'unmetered', { error: 'usage_evidence_incomplete' })
              writeDeadLetter(repo, job, 'usage_evidence_incomplete')
            } else
              repo.finishReconciliation(job.id, 'pending', {
                error: 'usage_evidence_incomplete',
                retryAt: new Date(Date.now() + Math.min(300_000, 2 ** Number(job.attempts || 1) * 1000)).toISOString(),
              })
            continue
          }
          const billing = new RelayBilling(db)
          const model = job.model || receipt?.upstream_model || null
          const apiRecord =
            context.api_key_id && apiKeyStore?.repo?.getById ? apiKeyStore.repo.getById(context.api_key_id) : null
          const settled = billing.settle(context, usage, model, (rate, actualCost, officialCost) => {
            if (apiRecord && apiKeyStore?.recordUsage)
              apiKeyStore.recordUsage(apiRecord, usage, { model, rateMultiplier: rate, actualCost, officialCost })
          })
          db.prepare(
            "UPDATE usage_logs SET billing_status=?,actual_cost=COALESCE(?,actual_cost),receipt_id=COALESCE(?,receipt_id),usage_confidence=? WHERE execution_kind='gateway_worker' AND dispatch_id=?",
          ).run(
            settled?.status || 'settled',
            settled?.actual_micros == null ? null : settled.actual_micros / 1e6,
            receipt?.receipt_id || null,
            bpsLowerBound ? 'partial' : 'complete',
            job.dispatch_id,
          )
          if (receipt?.receipt_id)
            db.prepare('UPDATE billing_charges SET gateway_receipt_id=?,settlement_source=? WHERE request_id=?').run(
              receipt.receipt_id,
              'gateway_worker_receipt',
              job.request_id,
            )
          repo.finishReconciliation(job.id, settled?.status === 'unmetered' ? 'unmetered' : 'settled')
        } catch (error) {
          const attempts = Number(job.attempts || 0)
          if (attempts >= 10) {
            const message = String(error?.message || error)
            repo.finishReconciliation(job.id, 'dead_letter', { error: message })
            writeDeadLetter(repo, job, message)
          } else
            repo.finishReconciliation(job.id, 'pending', {
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
      timer = setInterval(() => void tick(), intervalMs)
      timer.unref?.()
      void tick()
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

function writeDeadLetter(repo, job, message) {
  try {
    repo.db
      .prepare(
        `INSERT INTO gateway_worker_dead_letters(id,kind,reference_id,payload_json,error_code,error_message,attempts,created_at)
       VALUES(?,?,?,?,?,?,?,?)`,
      )
      .run(
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
