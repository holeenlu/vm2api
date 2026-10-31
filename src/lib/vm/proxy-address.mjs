import {
  normalizeSocksHost as normalizeProxyHost,
  socksEndpoint as proxyEndpoint,
  socksProxyFamily as proxyFamily,
} from './socks-address.mjs'

export { normalizeProxyHost, proxyEndpoint, proxyFamily }

export const PROXY_PROTOCOLS = Object.freeze(['http', 'socks5', 'https', 'socks5h'])
export function proxyDefaultPort(protocol) {
  return protocol === 'http' ? 80 : protocol === 'https' ? 443 : 1080
}

/** Preserve the selected transport and DNS mode. Never silently turn HTTP into SOCKS. */
export function proxyUrl(proxy) {
  if (!proxy) return ''
  const u = proxy.url ? new URL(proxy.url) : null
  const scheme = String(u ? u.protocol.slice(0, -1) : proxy.scheme || proxy.protocol || 'socks5').toLowerCase()
  if (!PROXY_PROTOCOLS.includes(scheme)) throw new Error('unsupported proxy protocol')
  const endpoint = proxyEndpoint(u ? u.hostname : proxy.host, u ? u.port || proxyDefaultPort(scheme) : proxy.port)
  if (!endpoint || (u && ((u.pathname && u.pathname !== '/') || u.search || u.hash)))
    throw new Error('invalid proxy URL')
  const auth = u
    ? u.username || u.password
      ? `${u.username}:${u.password}@`
      : ''
    : proxy.username
      ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password || '')}@`
      : ''
  return `${scheme}://${auth}${endpoint}`
}

export function proxyEndpointOf(proxy) {
  if (proxy?.host && proxy?.port) return proxyEndpoint(proxy.host, proxy.port) || null
  if (!proxy?.url) return null
  try {
    const u = new URL(proxy.url)
    return proxyEndpoint(u.hostname, u.port || proxyDefaultPort(u.protocol.slice(0, -1))) || null
  } catch {
    return null
  }
}
