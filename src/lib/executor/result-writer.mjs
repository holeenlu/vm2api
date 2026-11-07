/**
 * 统一结果写入器（docs/control-plane/DEVELOPMENT_PLAN.md P2.1）。
 *
 * 请求尝试有两个来源：
 *   - 实时：控制面在交付结束时按 Worker 响应头 x-kin-gateway-attempts 写入（recordGatewayAttempts），带控制面视角的终态
 *     （是否已提交下游、调用方是否中途断开）；
 *   - 最终：Worker 的 request.finalized（与回执同一份结果）带完整尝试列表与 Worker 侧字段（通道、阶段、凭据代次、上游请求 ID）。
 * 事件主来源模式下由本写入器以 request.finalized 为准补齐：实时记录缺失时（控制面在交付中途重启等）按事件写入；
 * 只有实时占位行时按事件重写整组；已存在时只补 Worker 侧字段，不覆盖控制面视角的终态与交付事实。
 * 结算仍由回执入库与对账完成（同一份载荷）。调用方须先提交写回队列（flushWrites），避免按缺失重复插入；
 * 本写入器的插入不经写回队列，调用方用事务（每行一个保存点）保证整组原子生效。
 * 口径限制：按事件写入的行，started_at / completed_at 为补齐时刻（比实际晚 60 秒以上）。
 * R6 B3：本模块自己的读写经 DbClient 异步进行；attemptsRepo（record / list）自 R6 B7b 起也经 DbClient，
 * 在调用方的 async 事务里执行。
 */
import { annotateAttempt, deleteAttempt, hasUsageLog } from './repos/finalized-attempts-repo.mjs'

const WORKER_TERMINAL = {
  completed: 'verified',
  upstream_error: 'upstream_error',
  incomplete: 'incomplete',
  cancelled: 'cancelled',
  ambiguous: 'ambiguous',
}

export function attemptsFromFinalized(receipt = {}) {
  const attempts = Array.isArray(receipt.attempts) ? receipt.attempts : []
  const terminal = WORKER_TERMINAL[receipt.terminal_state] || receipt.terminal_state || null
  return attempts.map((item, index) => {
    const last = index === attempts.length - 1
    return {
      attemptNo: index + 1,
      accountId: item?.account || receipt.runtime_account_id || null,
      selectionReason: index ? 'gateway_worker_retry' : 'gateway_worker',
      upstreamStatus: Number(item?.status || (last ? receipt.upstream_status : 0) || 0),
      terminalState: last ? terminal : 'upstream_error',
      action: last ? receipt.error_code || null : item?.category || null,
      // Worker 的 send_state 指“已发往上游”，不能证明已交付调用方；没有控制面视角时按未提交记录（R2 P2-4）
      downstreamCommitted: false,
      usage: last && receipt.usage && typeof receipt.usage === 'object' ? receipt.usage : null,
      latencyMs: Number.isFinite(item?.duration_ms) ? item.duration_ms : null,
      upstreamRequestId: item?.upstream_request_id || null,
      cfRay: item?.cf_ray || null,
      // Worker 尝试恒为原生通道（BPS 通道 2026-11-07 移除）
      route: 'native',
      errorMessage: item?.message ?? null,
      credentialRevision: Number.isSafeInteger(item?.credential_revision) ? item.credential_revision : null,
      // 事件补写的行也带上执行时依据的设置版本（R4 复核新问题 2）
      settingsRevision: Number.isSafeInteger(receipt.settings_revision) ? receipt.settings_revision : null,
    }
  })
}

export const PLACEHOLDER_SELECTION_REASON = 'gateway_worker_observed'

/**
 * 实时占位行：控制面拿不到 Worker 尝试摘要时（例如请求已发出但连接中断）只写一行控制面观察（R2 P1-1），
 * 以 selection_reason 显式标记（R2 复审 N2：迁移 101 之前写入的单尝试行与 VM 路径的行 route 同样为空，不能据此推断）。
 */
function isPlaceholder(rows) {
  return rows.length === 1 && rows[0].selection_reason === PLACEHOLDER_SELECTION_REASON
}

/**
 * 按 request.finalized 补齐请求尝试。返回 { inserted, annotated, replaced }。
 *   - 没有实时记录：按事件写入整组；
 *   - 只有实时占位行：用事件的尝试重写整组，最后一行保留控制面视角的终态与交付事实；
 *   - 已有实时记录：只补 Worker 侧字段（通道、阶段、凭据代次、耗时、上游请求 ID、上游错误原文），缺失的尝试按事件补入。
 */
export async function applyFinalizedAttempts(db, attemptsRepo, receipt = {}) {
  const requestId = String(receipt.request_id || '')
  const attempts = attemptsFromFinalized(receipt)
  const result = { inserted: 0, annotated: 0, replaced: 0 }
  if (!requestId || !attempts.length || !attemptsRepo) return result
  const rows = await attemptsRepo.list(requestId)
  // 只补齐客户端请求（终审 A7）：
  //   - 已有非 Gateway 的尝试行（例如隐私拒绝未发出后回退到 VM）：以实时记录为准，不把 Worker 尝试写到 VM 尝试上；
  //   - 没有任何实时行且没有使用记录（账号测试对话等不经实时写入的分发）：不凭空生成尝试行
  if (rows.some((row) => !String(row.selection_reason || '').startsWith('gateway_worker')))
    return { ...result, skipped: 'vm_attempts' }
  if (!rows.length && !(await hasUsageLog(db, requestId))) return { ...result, skipped: 'not_client' }
  const insert = async (attempt) => {
    // 直接写入，不经写回队列：与删除占位行、标记补齐状态在同一事务内生效（R2 复审 N3）
    await attemptsRepo.record({
      requestId,
      vmId: null,
      model: receipt.upstream_model || null,
      ...attempt,
      immediate: true,
    })
    result.inserted++
  }
  if (isPlaceholder(rows)) {
    const [placeholder] = rows
    await deleteAttempt(db, requestId, placeholder.attempt_no)
    result.replaced = 1
    for (const [index, attempt] of attempts.entries()) {
      const last = index === attempts.length - 1
      await insert(
        last
          ? {
              ...attempt,
              terminalState: placeholder.terminal_state ?? attempt.terminalState,
              downstreamCommitted: !!placeholder.downstream_committed,
              action: placeholder.action ?? attempt.action,
              settingsRevision: placeholder.settings_revision ?? attempt.settingsRevision,
            }
          : attempt,
      )
    }
    return result
  }
  const existing = new Map(rows.map((row) => [row.attempt_no, row]))
  for (const attempt of attempts) {
    const row = existing.get(attempt.attemptNo)
    if (!row) {
      await insert(attempt)
      continue
    }
    // 字段已齐全时不写（R2 P2-2）
    if (
      row.route != null &&
      row.credential_revision != null &&
      row.latency_ms != null &&
      (row.error_message != null || !attempt.errorMessage)
    )
      continue
    result.annotated += await annotateAttempt(db, requestId, attempt)
  }
  return result
}
