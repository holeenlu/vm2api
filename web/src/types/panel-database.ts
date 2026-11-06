export type DatabaseRuntimeMetrics = {
  ok: boolean
  engine: 'sqlite'
  probe_latency_ms: number | null
  journal_mode: string | null
  synchronous: number | null
  foreign_keys: boolean | null
  busy_timeout_ms: number | null
  file_size_bytes: number | null
  wal_size_bytes: number | null
  shm_size_bytes: number | null
  page_size_bytes: number | null
  page_count: number | null
  freelist_pages: number | null
  used_pages: number | null
  used_bytes: number | null
  free_ratio: number | null
  migration_count: number | null
  latest_migration: string | null
  latest_migration_at: string | null
}

export type UsageCacheMetrics = {
  since: string
  entries_total: number
  entries_fresh: number
  entries_stale: number
  inflight: number
  requests: number
  success_hits: number
  error_hits: number
  misses: number
  singleflight_joins: number
  upstream_fetches: number
  upstream_failures: number
  hit_rate: number | null
  reuse_rate: number | null
  success_ttl_ms: number
  error_ttl_ms: number
}

/** 写回队列（`write-behind.mjs`）：深度、上限与进程启动以来的计数。 */
export type WriteBehindMetrics = {
  queued: number
  max_queue: number
  enqueued: number
  /** 队列满时丢弃的观测写入（请求尝试台账等）。 */
  dropped_observation: number
  /** 队列满时改为直接写库的计费写入（使用记录）。 */
  billing_direct: number
  peak: number
}

/** 统计类（路由表 kind=stats）接口的并发上限与超时（`route-budget.mjs`）。 */
export type StatsRouteBudgetMetrics = {
  admitted: number
  rejected_busy: number
  timed_out: number
  running: number
  running_by_route: Record<string, number>
  limits: { route_concurrency: number; concurrency: number; timeout_ms: number }
}

export type DatabaseMetricsPayload = {
  sampled_at: string | null
  database: DatabaseRuntimeMetrics
  usage_cache: UsageCacheMetrics | null
  /** 旧控制面不返回。 */
  write_behind?: WriteBehindMetrics
  route_budget?: StatsRouteBudgetMetrics
}
