import crypto from 'node:crypto'

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortValue(value[key])]),
    )
  }
  return value
}

export function canonicalJson(value) {
  return JSON.stringify(sortValue(value))
}

export function bodyHash(body) {
  const raw = typeof body === 'string' || Buffer.isBuffer(body) ? body : canonicalJson(body)
  return crypto.createHash('sha256').update(raw).digest('hex')
}

export function signGatewayRequest({ secret, timestamp, nonce, hash, body }) {
  const raw = typeof body === 'string' || Buffer.isBuffer(body) ? body : canonicalJson(body)
  // 与拼接 `${timestamp}\n${nonce}\n${hash}\n${raw}` 等价；分段写入，不为大正文拼接副本
  return crypto
    .createHmac('sha256', String(secret))
    .update(`${timestamp}\n${nonce}\n${hash}\n`)
    .update(raw)
    .digest('hex')
}

// 签名头（v1 签名串：时间戳、随机串、正文摘要与正文）；密钥为托管 Worker 的会话密钥或共用内部令牌（2026-11-07 S4）
export function buildGatewayHeaders({ secret, body, now = new Date(), nonce = crypto.randomUUID() }) {
  const timestamp = now.toISOString()
  const hash = bodyHash(body)
  return {
    'content-type': 'application/json',
    'x-kin-gateway-key': 'default',
    'x-kin-gateway-timestamp': timestamp,
    'x-kin-gateway-nonce': nonce,
    'x-kin-gateway-body-sha256': hash,
    'x-kin-gateway-signature': signGatewayRequest({ secret, timestamp, nonce, hash, body }),
  }
}

/** 完整签名头是否齐全（预过滤：缺任何一项都不读正文）。 */
export function hasGatewaySignatureHeaders(headers) {
  return [
    'x-kin-gateway-timestamp',
    'x-kin-gateway-nonce',
    'x-kin-gateway-body-sha256',
    'x-kin-gateway-signature',
  ].every((name) => !!headers?.[name])
}

const timingEqual = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))

/** 校验签名头（v1）。 */
export function verifyGatewayHeaders({ secret, headers, body, now = new Date(), clockSkewMs = 30_000 }) {
  const timestamp = String(headers?.['x-kin-gateway-timestamp'] || '')
  const nonce = String(headers?.['x-kin-gateway-nonce'] || '')
  const hash = String(headers?.['x-kin-gateway-body-sha256'] || '')
  const signature = String(headers?.['x-kin-gateway-signature'] || '')
  if (!timestamp || !nonce || !hash || !signature) return { ok: false, code: 'missing_signature' }
  const parsed = Date.parse(timestamp)
  if (!Number.isFinite(parsed) || Math.abs(now.getTime() - parsed) > clockSkewMs)
    return { ok: false, code: 'signature_time_window' }
  const actualHash = bodyHash(body)
  if (!timingEqual(hash, actualHash)) return { ok: false, code: 'body_hash_mismatch' }
  const expected = signGatewayRequest({ secret, timestamp, nonce, hash, body })
  if (!timingEqual(expected, signature)) return { ok: false, code: 'invalid_signature' }
  return { ok: true, nonce }
}

/** 响应签名的作用域（与 Worker 的 responseSignatureScope 相同）：状态码与请求目标。 */
export function responseSignatureScope(status, path) {
  return `resp ${Number(status) || 0} ${String(path || '')}`
}

/** 给响应正文签名：HMAC 覆盖作用域、本次请求的随机串、正文摘要与正文。 */
export function signGatewayResponse({ secret, status, path, nonce, text }) {
  const hash = bodyHash(text)
  return {
    hash,
    signature: signGatewayRequest({ secret, timestamp: responseSignatureScope(status, path), nonce, hash, body: text }),
  }
}

/** Worker 实例 ID：字母或数字开头，最多 64 个字符（字母、数字、点、下划线、连字符）。 */
export const INSTANCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export function validInstanceId(value) {
  return typeof value === 'string' && INSTANCE_ID_PATTERN.test(value)
}

/** 常量时间比较（任一方为空时为假）。 */
export function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''))
  const right = Buffer.from(String(b ?? ''))
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right)
}

/**
 * 控制面与某个 Worker 实例之间用的 HMAC 密钥（2026-11-07 S4）：托管器正在运行的同机 Worker 用它的会话密钥，
 * 其他实例（外部自启）用共用令牌 KIN_CODEX_GATEWAY_INTERNAL_TOKEN。
 */
export function gatewaySecretFor(instanceId, sharedToken, session = null) {
  return session && session.instanceId === instanceId ? session.key : sharedToken
}
