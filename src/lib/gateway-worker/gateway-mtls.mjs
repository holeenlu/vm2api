/**
 * Gateway Worker mTLS 证书主体与实例 ID 绑定（中期技术债 M2；设计 5.1，运维见 SETUP 第 7 节）。
 *
 * 实例身份写在证书里：SAN URI `urn:kin:gateway:<instance_id>`（也认既有的 `spiffe://vm2api/gateway-worker/<instance_id>`）；
 * 证书没有这两种 URI 时才看主体 CN。一张证书只能代表一个实例：URI 里出现多个实例 ID 时不匹配任何实例。
 *
 * 控制面本身只监听明文 HTTP（src/server.mjs，上游文件），拿到 Worker 客户端证书有两条路：
 * - 内部 mTLS 监听：KIN_CODEX_GATEWAY_INTERNAL_TLS_LISTEN=host:port（配 INTERNAL_TLS_CERT_FILE / INTERNAL_TLS_KEY_FILE 与
 *   TLS_CA_FILE），只服务 /internal/v1/gateway/* 两组内部接口，由 Node 直接终止 TLS 1.3 并校验客户端证书；
 * - 受信反代：KIN_CODEX_GATEWAY_MTLS_PROXY_HEADER 指定反代写入客户端证书的请求头（nginx `$ssl_client_escaped_cert`），
 *   只在请求来自 KIN_CODEX_GATEWAY_MTLS_TRUSTED_PROXIES 列出的地址时采信，并用 TLS_CA_FILE 复核签发者与有效期。
 * KIN_CODEX_GATEWAY_REQUIRE_MTLS=1 时，没有可信客户端证书或证书实例与请求声明的实例不一致的内部请求一律拒绝。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import https from 'node:https'
import net from 'node:net'

const URN_PREFIX = 'urn:kin:gateway:'
const SPIFFE_PREFIX = 'spiffe://vm2api/gateway-worker/'

export function gatewayMtlsRequired(env = process.env) {
  return ['1', 'true'].includes(
    String(env.KIN_CODEX_GATEWAY_REQUIRE_MTLS || '')
      .trim()
      .toLowerCase(),
  )
}

/** 解析 Node 的 subjectAltName 文本（`DNS:a, URI:urn:..., IP Address:...`；含特殊字符的值带 JSON 引号）。 */
export function parseSubjectAltName(text) {
  const out = []
  const source = String(text || '')
  let i = 0
  while (i < source.length) {
    while (source[i] === ' ' || source[i] === ',') i++
    const colon = source.indexOf(':', i)
    if (colon < 0) break
    const type = source.slice(i, colon)
    let j = colon + 1
    let value
    if (source[j] === '"') {
      let k = j + 1
      while (k < source.length && source[k] !== '"') k += source[k] === '\\' ? 2 : 1
      try {
        value = JSON.parse(source.slice(j, k + 1))
      } catch {
        value = source.slice(j + 1, k)
      }
      j = k + 1
    } else {
      const next = source.indexOf(', ', j)
      value = source.slice(j, next < 0 ? source.length : next)
      j = next < 0 ? source.length : next
    }
    out.push({ type, value })
    i = j
  }
  return out
}

// 主体里的全部 CN：getPeerCertificate() 多个 CN 时给数组，X509Certificate.subject 是逐行文本
function subjectCommonNames(subject) {
  if (!subject) return []
  if (typeof subject === 'object') {
    const value = subject.CN
    return (Array.isArray(value) ? value : value == null ? [] : [value]).map(String)
  }
  return String(subject)
    .split('\n')
    .filter((part) => part.startsWith('CN='))
    .map((part) => part.slice(3))
}

// URN 的 scheme 与 NID、spiffe 的 scheme 与信任域不区分大小写（RFC 8141、RFC 3986）；实例 ID 部分区分大小写。与 Go 侧 tls.go 一致
function instanceFromUri(value) {
  const text = String(value || '')
  for (const prefix of [URN_PREFIX, SPIFFE_PREFIX])
    if (text.length > prefix.length && text.slice(0, prefix.length).toLowerCase() === prefix)
      return text.slice(prefix.length)
  return null
}

/**
 * 证书代表的实例身份：{ uris: [实例 ID…]（来自 SAN URI）, cn, invalid }。接受 X509Certificate 或 getPeerCertificate() 的结果。
 * 主体带多个 CN 的证书视为无效（invalid），不绑定任何实例（与 Go 侧一致）。
 */
export function certificateIdentity(cert) {
  if (!cert) return null
  const san = parseSubjectAltName(cert.subjectAltName ?? cert.subjectaltname)
  const uris = []
  for (const entry of san) {
    if (entry.type !== 'URI') continue
    const id = instanceFromUri(entry.value)
    if (id != null) uris.push(id)
  }
  const cns = subjectCommonNames(cert.subject)
  return {
    uris,
    cn: cns.length === 1 ? cns[0] : '',
    invalid: cns.length > 1,
    dns: san.filter((e) => e.type === 'DNS').map((e) => e.value),
  }
}

/** 证书是否绑定到该实例：多个 CN 时不绑定；有实例 URI 时必须全部等于该实例；否则看 CN。 */
export function certificateMatchesInstance(identity, instanceId) {
  const id = String(instanceId || '')
  if (!identity || !id || identity.invalid) return false
  if (identity.uris.length) return identity.uris.every((value) => value === id)
  return identity.cn === id
}

// 受信反代列表按原文缓存；非法条目告警一次并忽略（审查 P2：不能让每个请求都 500）
const proxyListCache = new Map()
export function trustedProxies(env, log = console) {
  const text = String(env.KIN_CODEX_GATEWAY_MTLS_TRUSTED_PROXIES || '')
  if (proxyListCache.has(text)) return proxyListCache.get(text)
  const list = new net.BlockList()
  let any = false
  for (const raw of text.split(',')) {
    const entry = raw.trim()
    if (!entry) continue
    const [address, prefix, extra] = entry.split('/')
    const family = net.isIPv6(address) ? 'ipv6' : net.isIPv4(address) ? 'ipv4' : null
    const bits = prefix === undefined ? null : Number(prefix)
    const maxBits = family === 'ipv6' ? 128 : 32
    if (
      !family ||
      extra !== undefined ||
      (prefix !== undefined && (!/^\d+$/.test(prefix) || !Number.isInteger(bits) || bits > maxBits))
    ) {
      log.warn?.(`KIN_CODEX_GATEWAY_MTLS_TRUSTED_PROXIES: ignoring invalid entry ${JSON.stringify(entry)}`)
      continue
    }
    try {
      if (bits === null) list.addAddress(address, family)
      else list.addSubnet(address, bits, family)
      any = true
    } catch {
      log.warn?.(`KIN_CODEX_GATEWAY_MTLS_TRUSTED_PROXIES: ignoring invalid entry ${JSON.stringify(entry)}`)
    }
  }
  const result = any ? list : null
  proxyListCache.set(text, result)
  // 受信反代头只证明“反代看到了一张证书”，不证明请求方持有私钥：主端口必须只对反代本身开放（复审 P2-8）。
  // 列表里有非回环地址时提醒一次
  const nonLoopback = text
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry && !/^(127\.|::1(\/128)?$|::ffff:127\.)/.test(entry))
  if (nonLoopback.length)
    log.warn?.(
      `KIN_CODEX_GATEWAY_MTLS_TRUSTED_PROXIES includes non-loopback entries (${nonLoopback.join(', ')}): the control plane port must only be reachable from these proxies; prefer KIN_CODEX_GATEWAY_INTERNAL_TLS_LISTEN`,
    )
  return result
}

function remoteAddress(req) {
  const raw = String(req?.socket?.remoteAddress || '')
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw
}

// CA 文件读一次后缓存，文件的修改时间或大小变化时重读（审查 P2）
const caCache = new Map()
function readCa(env) {
  const file = env.KIN_CODEX_GATEWAY_TLS_CA_FILE
  if (!file) return []
  const stat = fs.statSync(file)
  const stamp = `${stat.mtimeMs}:${stat.size}`
  const cached = caCache.get(file)
  if (cached?.stamp === stamp) return cached.certs
  const pem = fs.readFileSync(file, 'utf8')
  const certs = (pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || []).map(
    (block) => new crypto.X509Certificate(block),
  )
  caCache.set(file, { stamp, certs })
  return certs
}

function proxiedCertificate(req, env, now) {
  const header = String(env.KIN_CODEX_GATEWAY_MTLS_PROXY_HEADER || '')
    .trim()
    .toLowerCase()
  if (!header) return { cert: null }
  const raw = req?.headers?.[header]
  if (!raw) return { cert: null }
  const proxies = trustedProxies(env)
  const address = remoteAddress(req)
  // 反代头只在请求来自列出的反代地址时采信；其他来源带了这个头视为伪造
  if (!proxies || !address || !proxies.check(address, net.isIPv6(address) ? 'ipv6' : 'ipv4'))
    return { error: 'client_certificate_untrusted_source' }
  let cert
  try {
    const text = String(Array.isArray(raw) ? raw[0] : raw)
    const pem = text.includes('%') ? decodeURIComponent(text) : text.replace(/\t/g, '\n')
    cert = new crypto.X509Certificate(pem)
  } catch {
    return { error: 'client_certificate_invalid' }
  }
  let cas
  try {
    cas = readCa(env)
  } catch {
    cas = []
  }
  // 复核签发者与有效期（反代已校验链，这里防止反代配置错误时放过任意证书）；没有 CA 文件时不采信
  if (!cas.some((ca) => cert.checkIssued(ca) && cert.verify(ca.publicKey)))
    return { error: 'client_certificate_untrusted' }
  if (!(Date.parse(cert.validFrom) <= now && now < Date.parse(cert.validTo)))
    return { error: 'client_certificate_expired' }
  return { cert }
}

/**
 * 内部请求的客户端证书身份：内部 mTLS 监听（Node 已按 CA 校验）或受信反代头。
 * 返回 { identity } / { identity: null }（没有证书）/ { error }。
 */
export function requestCertificateIdentity(req, env = process.env, now = Date.now()) {
  const socket = req?.socket
  if (socket && typeof socket.getPeerCertificate === 'function' && socket.authorized) {
    const peer = socket.getPeerCertificate()
    if (peer && Object.keys(peer).length) return { identity: certificateIdentity(peer) }
  }
  const proxied = proxiedCertificate(req, env, now)
  if (proxied.error) return { error: proxied.error }
  return { identity: proxied.cert ? certificateIdentity(proxied.cert) : null }
}

/**
 * 校验请求的客户端证书与声明的实例一致。有证书时总是校验；REQUIRE_MTLS 时没有证书也拒绝。
 * 返回 null 表示通过，否则 { status, code, message }。
 */
export function checkClientCertificate(req, instanceId, env = process.env) {
  const result = requestCertificateIdentity(req, env)
  if (result.error) return { status: 401, code: result.error, message: 'Worker 客户端证书不可信' }
  if (!result.identity) {
    if (!gatewayMtlsRequired(env)) return null
    return { status: 401, code: 'client_certificate_required', message: '需要 Worker 客户端证书（mTLS）' }
  }
  if (!certificateMatchesInstance(result.identity, instanceId))
    return {
      status: 403,
      code: 'client_certificate_instance_mismatch',
      message: `客户端证书不属于实例 ${instanceId}`,
    }
  return null
}

/** Worker 服务端证书是否绑定到登记的实例（控制面 → Worker，REQUIRE_MTLS 时要求）。参数为 getPeerCertificate() 的结果。 */
export function serverCertificateBound(cert, instanceId) {
  return certificateMatchesInstance(certificateIdentity(cert), instanceId)
}

/**
 * 内部 mTLS 监听（可选）：KIN_CODEX_GATEWAY_INTERNAL_TLS_LISTEN=host:port。TLS 1.3，客户端证书必须由 TLS_CA_FILE 签发；
 * 只把请求交给 handle（内部接口），其他路径 404。监听不阻止进程退出。
 */
export function startGatewayInternalTlsListener({ handle, env = process.env, log = console } = {}) {
  const listen = String(env.KIN_CODEX_GATEWAY_INTERNAL_TLS_LISTEN || '').trim()
  if (!listen) return null
  const index = listen.lastIndexOf(':')
  const host = index > 0 ? listen.slice(0, index).replace(/^\[|\]$/g, '') : '0.0.0.0'
  const port = Number(index >= 0 ? listen.slice(index + 1) : listen)
  let options
  try {
    options = {
      cert: fs.readFileSync(env.KIN_CODEX_GATEWAY_INTERNAL_TLS_CERT_FILE),
      key: fs.readFileSync(env.KIN_CODEX_GATEWAY_INTERNAL_TLS_KEY_FILE),
      ca: fs.readFileSync(env.KIN_CODEX_GATEWAY_TLS_CA_FILE),
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.3',
    }
  } catch (error) {
    log.error?.(`gateway internal mTLS listener disabled: cannot read certificate files (${error?.message || error})`)
    return null
  }
  const server = https.createServer(options, async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'https://gateway-internal')
      if (url.pathname.startsWith('/internal/v1/gateway/') && (await handle(req, res, url)) !== false) return
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: { code: 'not_found', message: 'not found' } }))
    } catch (error) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({ ok: false, error: { code: 'internal_error', message: String(error?.message || error) } }),
      )
    }
  })
  server.on('tlsClientError', () => {})
  // 端口被占用等监听错误只告警，不让控制面进程崩溃（审查 P2）
  server.on('error', (error) =>
    log.error?.(`gateway internal mTLS listener on ${listen} failed: ${error?.code || ''} ${error?.message || error}`),
  )
  // 启动时解析一次受信反代列表，非法条目在这里告警
  trustedProxies(env, log)
  server.listen(port, host, () => log.info?.(`gateway internal mTLS listener on ${host}:${server.address()?.port}`))
  server.unref()
  return server
}
