import os from 'node:os'
import { ERROR_PRED, TOTAL_TOKENS_SQL } from '../db/repos/usage-log-preds.mjs'
import { enrichLogRow } from './error-class.mjs'
const CLIENT_CODES = [
  'invalid_api_key',
  'missing_api_key',
  'api_key_expired',
  'api_key_disabled',
  'user_disabled',
  'insufficient_balance',
  'subscription_quota_exceeded',
  'user_rate_limit',
  'group_rate_limit',
  'user_concurrency_limit',
  'api_key_concurrency_limit',
  'api_key_rate_limit',
  'api_key_quota_exhausted',
  'model_forbidden',
  'group_forbidden',
  'group_unavailable',
  'group_changed',
  'api_key_required',
  'group_required',
  'ip_not_allowed',
  'invalid_request',
  'invalid_json',
  'client_cancelled',
  'client_aborted',
  'request_cancelled',
  'selection_cancelled',
  'refusal_guard',
  'refusal_similar',
  'refusal_device',
  'policy_blocked',
]
const CLIENT_SQL =
  '(error_code IN (' + CLIENT_CODES.map((v) => "'" + v + "'").join(',') + ") OR final_state='cancelled')"
export function relayOps(db, ctx, vms, now = Date.now()) {
  const since = new Date(now - 3600000).toISOString()
  const failure = '(' + ERROR_PRED + ' AND NOT COALESCE(' + CLIENT_SQL + ',0))'
  const traffic = db
    .prepare(
      'SELECT COUNT(*) requests,COALESCE(SUM(CASE WHEN ' +
        failure +
        ' THEN 1 ELSE 0 END),0) server_errors,COALESCE(SUM(CASE WHEN ' +
        CLIENT_SQL +
        ' THEN 1 ELSE 0 END),0) client_rejections,AVG(first_token_ms) ttft_ms,AVG(duration_ms) duration_ms,COALESCE(SUM(' +
        TOTAL_TOKENS_SQL +
        '),0) tokens FROM usage_logs WHERE created_at>=?',
    )
    .get(since)
  const eligible = traffic.requests - traffic.client_rejections
  traffic.sla = eligible > 0 ? (eligible - traffic.server_errors) / eligible : null
  traffic.rpm = traffic.requests / 60
  const snapshot = ctx.poolScheduler?.snapshot?.() || {}
  const queue = ctx.poolScheduler?.queuedTotal?.() || 0
  const alerts = []
  if (queue) alerts.push({ code: 'queue_waiting', message: queue + ' 个请求等待资源', to: '/vm' })
  if (
    !vms.some((v) => v.status === 'running' && v.schedulable && v.has_token) &&
    !ctx.apiScheduler?.hasReadySupply(now)
  )
    alerts.push({ code: 'no_ready_supply', message: '没有可用供给，请检查凭证、出口与调度状态', to: '/vm' })
  if (traffic.server_errors)
    alerts.push({
      code: 'service_failures',
      message: traffic.server_errors + ' 次服务故障，请按请求 ID 排障',
      to: '/logs',
    })
  return {
    since,
    traffic,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    load: os.loadavg(),
    resources: {
      total: vms.length,
      running: vms.filter((v) => v.status === 'running').length,
      schedulable: vms.filter((v) => v.schedulable).length,
    },
    queues: { waiting: queue, pool: snapshot.pool_queue || null },
    concurrency: {
      keys: Object.fromEntries(ctx.apiKeyStore?.inflight || []),
      users: Object.fromEntries(ctx.apiKeyStore?.userInflight || []),
      accounts: snapshot.inflight || {},
    },
    tasks: { scheduled: ctx.vmTestSchedule?.jobs?.size || 0, running: [...(ctx.vmTestSchedule?.running || [])] },
    alerts,
    timeline: db
      .prepare(
        'SELECT substr(created_at,1,16) minute,COUNT(*) requests,COALESCE(SUM(CASE WHEN ' +
          failure +
          ' THEN 1 ELSE 0 END),0) errors,AVG(first_token_ms) ttft_ms FROM usage_logs WHERE created_at>=? GROUP BY minute ORDER BY minute',
      )
      .all(since),
    errors: db
      .prepare(
        'SELECT request_id,created_at,status,error_code,error_message,vm_id,model,final_state FROM usage_logs WHERE created_at>=? AND ' +
          ERROR_PRED +
          ' ORDER BY created_at DESC LIMIT 50',
      )
      .all(since)
      .map(enrichLogRow),
  }
}
