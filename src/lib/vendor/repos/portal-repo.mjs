// 供应商账号门户视图的仓储：SQL 原样自 vendor-portal-view.mjs 迁入，调用方注入数据库句柄；经 DbClient 异步访问（R6 B4）。
import { dbClient } from '../../db/db-client.mjs'
import { UPSTREAM_TOTAL_TOKENS_SQL, upstreamTokenSql } from '../../db/repos/usage-log-preds.mjs'
const placeholders = (ids) => ids.map(() => '?').join(',')

export async function linkedVmConfig(db, vmResourceId, vendorId) {
  return dbClient(db).one(
    "SELECT config_json FROM vendor_resources WHERE id=? AND vendor_id=? AND resource_type='vm' AND deleted_at IS NULL",
    vmResourceId,
    vendorId,
  )
}

/** 按账号资源排序，已同步实例的最新绑定在前。 */
export async function gatewayBindingRows(db, ids) {
  const marks = placeholders(ids)
  return dbClient(db).many(
    `SELECT * FROM gateway_worker_account_bindings WHERE account_resource_id IN (${marks})
      ORDER BY account_resource_id, projection_status='synced' DESC, updated_at DESC`,
    ...ids,
  )
}

export async function gatewayFreezeRows(db, ids) {
  const marks = placeholders(ids)
  return dbClient(db).many(
    `SELECT account_resource_id, MAX(frozen_until) AS until FROM gateway_account_freezes
      WHERE account_resource_id IN (${marks}) GROUP BY account_resource_id`,
    ...ids,
  )
}

/** 接单中的实例心跳上报的在途数（迁移 130 起绑定不记实例；没有在线实例时为 0）。 */
export async function gatewayInflightRows(db, ids) {
  const marks = placeholders(ids)
  return dbClient(db).many(
    `SELECT b.account_resource_id, b.inflight AS n FROM gateway_worker_account_bindings b
      WHERE b.account_resource_id IN (${marks})
        AND EXISTS (SELECT 1 FROM gateway_worker_instances i WHERE i.health_state IN ('healthy','degraded'))`,
    ...ids,
  )
}

export async function vmRequestRateRows(db, ids, minute, stamp) {
  return dbClient(db).many(
    `
      SELECT vm_id,
        SUM(CASE WHEN created_at>=? THEN 1 ELSE 0 END) AS rpm,
        SUM(CASE WHEN created_at>=? THEN COALESCE(${upstreamTokenSql('input_tokens')},0)+COALESCE(output_tokens,0) ELSE 0 END) AS tpm,
        SUM(CASE WHEN created_at>=? THEN ${UPSTREAM_TOTAL_TOKENS_SQL} ELSE 0 END) AS tpm_with_cache
      FROM usage_logs WHERE vm_id IN (${ids.map(() => '?').join(',')}) AND created_at<=? GROUP BY vm_id
    `,
    minute,
    minute,
    minute,
    ...ids,
    stamp,
  )
}

export async function vendorProxyResource(db, proxyId, vendorId) {
  return dbClient(db).one(
    "SELECT id,name,config_json FROM vendor_resources WHERE id=? AND vendor_id=? AND resource_type='proxy'",
    proxyId,
    vendorId,
  )
}

export async function resourceGroupRows(db, resourceKind, resourceId) {
  return dbClient(db).many(
    `SELECT g.id,g.name,g.platform FROM group_resources r JOIN groups g ON g.id=r.group_id
      WHERE r.resource_kind=? AND r.resource_id=? AND g.deleted_at IS NULL ORDER BY g.sort_order,g.id`,
    resourceKind,
    resourceId,
  )
}
