/** Group usage is attributed at request time, not by the key's current group. */
export function groupUsage(db, userId = null, now = new Date()) {
  const day = (date) => new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 10)
  const today = day(now),
    yesterday = day(new Date(now.getTime() - 86400000))
  return new Map(
    db
      .prepare(`SELECT billing_group_id AS group_id,
    COALESCE(SUM(CASE WHEN date(created_at,'+8 hours')=? THEN actual_cost ELSE 0 END),0) today_cost,
    COALESCE(SUM(CASE WHEN date(created_at,'+8 hours')=? THEN actual_cost ELSE 0 END),0) yesterday_cost,
    COALESCE(SUM(actual_cost),0) total_cost, COUNT(*) requests
    FROM usage_logs WHERE billing_group_id IS NOT NULL AND billing_status='settled'
    ${userId ? 'AND user_id=?' : ''} GROUP BY billing_group_id`)
      .all(today, yesterday, ...(userId ? [userId] : []))
      .map((r) => [r.group_id, { ...r, timezone: 'Asia/Shanghai' }]),
  )
}

export function groupCapacity(resources, vms, seats = {}) {
  const ids = new Set(resources.filter((r) => r.resource_kind === 'vm').map((r) => r.resource_id))
  const members = vms.filter((v) => ids.has(v.id))
  return {
    kind: resources.some((r) => r.resource_kind === 'api_endpoint') ? 'api' : 'vm',
    used: members.reduce((n, vm) => n + (seats[vm.id]?.inflight || 0), 0),
    limit: members.reduce(
      (n, vm) => n + (vm.schedulable && vm.status === 'running' && vm.has_token ? Number(vm.max_concurrency || 0) : 0),
      0,
    ),
    resources: resources.length,
  }
}
