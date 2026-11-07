/**
 * 按 request.finalized 补齐请求尝试时，上游 request-attempts-repo 之外需要的读写（usage_logs 存在性、占位行删除、补字段）。
 * 只做数据访问；补齐规则在 result-writer.mjs，事务与保存点由调用方持有。经 DbClient 异步访问（R6 B3）。
 */
import { dbClient } from '../../db/db-client.mjs'
import { attemptErrorMessage } from '../../db/repos/request-attempts-repo.mjs'

export async function hasUsageLog(db, requestId) {
  return !!(await dbClient(db).one('SELECT 1 FROM usage_logs WHERE request_id=? LIMIT 1', requestId))
}

export async function deleteAttempt(db, requestId, attemptNo) {
  await dbClient(db).run('DELETE FROM request_attempts WHERE request_id=? AND attempt_no=?', requestId, attemptNo)
}

/** 只补空字段；返回更新行数 */
export async function annotateAttempt(db, requestId, attempt) {
  const result = await dbClient(db).run(
    `UPDATE request_attempts SET route=COALESCE(route,?),credential_revision=COALESCE(credential_revision,?),
       latency_ms=COALESCE(latency_ms,?),upstream_request_id=COALESCE(upstream_request_id,?),cf_ray=COALESCE(cf_ray,?),
       error_message=COALESCE(error_message,?)
     WHERE request_id=? AND attempt_no=?`,
    attempt.route,
    attempt.credentialRevision,
    attempt.latencyMs,
    attempt.upstreamRequestId,
    attempt.cfRay,
    attemptErrorMessage(attempt.errorMessage),
    requestId,
    attempt.attemptNo,
  )
  return result.changes
}
