import { RelayBilling } from '../admin/relay-billing.mjs'
import { GatewayWorkerRepo } from './gateway-repo.mjs'
import { GatewayWorkerClient } from './gateway-client.mjs'

export function createGatewayWorkerReconciler({
  db,
  apiKeyStore,
  intervalMs = 5000,
  replayIntervalMs = 60_000,
  client = null,
  now = () => Date.now(),
} = {}) {
  const repo = new GatewayWorkerRepo(db)
  const gatewayClient =
    client || new GatewayWorkerClient({ repo, secret: process.env.KIN_CODEX_GATEWAY_INTERNAL_TOKEN || '' })
  let timer = null
  let running = false
  let lastReplayAt = 0

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
          if (!usage || confidence !== 'complete') {
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
          const context = job.context_json ? JSON.parse(job.context_json) : null
          if (!context) {
            repo.finishReconciliation(job.id, 'unmetered', { error: 'billing_context_missing' })
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
            'UPDATE usage_logs SET billing_status=?,actual_cost=COALESCE(?,actual_cost),receipt_id=COALESCE(?,receipt_id),usage_confidence=? WHERE dispatch_id=?',
          ).run(
            settled?.status || 'settled',
            settled?.actual_micros == null ? null : settled.actual_micros / 1e6,
            receipt?.receipt_id || null,
            'complete',
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
