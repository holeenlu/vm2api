// 分组用量指标的仓储：SQL 原样自 group-metrics.mjs 迁入，调用方注入数据库句柄。

export function settledGroupUsageRows(db, today, yesterday, userId = null) {
  return db
    .prepare(`SELECT billing_group_id AS group_id,
    COALESCE(SUM(CASE WHEN date(created_at,'+8 hours')=? THEN actual_cost ELSE 0 END),0) today_cost,
    COALESCE(SUM(CASE WHEN date(created_at,'+8 hours')=? THEN actual_cost ELSE 0 END),0) yesterday_cost,
    COALESCE(SUM(actual_cost),0) total_cost, COUNT(*) requests
    FROM usage_logs WHERE billing_group_id IS NOT NULL AND billing_status='settled'
    ${userId ? 'AND user_id=?' : ''} GROUP BY billing_group_id`)
    .all(today, yesterday, ...(userId ? [userId] : []))
}
