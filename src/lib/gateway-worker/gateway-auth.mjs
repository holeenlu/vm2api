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

export function buildGatewayHeaders({
  secret,
  body,
  keyId = 'default',
  now = new Date(),
  nonce = crypto.randomUUID(),
}) {
  const timestamp = now.toISOString()
  const hash = bodyHash(body)
  return {
    'content-type': 'application/json',
    'x-kin-gateway-key': keyId,
    'x-kin-gateway-timestamp': timestamp,
    'x-kin-gateway-nonce': nonce,
    'x-kin-gateway-body-sha256': hash,
    'x-kin-gateway-signature': signGatewayRequest({ secret, timestamp, nonce, hash, body }),
  }
}

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
  if (hash.length !== actualHash.length || !crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(actualHash)))
    return { ok: false, code: 'body_hash_mismatch' }
  const expected = signGatewayRequest({ secret, timestamp, nonce, hash, body })
  if (expected.length !== signature.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature)))
    return { ok: false, code: 'invalid_signature' }
  return { ok: true, nonce }
}
