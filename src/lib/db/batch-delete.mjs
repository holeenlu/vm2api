/**
 * 保留期清理的分批删除（审计阶段 1 W5）。
 *
 * 主线程上的单连接 SQLite 一条 DELETE 同步执行到底：一次删几十万行会把事件循环卡住数秒，WAL 也一次涨到同样大小。
 * 这里每批最多删 DELETE_BATCH_SIZE 行（与 jev-usage-repo 的 `LIMIT 500` 同一写法），批与批之间 setImmediate
 * 让出事件循环，请求的 I/O 回调可以插进来。每批是独立的自动提交语句或一个 DbClient 事务，不跨批持有事务
 * （DbClient 事务跨事件循环会被回滚，见 db-client.mjs）。
 */
export const DELETE_BATCH_SIZE = 500

export function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve))
}

/**
 * 反复执行 `step(batchSize)`（返回本批删除的行数），批间让出事件循环，返回删除总数。
 * - 默认按“本批不满一批”结束：适合按时间索引取最旧的待删行（`WHERE ts < ? LIMIT n`），取不满就是删完了。
 * - `untilEmpty`：按“本批一行没删”结束。适合按 rowid 取表头 n 行再按时间过滤的写法（表头夹着不能删的行时，
 *   本批可能不满一批但后面仍有可删行）。
 */
export async function deleteInBatches(step, { batchSize = DELETE_BATCH_SIZE, untilEmpty = false } = {}) {
  let total = 0
  for (;;) {
    const deleted = Number((await step(batchSize)) || 0)
    total += deleted
    if (deleted === 0 || (!untilEmpty && deleted < batchSize)) return total
    await yieldToEventLoop()
  }
}
