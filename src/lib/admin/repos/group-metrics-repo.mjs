// 分组用量指标的仓储：SQL 原样自 group-metrics.mjs 迁入，调用方注入数据库句柄。
import { dbClient } from '../../db/db-client.mjs'
import { moneySql, usdSumSql } from '../../db/repos/money-sql.mjs'

const ACTUAL = moneySql('actual_cost')

export function settledGroupUsageRows(db, today, yesterday, userId = null) {
  return dbClient(db).many(
    `SELECT billing_group_id AS group_id,
    COALESCE(SUM(CASE WHEN date(created_at,'+8 hours')=? THEN ${ACTUAL} ELSE 0 END),0) / 1000000.0 today_cost,
    COALESCE(SUM(CASE WHEN date(created_at,'+8 hours')=? THEN ${ACTUAL} ELSE 0 END),0) / 1000000.0 yesterday_cost,
    ${usdSumSql('actual_cost')} total_cost, COUNT(*) requests
    FROM usage_logs WHERE billing_group_id IS NOT NULL AND billing_status='settled'
    ${userId ? 'AND user_id=?' : ''} GROUP BY billing_group_id`,
    today,
    yesterday,
    ...(userId ? [userId] : []),
  )
}
