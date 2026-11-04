import { SettingsRepo } from '../db/repos/settings-repo.mjs'
import { getDb } from '../db/database.mjs'

// 请求位置（对齐 codex-proxy-rs account/location.rs）：全局设置开启时随信封下发；代理可手动设置位置或
// 跟随代理池探测到的出口位置，账号经该代理出站时以代理位置为准（投影到 Worker 账号）。
// Worker 只改写官方环境/时间上下文的 <timezone> 与 web_search 的 user_location。
export const REQUEST_LOCATION_SETTING = 'codex_request_location'
export const DEFAULT_REQUEST_LOCATION = Object.freeze({
  country: 'US',
  region: 'Ohio',
  city: 'Piketon',
  timezone: 'America/New_York',
})
export const PROXY_LOCATION_MODES = Object.freeze(['inherit', 'manual', 'auto'])

function invalid(message) {
  return Object.assign(new TypeError(message), { code: 'invalid_request_location' })
}

export function validIanaTimezone(value) {
  if (typeof value !== 'string' || !value || value.length > 64 || /^(local|utc[+-])/i.test(value)) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return value.includes('/') || value === 'UTC'
  } catch {
    return false
  }
}

function locationText(value) {
  // 先检查原始输入，避免 trim 掩盖首尾的换行和其他控制字符
  if (typeof value !== 'string' || /\p{Cc}/u.test(value)) return false
  const trimmed = value.trim()
  return trimmed.length > 0 && [...trimmed].length <= 128
}

/** 校验并规范化（地区、城市去首尾空白）；非法时抛出 code=invalid_request_location。 */
export function normalizeRequestLocation(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid('请求位置必须是对象')
  for (const key of Object.keys(raw)) {
    if (!['country', 'region', 'city', 'timezone'].includes(key)) throw invalid(`未知的请求位置字段 ${key}`)
  }
  if (typeof raw.country !== 'string' || !/^[A-Z]{2}$/.test(raw.country)) throw invalid('国家应为两位大写字母代码')
  if (!locationText(raw.region)) throw invalid('地区应为 1～128 个字符且不含控制字符')
  if (!locationText(raw.city)) throw invalid('城市应为 1～128 个字符且不含控制字符')
  if (!validIanaTimezone(raw.timezone)) throw invalid('时区应为 IANA 名称，例如 America/New_York')
  return { country: raw.country, region: raw.region.trim(), city: raw.city.trim(), timezone: raw.timezone }
}

/** 全局设置：{ enabled, location }；无效或缺失时回退关闭与默认位置。 */
export function readRequestLocationSetting(db = null) {
  try {
    const raw = new SettingsRepo(db || getDb()).get(REQUEST_LOCATION_SETTING, null)
    if (!raw) return { enabled: false, location: { ...DEFAULT_REQUEST_LOCATION } }
    return {
      enabled: raw.enabled === true,
      location: normalizeRequestLocation(raw.location || DEFAULT_REQUEST_LOCATION),
    }
  } catch {
    return { enabled: false, location: { ...DEFAULT_REQUEST_LOCATION } }
  }
}

/** 随信封下发的全局位置；关闭时为 null，保留客户端原有字段。 */
export function globalRequestLocation(db = null) {
  const setting = readRequestLocationSetting(db)
  return setting.enabled ? setting.location : null
}

function detectedLocation(country, region, city, timezone) {
  try {
    return normalizeRequestLocation({ country, region, city, timezone })
  } catch {
    return null
  }
}

/**
 * 代理的有效位置：manual 用手动字段；auto 用代理池探测的出口（IPv4 与 IPv6 时区冲突时撤销）；
 * inherit 或信息不完整时为 null（账号回退全局位置）。
 */
export function proxyRequestLocation(proxy) {
  if (!proxy) return null
  const mode = PROXY_LOCATION_MODES.includes(proxy.request_location_mode) ? proxy.request_location_mode : 'inherit'
  if (mode === 'manual') {
    return detectedLocation(proxy.location_country, proxy.location_region, proxy.location_city, proxy.location_timezone)
  }
  if (mode !== 'auto') return null
  const v4 = detectedLocation(proxy.geo_country_code, proxy.geo_region, proxy.geo_city, proxy.geo_timezone)
  const v6 = detectedLocation(proxy.geo_v6_country_code, proxy.geo_v6_region, proxy.geo_v6_city, proxy.geo_v6_timezone)
  if (v4 && v6 && v4.timezone !== v6.timezone) return null
  return v4 || v6
}

/** Gateway 账号投影里随代理变化的字段：WS 连接上限与请求位置。 */
export function gatewayProxyProjection(db, config = {}) {
  const row = config?.proxy_id ? db.prepare('SELECT * FROM proxies WHERE id=?').get(config.proxy_id) : null
  return {
    proxy_max_websocket_connections: Math.max(0, Number(row?.max_websocket_connections) || 0),
    request_location: proxyRequestLocation(row),
  }
}
