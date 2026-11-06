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

/**
 * 实例密钥的签名串（v2，中期技术债 M2 审查 P2）：在 v1 之外覆盖方法、请求目标（路径与查询串）、实例与 key_id，
 * 同一把密钥签的请求不能被改投到另一个接口或另一个实例。共用令牌（key_id 为 default）仍用 v1，兼容旧版。
 * Worker 侧 auth.go 的 SignV2 与之相同。
 */
export function signGatewayRequestV2({ secret, method, path, instanceId, keyId, timestamp, nonce, hash, body }) {
  const raw = typeof body === 'string' || Buffer.isBuffer(body) ? body : canonicalJson(body)
  return crypto
    .createHmac('sha256', String(secret))
    .update(
      `v2\n${String(method || '').toUpperCase()}\n${path}\n${instanceId}\n${keyId}\n${timestamp}\n${nonce}\n${hash}\n`,
    )
    .update(raw)
    .digest('hex')
}

// keyId 为 'default' 时用共用内部令牌（v1 签名串）；为实例密钥的 key_id 时带上 x-kin-gateway-instance，
// 并用 v2 签名串覆盖 method 与 path（中期技术债 M2）
export function buildGatewayHeaders({
  secret,
  body,
  keyId = 'default',
  instanceId = '',
  method = 'POST',
  path = '',
  now = new Date(),
  nonce = crypto.randomUUID(),
}) {
  const timestamp = now.toISOString()
  const hash = bodyHash(body)
  const instanceKey = keyId !== 'default' && !!instanceId
  return {
    'content-type': 'application/json',
    'x-kin-gateway-key': keyId,
    ...(instanceKey ? { 'x-kin-gateway-instance': instanceId } : {}),
    'x-kin-gateway-timestamp': timestamp,
    'x-kin-gateway-nonce': nonce,
    'x-kin-gateway-body-sha256': hash,
    'x-kin-gateway-signature': instanceKey
      ? signGatewayRequestV2({ secret, method, path, instanceId, keyId, timestamp, nonce, hash, body })
      : signGatewayRequest({ secret, timestamp, nonce, hash, body }),
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

/**
 * 校验签名头。带 x-kin-gateway-instance 与非 default 的 x-kin-gateway-key 时按 v2 校验（需要 method 与 path），
 * 否则按 v1。
 */
export function verifyGatewayHeaders({ secret, headers, body, method, path, now = new Date(), clockSkewMs = 30_000 }) {
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
  const keyId = String(headers?.['x-kin-gateway-key'] || '')
  const instanceId = String(headers?.['x-kin-gateway-instance'] || '')
  const v2 = keyId && keyId !== 'default' && instanceId
  if (v2 && (method == null || path == null)) return { ok: false, code: 'invalid_signature' }
  const expected = v2
    ? signGatewayRequestV2({ secret, method, path, instanceId, keyId, timestamp, nonce, hash, body })
    : signGatewayRequest({ secret, timestamp, nonce, hash, body })
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
