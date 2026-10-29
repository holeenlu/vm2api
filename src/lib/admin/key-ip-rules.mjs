import { BlockList, isIP } from 'node:net'
import { relayError } from './relay-common.mjs'

function rule(raw, list) {
  const [address, prefix, extra] = String(raw).trim().split('/')
  const version = isIP(address)
  if (
    !version ||
    extra !== undefined ||
    (prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) > (version === 4 ? 32 : 128)))
  )
    throw relayError('invalid_ip_rule', 'IP 规则必须是有效 IPv4、IPv6 或 CIDR 网段')
  if (prefix === undefined) list.addAddress(address, version === 4 ? 'ipv4' : 'ipv6')
  else list.addSubnet(address, Number(prefix), version === 4 ? 'ipv4' : 'ipv6')
}
export function validateIpRules(input) {
  if (!Array.isArray(input) || input.length > 100 || input.some((v) => typeof v !== 'string'))
    throw relayError('invalid_ip_rules', 'IP 规则必须为最多 100 项的数组')
  const values = [...new Set(input.map((v) => v.trim()))]
  for (const value of values) rule(value, new BlockList())
  return values
}
export function permitsIp(record, remoteAddress) {
  let ip = String(remoteAddress || '').replace(/^::ffff:/i, '')
  const version = isIP(ip)
  const matches = (rules) => {
    const list = new BlockList()
    for (const r of rules) rule(r, list)
    return !!version && list.check(ip, version === 4 ? 'ipv4' : 'ipv6')
  }
  try {
    const allow = JSON.parse(record.ip_whitelist || '[]'),
      deny = JSON.parse(record.ip_blacklist || '[]')
    return !matches(deny) && (!allow.length || matches(allow))
  } catch {
    return false
  }
}
