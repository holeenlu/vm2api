/** Key 级 CPR 互联共享开关（api_keys.peer_sharing）；缺省全部关闭。 */
export function normalizePeerSharing(raw) {
  let source = raw
  if (typeof source === 'string') {
    try {
      source = JSON.parse(source || '{}')
    } catch {
      source = {}
    }
  }
  source = source && typeof source === 'object' ? source : {}
  const flag = (snake, camel) => source[snake] === true || source[camel] === true
  return {
    enabled: flag('enabled', 'enabled'),
    share_pool: flag('share_pool', 'sharePool'),
    share_plans: flag('share_plans', 'sharePlans'),
    share_quota: flag('share_quota', 'shareQuota'),
  }
}
