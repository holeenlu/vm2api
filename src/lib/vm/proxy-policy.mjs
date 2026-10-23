import { getDb, isDbOpen } from '../db/database.mjs'
import { SettingsRepo } from '../db/repos/settings-repo.mjs'
import { proxyFamily } from './proxy-address.mjs'

export function configuredIpv6Enabled() {
  return isDbOpen() && new SettingsRepo(getDb()).get('proxy_pool_config')?.ipv6_enabled === true
}

export function proxyBlockedReason(proxy, ipv6Enabled = configuredIpv6Enabled()) {
  if (proxy?.expires_at && Date.parse(proxy.expires_at) <= Date.now()) return 'proxy_expired'
  return ipv6Enabled !== true && proxyFamily(proxy) === 6 ? 'ipv6_disabled' : null
}

export function assertProxyAllowed(proxy) {
  const reason = proxyBlockedReason(proxy)
  if (reason)
    throw Object.assign(
      new Error(reason === 'proxy_expired' ? '代理已到期' : 'IPv6 已关闭，请在设置 → SOCKS5 开启 IPv6 代理出口'),
      { code: reason, status: 409 },
    )
}
