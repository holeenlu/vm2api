/**
 * 计费在途记录与崩溃补结算（审计阶段 1 W2：P1-B1、P1-B3、P2-5）。
 *
 * - 准入（RelayBilling.authorize）通过后写 billing_inflight，收口（commitRelayLog）在同一事务里删除。
 * - 余额低于 `relay_billing.low_balance_micros`（默认 1 美元）时，同一钱包在本进程里最多
 *   `relay_billing.low_balance_max_inflight`（默认 1）个在途请求：低余额时的并发是透支的来源，
 *   限制它即可把透支压到约一个请求的费用，不需要按 max_tokens 预占额度（用户 2026-11-07 决定）。
 * - 扫描（启动时与每 5 分钟）：其他进程留下的、或本进程超过 6 小时的在途行——
 *   已有结算或使用记录的直接删除；带 Gateway dispatch 的补入对账队列并写一条 settlement_pending 使用记录，
 *   回执到达后照常结算；其余写一条 billing_status='interrupted' 的使用记录（不扣费、可见），再删除在途行。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import { GatewayWorkerRepo } from '../gateway-worker/gateway-repo.mjs'
import { dbClient } from '../db/db-client.mjs'
import {
  countWalletInflight,
  deleteInflight,
  inflightSettled,
  insertInflight,
  listOrphanInflight,
  noteInflightDispatch,
} from './repos/billing-inflight-repo.mjs'

/** 本进程的启动标识：扫描据此区分“上一个进程留下的”在途行。 */
export const BOOT_ID = crypto.randomUUID()

export const RELAY_BILLING_DEFAULTS = Object.freeze({ low_balance_micros: 1_000_000, low_balance_max_inflight: 1 })
const STALE_SAME_BOOT_MS = 6 * 3600_000
const SWEEP_INTERVAL_MS = 5 * 60_000

/** routing.json 的 `relay_billing`：低余额阈值（整数微单位，0 关闭）与低余额时每钱包在途上限（≥1）。 */
export function normalizeRelayBillingPolicy(raw = {}) {
  const micros = Number(raw?.low_balance_micros)
  const inflight = Number(raw?.low_balance_max_inflight)
  return {
    low_balance_micros:
      Number.isSafeInteger(micros) && micros >= 0 ? micros : RELAY_BILLING_DEFAULTS.low_balance_micros,
    low_balance_max_inflight:
      Number.isInteger(inflight) && inflight >= 1 && inflight <= 1000
        ? inflight
        : RELAY_BILLING_DEFAULTS.low_balance_max_inflight,
  }
}

export function walletKeyOf(wallet, userId) {
  return wallet?.domainId ? `domain:${wallet.domainId}` : `user:${userId}`
}

export async function recordInflight(db, context, { walletKey, model, now = Date.now() } = {}) {
  await insertInflight(db, {
    request_id: context.request_id,
    boot_id: BOOT_ID,
    wallet_key: walletKey,
    user_id: context.user_id,
    api_key_id: context.api_key_id,
    group_id: context.group_id,
    model,
    context_json: JSON.stringify(context),
    started_at: new Date(now).toISOString(),
  })
}

export async function walletInflight(db, walletKey) {
  return countWalletInflight(db, walletKey, BOOT_ID)
}

export async function releaseInflight(db, requestId) {
  if (!requestId) return false
  return deleteInflight(db, requestId)
}

/** Gateway 分发后记下实例与 dispatch：进程中断时据此补入对账队列，回执到达后照常结算。 */
export async function markInflightDispatch(db, requestId, instanceId, dispatchId) {
  if (!requestId || !dispatchId) return
  try {
    await noteInflightDispatch(db, requestId, instanceId, dispatchId)
  } catch {}
}

function interruptedSummary(row, billingStatus) {
  const context = JSON.parse(row.context_json || '{}')
  return {
    id: row.request_id,
    request_id: row.request_id,
    created_at: row.started_at,
    ts: row.started_at,
    user_id: row.user_id,
    api_key_id: row.api_key_id,
    group_id: context.group_id ?? null,
    billing_group_id: context.group_id ?? null,
    rate_multiplier: context.rate_multiplier ?? null,
    model: row.model,
    upstream_model: row.model,
    status: 0,
    final_state: 'interrupted',
    error_code: 'process_interrupted',
    error_message: 'control plane stopped before the request was settled',
    billing_status: billingStatus,
    source: 'protocol',
  }
}

/**
 * 扫描孤儿在途行并补结算。deps：usageLogs（UsageLogsRepo），pendingFile（待补写文件，里面的请求留给
 * `scripts/replay-pending-commits.mjs` 补写，不在这里记 interrupted）。返回 { settled, reconciled, interrupted, deferred }。
 * 每行在一个事务里处理，失败的行留到下次。
 */
export async function sweepInflight(db, { usageLogs, pendingFile = null, now = Date.now(), log = console } = {}) {
  const report = { settled: 0, reconciled: 0, interrupted: 0, deferred: 0 }
  const rows = await listOrphanInflight(db, BOOT_ID, new Date(now - STALE_SAME_BOOT_MS).toISOString())
  const waiting = rows.length ? pendingCommitIds(pendingFile) : new Set()
  for (const row of rows) {
    if (waiting.has(row.request_id)) {
      report.deferred++
      continue
    }
    try {
      await dbClient(db).tx(async () => {
        const done = await inflightSettled(db, row.request_id)
        if (done.charged || done.logged) {
          report.settled++
        } else if (row.dispatch_id && row.gateway_instance_id) {
          const context = JSON.parse(row.context_json || '{}')
          await new GatewayWorkerRepo(db).enqueueReconciliation({
            gatewayInstanceId: row.gateway_instance_id,
            dispatchId: row.dispatch_id,
            requestId: row.request_id,
            model: row.model,
            context,
            usage: null,
          })
          await usageLogs.insertSummaryIfAbsent({
            ...interruptedSummary(row, 'settlement_pending'),
            execution_kind: 'gateway_worker',
            via: 'gateway-worker',
            gateway_instance_id: row.gateway_instance_id,
            dispatch_id: row.dispatch_id,
            final_state: 'ambiguous',
          })
          report.reconciled++
        } else {
          await usageLogs.insertSummaryIfAbsent(interruptedSummary(row, 'interrupted'))
          report.interrupted++
        }
        await deleteInflight(db, row.request_id)
      })
    } catch (error) {
      log?.warn?.(`[billing] in-flight sweep for ${row.request_id} failed: ${error?.message || error}`)
    }
  }
  if (report.interrupted || report.reconciled)
    log?.warn?.(
      `[billing] ${report.interrupted} interrupted requests recorded without charge, ${report.reconciled} handed to Gateway reconciliation`,
    )
  return report
}

/** 待补写文件（commit-retry 停机落盘）里的 request_id；读不出时为空集。 */
export function pendingCommitIds(file) {
  const ids = new Set()
  if (!file) return ids
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return ids
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const id = JSON.parse(line)?.entry?.request_id
      if (id) ids.add(String(id))
    } catch {}
  }
  return ids
}

let sweepTimer = null

/** 启动扫描并每 5 分钟再扫一次（只启动一次；进程退出不等它）。 */
export function startInflightSweeper(db, { usageLogs, pendingFile = null, log = console } = {}) {
  if (sweepTimer || !db || !usageLogs) return
  const run = () => void sweepInflight(db, { usageLogs, pendingFile, log }).catch(() => {})
  setImmediate(run)
  sweepTimer = setInterval(run, SWEEP_INTERVAL_MS)
  sweepTimer.unref?.()
}

/** 测试用。 */
export function stopInflightSweeper() {
  if (sweepTimer) clearInterval(sweepTimer)
  sweepTimer = null
}
