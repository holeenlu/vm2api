import crypto from 'node:crypto'
import http from 'node:http'
import { Readable } from 'node:stream'
import { WebSocket } from 'ws'
import { bodyHash, buildGatewayHeaders, signGatewayRequest } from './gateway-auth.mjs'
import { supervisedSession } from './worker-supervisor.mjs'

// 控制面发往实例的请求用哪把密钥签名（2026-11-07 S4）：托管的同机 Worker 用它的会话密钥（instance() 挂在不可枚举属性上），
// 其他实例用共用内部令牌
const SIGNING = Symbol('gatewaySigning')
function signingFor(instance, secret) {
  return { secret: instance?.[SIGNING]?.secret || secret }
}
function signedHeaders(instance, secret, body) {
  const auth = signingFor(instance, secret)
  return { auth, headers: buildGatewayHeaders({ secret: auth.secret, body }) }
}

const STREAM_IDLE_TIMEOUT_MS = 330_000

function requestRaw(
  instance,
  path,
  { method = 'GET', headers = {}, payload = '', timeoutMs = 15_000, stream = false, signal = null } = {},
) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('client cancelled'), { code: 'client_cancelled' }))
      return
    }
    const target = new URL(path, instance.base_url)
    // 只支持与控制面同机的 Worker（Gateway 事实直读，设计第 19 节）：环回明文 + HMAC 签名；
    // 非环回地址（同机的私有主机网络）要显式设置 KIN_CODEX_GATEWAY_ALLOW_INSECURE
    const insecureSetting = String(process.env.KIN_CODEX_GATEWAY_ALLOW_INSECURE || '')
      .trim()
      .toLowerCase()
    const loopback = ['127.0.0.1', '::1', 'localhost'].includes(target.hostname)
    const allowInsecure = insecureSetting ? !['0', 'false', 'no'].includes(insecureSetting) : loopback
    if (target.protocol !== 'http:' || !allowInsecure)
      throw Object.assign(new Error('Gateway Worker must run on the control-plane host (loopback HTTP)'), {
        code: 'gateway_worker_not_local',
      })
    const options = {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      path: `${target.pathname}${target.search}`,
      method,
      headers,
    }
    const req = http.request(options)
    const timer = setTimeout(
      () => req.destroy(Object.assign(new Error('gateway request timeout'), { code: 'gateway_timeout' })),
      timeoutMs,
    )
    timer.unref?.()
    // 调用方在 Worker 返回响应前取消：断开到 Worker 的请求，Worker 按请求上下文停止排队、重试与换号。
    // 收到响应后解除，提交后的取消由调用方经 /cancel 通知 Worker。
    const onAbort = () => req.destroy(Object.assign(new Error('client cancelled'), { code: 'client_cancelled' }))
    signal?.addEventListener?.('abort', onAbort, { once: true })
    const detach = () => signal?.removeEventListener?.('abort', onAbort)
    req.once('error', (error) => {
      clearTimeout(timer)
      detach()
      reject(error)
    })
    req.once('response', (response) => {
      detach()
      const responseHeaders = Object.fromEntries(
        Object.entries(response.headers).map(([key, value]) => [
          key.toLowerCase(),
          Array.isArray(value) ? value.join(', ') : String(value ?? ''),
        ]),
      )
      if (stream) {
        // 收到响应头后不再按总时长截断：长推理流只要 Worker 仍在输出就继续；Worker 对上游正文按 300s 空闲判定中断，
        // 这里以略长的套接字空闲时限兜底 Worker 本身失联
        clearTimeout(timer)
        req.setTimeout(STREAM_IDLE_TIMEOUT_MS, () =>
          req.destroy(Object.assign(new Error('gateway stream idle timeout'), { code: 'gateway_timeout' })),
        )
        resolve({
          ok: response.statusCode >= 200 && response.statusCode < 300,
          status: response.statusCode || 0,
          headers: responseHeaders,
          body: Readable.toWeb(response),
          // Worker 在流结束后经 trailer 交付诊断（X-Kin-Gateway-Diagnostic）；读完正文后才有值
          trailers: () => response.trailers || {},
          cancel: () => {
            clearTimeout(timer)
            response.destroy()
            req.destroy()
          },
          release: () => clearTimeout(timer),
        })
        return
      }
      const chunks = []
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      response.once('end', () => {
        clearTimeout(timer)
        resolve({
          ok: response.statusCode >= 200 && response.statusCode < 300,
          status: response.statusCode || 0,
          headers: responseHeaders,
          text: Buffer.concat(chunks).toString('utf8'),
        })
      })
      response.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
    })
    if (payload && !['GET', 'HEAD'].includes(method.toUpperCase())) req.write(payload)
    req.end()
  })
}

// 事件页响应签名（P3.11）：Worker 用内部令牌对“resp + 状态码 + 路径、本次请求随机串、正文摘要、正文”做 HMAC
// （R3 审查 P2-7 加入状态码与路径）；缺签名、签名不符或摘要不符都视为无效响应（防止传输层被替换时伪造或重放事件页）
export function verifySignedResponse(secret, nonce, response, path) {
  const text = response?.text ?? ''
  const signature = String(response?.headers?.['x-kin-gateway-response-signature'] || '')
  const hash = bodyHash(text)
  if (!secret || !signature || response?.headers?.['x-kin-gateway-response-sha256'] !== hash) return false
  // 签名域覆盖完整请求目标（路径与查询串，终审 B3）
  const scope = `resp ${Number(response?.status) || 0} ${String(path || '')}`
  const expected = signGatewayRequest({ secret, timestamp: scope, nonce, hash, body: text })
  return expected.length === signature.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
}

// 健康探测与排空/恢复时接受的 Worker 自报字段（白名单）。实例 id、准入状态、心跳时间由控制面决定
const WORKER_REPORTED_FIELDS = [
  'boot_id',
  'version',
  'region',
  'protocol_version',
  'drain_state',
  'drain_deadline',
  'active_concurrency',
]
function workerReportedFields(data) {
  const out = {}
  if (!data || typeof data !== 'object') return out
  for (const key of WORKER_REPORTED_FIELDS) {
    const value = data[key]
    if (value === undefined || value === null || value === '') continue
    out[key] = value
  }
  return out
}

async function request(
  instance,
  path,
  {
    method = 'GET',
    body = null,
    secret = '',
    timeoutMs = 15_000,
    raw = false,
    signal = null,
    verifyResponse = false,
  } = {},
) {
  const payload = body == null ? '' : JSON.stringify(body)
  const signed = signedHeaders(instance, secret, payload)
  const headers = { accept: 'application/json', ...signed.headers }
  if (payload && !['GET', 'HEAD'].includes(method.toUpperCase()))
    headers['content-length'] = String(Buffer.byteLength(payload))
  const response = await requestRaw(instance, path, { method, headers, payload, timeoutMs, signal })
  // 响应签名用本次请求的同一把密钥校验（Worker 用验证请求的那把密钥签响应）
  if (verifyResponse && !verifySignedResponse(signed.auth.secret, headers['x-kin-gateway-nonce'], response, path))
    return {
      ok: false,
      status: 502,
      headers: response.headers,
      data: { ok: false, error: { code: 'gateway_response_signature_invalid', message: 'Worker 响应签名无效' } },
    }
  // Live 引导的应答是 SDP/JSON 原文，不能经过解析再序列化
  if (raw)
    return {
      ok: response.ok,
      status: response.status,
      headers: response.headers,
      data: response.text,
      text: response.text,
    }
  let data = null
  try {
    data = response.text ? JSON.parse(response.text) : null
  } catch {
    data = { raw: response.text }
  }
  return { ok: response.ok, status: response.status, headers: response.headers, data }
}

async function requestStream(
  instance,
  path,
  { method = 'GET', body = null, secret = '', timeoutMs = 900_000, signal = null } = {},
) {
  const payload = body == null ? '' : JSON.stringify(body)
  const headers = {
    accept: 'application/json, text/event-stream',
    ...signedHeaders(instance, secret, payload).headers,
  }
  if (payload && !['GET', 'HEAD'].includes(method.toUpperCase()))
    headers['content-length'] = String(Buffer.byteLength(payload))
  const response = await requestRaw(instance, path, { method, headers, payload, timeoutMs, stream: true, signal })
  return { ...response, body: response.body }
}

// 等待 Worker 响应头的时限与 Worker 提交前时限（KIN_CODEX_GATEWAY_REQUEST_TIMEOUT_SECONDS 默认 900）对齐；
// 生图、Search 等非流式请求同样可能持续数分钟，不能沿用控制接口的 15 秒。响应头之后改按空闲时限。
const EXECUTE_TIMEOUT_MS = 900_000
const PRE_SEND_ERRORS = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'gateway_worker_not_local',
])

export class GatewayWorkerClient {
  constructor({ repo, secret = '', timeoutMs = 15_000, env = process.env } = {}) {
    this.repo = repo
    this.secret = secret
    this.env = env
    this.timeoutMs = timeoutMs
  }

  async instance(id) {
    const row = await this.repo.getInstance(id)
    if (!row) return row
    const key = await this.signingKey(row.id)
    if (key) Object.defineProperty(row, SIGNING, { value: key, enumerable: false })
    return row
  }

  // 托管的同机 Worker 的会话密钥；其他实例返回 null（用共用令牌）
  async signingKey(instanceId) {
    const session = supervisedSession()
    return session && session.instanceId === instanceId ? { secret: session.key } : null
  }

  async health(instanceId) {
    const instance = await this.instance(instanceId)
    if (!instance)
      throw Object.assign(new Error('gateway instance not found'), { code: 'gateway_instance_not_found', status: 404 })
    const result = await request(instance, '/internal/v1/health', { secret: this.secret, timeoutMs: this.timeoutMs })
    // 非 2xx 不刷新心跳时间（不可达或超时时请求直接抛错、不写库）：否则凭据库重建投影在 45 秒内仍把它当在线（最终审计 I2）；
    // 成功时记控制面时间。Worker 返回的字段按白名单取：不能改写实例 id（会写到别的行）、准入状态与心跳时间（复核 S6）
    await this.repo.upsertInstance({
      ...instance,
      ...(result.ok ? workerReportedFields(result.data) : {}),
      health_state: result.ok ? result.data?.health_state || 'healthy' : 'error',
      last_heartbeat_at: result.ok ? new Date().toISOString() : instance.last_heartbeat_at,
    })
    return result
  }

  async capabilities(instanceId) {
    const instance = await this.instance(instanceId)
    if (!instance) throw new Error('gateway instance not found')
    return request(instance, '/internal/v1/capabilities', { secret: this.secret, timeoutMs: this.timeoutMs })
  }

  async accountAction(instanceId, accountId, action, body = {}) {
    const instance = await this.instance(instanceId)
    if (!instance) throw new Error('gateway instance not found')
    return request(instance, `/internal/v1/accounts/${accountId}/${action}`, {
      method: 'POST',
      body,
      secret: this.secret,
      timeoutMs: ['test', 'quota', 'refresh', 'reset-credits'].includes(action) ? 60_000 : this.timeoutMs,
    })
  }

  // 账号个人资料、订阅周期（JSON）与官方头像（流式）
  async accountInsight(instanceId, accountId, kind) {
    const instance = await this.instance(instanceId)
    if (!instance) throw new Error('gateway instance not found')
    const path = `/internal/v1/accounts/${accountId}/${kind}`
    if (kind === 'avatar') return requestStream(instance, path, { secret: this.secret, timeoutMs: 60_000 })
    return request(instance, path, { secret: this.secret, timeoutMs: 20_000 })
  }

  async cancel(instanceId, dispatchId) {
    const instance = await this.instance(instanceId)
    if (!instance) throw new Error('gateway instance not found')
    return request(instance, `/internal/v1/execute/${encodeURIComponent(dispatchId)}/cancel`, {
      method: 'POST',
      body: {},
      secret: this.secret,
      timeoutMs: this.timeoutMs,
    })
  }

  // Worker 用自身 OAuth 账号读取上游 Codex 模型目录（带 5 分钟缓存）
  async modelCatalog(instanceId, clientVersion) {
    const instance = await this.instance(instanceId)
    if (!instance) throw new Error('gateway instance not found')
    return request(instance, '/internal/v1/models', {
      method: 'POST',
      body: { client_version: clientVersion },
      secret: this.secret,
      timeoutMs: 90_000,
    })
  }

  // 把入站 WS 控制帧（response.interrupt）转发到该连接绑定的上游 WS
  async wsFrame(instanceId, connectionKey, frame) {
    const instance = await this.instance(instanceId)
    if (!instance) throw new Error('gateway instance not found')
    return request(instance, '/internal/v1/ws/frame', {
      method: 'POST',
      body: { connection_key: connectionKey, frame },
      secret: this.secret,
      timeoutMs: this.timeoutMs,
    })
  }

  async wsClose(instanceId, connectionKey) {
    const instance = await this.instance(instanceId)
    if (!instance) throw new Error('gateway instance not found')
    return request(instance, '/internal/v1/ws/close', {
      method: 'POST',
      body: { connection_key: connectionKey },
      secret: this.secret,
      timeoutMs: this.timeoutMs,
    })
  }

  // 执行契约事件发件箱（执行契约 5.6）：按序号拉取与确认
  async readEvents(instanceId, { after = 0, streamId = '', limit = 200 } = {}) {
    const instance = await this.instance(instanceId)
    if (!instance) throw new Error('gateway instance not found')
    const query = new URLSearchParams({ after: String(after), limit: String(limit) })
    if (streamId) query.set('stream_id', streamId)
    return request(instance, `/internal/v1/events?${query}`, {
      secret: this.secret,
      timeoutMs: 30_000,
      verifyResponse: true,
    })
  }

  async ackEvents(instanceId, streamId, seq) {
    const instance = await this.instance(instanceId)
    if (!instance) throw new Error('gateway instance not found')
    return request(instance, '/internal/v1/events/ack', {
      method: 'POST',
      body: { stream_id: streamId, seq },
      secret: this.secret,
      timeoutMs: this.timeoutMs,
    })
  }

  // 画像预览、发布状态与隐私规则预览：只读试运行，不发送上游请求
  async internal(instanceId, path, { method = 'GET', body = null } = {}) {
    const instance = await this.instance(instanceId)
    if (!instance) throw new Error('gateway instance not found')
    return request(instance, path, { method, body, secret: this.secret, timeoutMs: this.timeoutMs })
  }

  async control(instanceId, action, body = {}) {
    const instance = await this.instance(instanceId)
    if (!instance) throw new Error('gateway instance not found')
    const path = action === 'drain' ? '/internal/v1/drain' : '/internal/v1/resume'
    const result = await request(instance, path, {
      method: 'POST',
      body,
      secret: this.secret,
      timeoutMs: this.timeoutMs,
    })
    if (result.ok) {
      const data = result.data || {}
      // 实例 id 以控制面为准，不随 Worker 返回改写（之后的 setDrain 也按 instanceId，复核 S6）
      await this.repo.upsertInstance({
        ...instance,
        ...workerReportedFields(data),
        health_state: data.health_state || 'healthy',
        last_heartbeat_at: new Date().toISOString(),
      })
      await this.repo.setDrain(instanceId, action === 'drain', data.drain_deadline || null)
    }
    return result
  }

  async execute({
    instanceId,
    requestId,
    attemptId,
    protocol,
    operation,
    model,
    scope,
    body,
    headers = {},
    expiresAt,
    scheduling = null,
    connectionKey = null,
    upstreamTransport = null,
    replayBody = null,
    accountProtection = null,
    clientScope = null,
    fastMode = null,
    clientProfile = null,
    profileDeployment = null,
    privacy = null,
    requestLocation = null,
    signal = null,
  }) {
    const instance = await this.instance(instanceId)
    if (!instance) throw Object.assign(new Error('gateway instance not found'), { code: 'gateway_instance_not_found' })
    const nonce = crypto.randomUUID()
    const dispatchId = await this.repo.createDispatch({
      requestId,
      attemptId,
      instanceId,
      scope,
      protocol,
      model,
      nonce,
      expiresAt,
    })
    const envelope = {
      version: 1,
      dispatch_id: dispatchId,
      request_id: requestId,
      attempt_id: attemptId || null,
      pool_scope: scope || {},
      operation,
      protocol,
      model,
      stream: body?.stream === true,
      body,
      headers,
      ...(scheduling ? { scheduling } : {}),
      ...(connectionKey ? { connection_key: connectionKey } : {}),
      ...(upstreamTransport ? { upstream_transport: upstreamTransport } : {}),
      ...(replayBody ? { replay_body: replayBody } : {}),
      ...(accountProtection ? { account_protection: accountProtection } : {}),
      ...(clientScope ? { client_scope: clientScope } : {}),
      ...(fastMode && fastMode !== 'default' ? { fast_mode: fastMode } : {}),
      ...(clientProfile ? { client_profile: clientProfile } : {}),
      ...(profileDeployment && Object.keys(profileDeployment).length ? { profile_deployment: profileDeployment } : {}),
      ...(privacy ? { privacy } : {}),
      ...(requestLocation ? { request_location: requestLocation } : {}),
      expires_at: expiresAt,
      nonce,
    }
    const stream = body?.stream === true
    let result
    try {
      result = await (stream ? requestStream : request)(instance, '/internal/v1/execute', {
        method: 'POST',
        body: envelope,
        secret: this.secret,
        timeoutMs: Math.max(this.timeoutMs, EXECUTE_TIMEOUT_MS),
        raw: operation === 'live',
        signal,
      })
    } catch (error) {
      if (error?.code === 'client_cancelled') {
        await this.repo.markDispatch(dispatchId, 'cancelled', { sent_at: new Date().toISOString() })
        throw Object.assign(error, { dispatch_id: dispatchId, send_state: 'cancelled' })
      }
      // 建连阶段失败（拒绝连接、DNS、本地 TLS 配置）说明 Worker 没有收到请求，可换实例
      const notSent = PRE_SEND_ERRORS.has(error?.code)
      await this.repo.markDispatch(dispatchId, notSent ? 'failed' : 'ambiguous', { sent_at: new Date().toISOString() })
      throw Object.assign(error, { dispatch_id: dispatchId, send_state: notSent ? 'not_sent' : 'ambiguous' })
    }
    if (!stream) {
      await this.repo.markDispatch(dispatchId, result.ok ? 'completed' : 'failed', {
        sent_at: new Date().toISOString(),
      })
      return { ...result, dispatch_id: dispatchId }
    }
    await this.repo.markDispatch(dispatchId, result.ok ? 'streaming' : 'failed', { sent_at: new Date().toISOString() })
    return { ...result, dispatch_id: dispatchId, stream: true }
  }

  // Live hangup：同一调用方随时可挂断（Worker 只复验调用方，不要求 sideband 认领）
  async liveHangup(instanceId, payload) {
    const instance = await this.instance(instanceId)
    if (!instance) throw Object.assign(new Error('gateway instance not found'), { code: 'gateway_instance_not_found' })
    return request(instance, '/internal/v1/live/hangup', {
      method: 'POST',
      body: payload,
      secret: this.secret,
      raw: true,
    })
  }

  // Live sideband：签名参数放在 X-Kin-Gateway-Live 头（Body-Sha256 对它计算），返回连到 Worker 的 WebSocket
  async liveSideband(instanceId, payload) {
    const instance = await this.instance(instanceId)
    if (!instance) throw Object.assign(new Error('gateway instance not found'), { code: 'gateway_instance_not_found' })
    // 非 ASCII 转义为 \uXXXX，保证参数能放进 HTTP 头
    const blob = JSON.stringify(payload).replace(
      /[\u0080-\uffff]/g,
      (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
    )
    const target = new URL('/internal/v1/live/sideband', instance.base_url)
    target.protocol = 'ws:'
    const headers = {
      'x-kin-gateway-live': blob,
      ...signedHeaders(instance, this.secret, blob).headers,
    }
    return new WebSocket(target, payload.subprotocols || [], {
      headers,
      handshakeTimeout: 20_000,
      perMessageDeflate: false,
    })
  }
}
