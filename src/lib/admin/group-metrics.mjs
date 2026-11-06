import { settledGroupUsageRows } from './repos/group-metrics-repo.mjs'

/** Group usage is attributed at request time, not by the key's current group. */
export async function groupUsage(db, userId = null, now = new Date()) {
  const day = (date) => new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 10)
  const today = day(now),
    yesterday = day(new Date(now.getTime() - 86400000))
  return new Map(
    (await settledGroupUsageRows(db, today, yesterday, userId)).map((r) => [
      r.group_id,
      { ...r, timezone: 'Asia/Shanghai' },
    ]),
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
