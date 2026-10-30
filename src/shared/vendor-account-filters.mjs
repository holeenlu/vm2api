// Pure account-list contract shared by the HTTP projection and both consoles.
export const EMPTY_ACCOUNT_FILTERS = {
  search: '',
  platform: 'all',
  status: 'all',
  group: 'all',
  method: 'all',
  failure: 'all',
  cooldown: 'all',
  schedulable: 'all',
  archived: 'exclude',
  from: '',
  to: '',
  sort: 'created_desc',
}
export function canReauthorizeAccount(row) {
  return (
    row.status !== 'archived' &&
    (row.telemetry?.requires_authorization === true || ['error', 'unauthorized'].includes(row.telemetry?.state))
  )
}
function dateMillis(value) {
  return typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(value || '')
}
function windowLimited(t, key, now) {
  const value = t?.['utilization_' + key],
    reset = t?.['reset_' + key]
  return value != null && value >= 0.99 && (!reset || dateMillis(reset) > now)
}
export function accountCooldown(row, now = Date.now()) {
  const t = row.telemetry
  return {
    account: dateMillis(t?.cooldown_until) > now || t?.state === 'cooling',
    '5h': windowLimited(t, '5h', now),
    '7d': windowLimited(t, '7d', now),
    fable: t?.has_fable === true && windowLimited(t, 'fable', now),
  }
}
export function filterAccountRows(rows, query = {}, now = Date.now()) {
  const f = { ...EMPTY_ACCOUNT_FILTERS, ...query }
  const search = String(f.search || '')
    .trim()
    .toLowerCase()
  const any = (key) => !f[key] || f[key] === 'all'
  const result = rows.filter((r) => {
    const t = r.telemetry,
      state = t?.state
    const cooldown = accountCooldown(r, now)
    const health =
      ['error', 'unauthorized'].includes(state) || t?.requires_authorization
        ? 'error'
        : ['paused', 'archived'].includes(r.status)
          ? 'paused'
          : state === 'provisioning' || !state
            ? 'provisioning'
            : 'normal'
    const schedulable = t?.schedulable ?? state === 'available'
    return (
      (!search ||
        [r.name, r.id, t?.email, t?.vm_id, r.proxy?.name, r.proxy?.endpoint].some((v) =>
          String(v || '')
            .toLowerCase()
            .includes(search),
        )) &&
      (any('platform') || r.config?.platform === f.platform) &&
      (any('status') || health === f.status || state === f.status) &&
      (any('group') || r.groups?.some((g) => String(g.id) === f.group)) &&
      (any('method') || r.config?.auth_method === f.method) &&
      (any('failure') || t?.failure_category === f.failure) &&
      (any('cooldown') ||
        (f.cooldown === 'available'
          ? !Object.values(cooldown).some(Boolean)
          : f.cooldown === 'cooling'
            ? Object.values(cooldown).some(Boolean)
            : cooldown[f.cooldown] === true)) &&
      (any('schedulable') || (f.schedulable === 'yes' ? schedulable === true : schedulable === false)) &&
      (f.archived === 'all' || (f.archived === 'only' ? r.status === 'archived' : r.status !== 'archived')) &&
      (!f.from || dateMillis(r.created_at) >= dateMillis(f.from + 'T00:00:00+08:00')) &&
      (!f.to || dateMillis(r.created_at) <= dateMillis(f.to + 'T23:59:59.999+08:00'))
    )
  })
  const metrics = { cost: 'total_cost', fable: 'fable_cost', quota: 'utilization_7d' }
  return result.sort((a, b) => {
    const [field, direction] = String(f.sort).split('_'),
      sign = direction === 'asc' ? 1 : -1
    if (field === 'name') return a.name.localeCompare(b.name) * sign || a.id.localeCompare(b.id)
    if (metrics[field]) {
      const av = a.telemetry?.[metrics[field]],
        bv = b.telemetry?.[metrics[field]]
      if (av == null || bv == null) return av == null ? (bv == null ? a.id.localeCompare(b.id) : 1) : -1
      return (av - bv) * sign || a.id.localeCompare(b.id)
    }
    return (dateMillis(a.created_at) - dateMillis(b.created_at)) * sign || a.id.localeCompare(b.id)
  })
}
