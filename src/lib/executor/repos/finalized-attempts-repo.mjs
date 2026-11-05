/**
 * 按 request.finalized 补齐请求尝试时，上游 request-attempts-repo 之外需要的读写（usage_logs 存在性、占位行删除、补字段）。
 * 只做数据访问；补齐规则在 result-writer.mjs，事务与保存点由调用方持有。
 */
import { statementCache } from './statement-cache.mjs'

export function hasUsageLog(db, requestId) {
  return !!statementCache(db)('SELECT 1 FROM usage_logs WHERE request_id=? LIMIT 1').get(requestId)
}

export function deleteAttempt(db, requestId, attemptNo) {
  statementCache(db)('DELETE FROM request_attempts WHERE request_id=? AND attempt_no=?').run(requestId, attemptNo)
}

/** 只补空字段；返回更新行数 */
export function annotateAttempt(db, requestId, attempt) {
  return Number(
    statementCache(db)(
      `UPDATE request_attempts SET route=COALESCE(route,?),stage=COALESCE(stage,?),credential_revision=COALESCE(credential_revision,?),
       latency_ms=COALESCE(latency_ms,?),upstream_request_id=COALESCE(upstream_request_id,?),cf_ray=COALESCE(cf_ray,?)
     WHERE request_id=? AND attempt_no=?`,
    ).run(
      attempt.route,
      attempt.stage,
      attempt.credentialRevision,
      attempt.latencyMs,
      attempt.upstreamRequestId,
      attempt.cfRay,
      requestId,
      attempt.attemptNo,
    ).changes || 0,
  )
}
