// 供应商账号门户视图的仓储：SQL 原样自 vendor-portal-view.mjs 迁入，调用方注入数据库句柄。
const placeholders = (ids) => ids.map(() => '?').join(',')

export function linkedVmConfig(db, vmResourceId, vendorId) {
  return db
    .prepare("SELECT config_json FROM vendor_resources WHERE id=? AND vendor_id=? AND resource_type='vm'")
    .get(vmResourceId, vendorId)
}

/** 按账号资源排序，已同步实例的最新绑定在前。 */
export function gatewayBindingRows(db, ids) {
  const marks = placeholders(ids)
  return db
    .prepare(`SELECT * FROM gateway_worker_account_bindings WHERE account_resource_id IN (${marks})
      ORDER BY account_resource_id, projection_status='synced' DESC, updated_at DESC`)
    .all(...ids)
}

export function gatewayFreezeRows(db, ids) {
  const marks = placeholders(ids)
  return db
    .prepare(`SELECT account_resource_id, MAX(frozen_until) AS until FROM gateway_account_freezes
      WHERE account_resource_id IN (${marks}) GROUP BY account_resource_id`)
    .all(...ids)
}

/** 在线实例（healthy / degraded）心跳上报的在途数合计。 */
export function gatewayInflightRows(db, ids) {
  const marks = placeholders(ids)
  return db
    .prepare(`SELECT b.account_resource_id, SUM(b.inflight) AS n FROM gateway_worker_account_bindings b
      JOIN gateway_worker_instances i ON i.id=b.gateway_instance_id
      WHERE b.account_resource_id IN (${marks}) AND i.health_state IN ('healthy','degraded') GROUP BY b.account_resource_id`)
    .all(...ids)
}

export function vmRequestRateRows(db, ids, minute, stamp) {
  return db
    .prepare(`
      SELECT vm_id,
        SUM(CASE WHEN created_at>=? THEN 1 ELSE 0 END) AS rpm,
        SUM(CASE WHEN created_at>=? THEN COALESCE(input_tokens,0)+COALESCE(output_tokens,0) ELSE 0 END) AS tpm,
        SUM(CASE WHEN created_at>=? THEN COALESCE(input_tokens,0)+COALESCE(output_tokens,0)+COALESCE(cache_read_tokens,0)+COALESCE(cache_creation_tokens,0) ELSE 0 END) AS tpm_with_cache
      FROM usage_logs WHERE vm_id IN (${ids.map(() => '?').join(',')}) AND created_at<=? GROUP BY vm_id
    `)
    .all(minute, minute, minute, ...ids, stamp)
}

export function vendorProxyResource(db, proxyId, vendorId) {
  return db
    .prepare("SELECT id,name,config_json FROM vendor_resources WHERE id=? AND vendor_id=? AND resource_type='proxy'")
    .get(proxyId, vendorId)
}

export function resourceGroupRows(db, resourceKind, resourceId) {
  return db
    .prepare(`SELECT g.id,g.name,g.platform FROM group_resources r JOIN groups g ON g.id=r.group_id
      WHERE r.resource_kind=? AND r.resource_id=? AND g.deleted_at IS NULL ORDER BY g.sort_order,g.id`)
    .all(resourceKind, resourceId)
}
