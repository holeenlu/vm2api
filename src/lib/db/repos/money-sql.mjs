/**
 * 金额列的 SQL 片段（技术债 M6）。整数列 `<name>_micros` 是权威值；只在它为 NULL 时（上一版本在回滚期间写入、
 * 或尚未改造的上游写入方只写了 REAL 列）按 REAL 派生，与迁移 127 的触发器同一口径。
 * 读取方一律经这里取金额并在整数上求和，出口再换算成美元；不得对 REAL 金额列直接 SUM 或做算术。
 */

/** 一行的金额（整数微单位）；`prefix` 为表别名（如 `u.`）。 */
export function moneySql(column, prefix = '') {
  return `COALESCE(${prefix}${column}_micros, CAST(ROUND(${prefix}${column} * 1000000) AS INTEGER))`
}

/** 整数微单位之和，NULL 按 0。 */
export function microsSumSql(column, prefix = '') {
  return `COALESCE(SUM(${moneySql(column, prefix)}), 0)`
}

/** 整数微单位之和换算成美元（只用于直接返回给调用方的结果，不再参与计算）。 */
export function usdSumSql(column, prefix = '') {
  return `${microsSumSql(column, prefix)} / 1000000.0`
}
