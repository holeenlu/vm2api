/**
 * 按 SQL 文本缓存预编译语句（每个数据库对象一份）。仓储方法反复执行同一条 SQL 时只 prepare 一次。
 */
const caches = new WeakMap()

export function statementCache(db) {
  let cache = caches.get(db)
  if (!cache) {
    cache = new Map()
    caches.set(db, cache)
  }
  return (sql) => {
    let statement = cache.get(sql)
    if (!statement) {
      statement = db.prepare(sql)
      cache.set(sql, statement)
    }
    return statement
  }
}
