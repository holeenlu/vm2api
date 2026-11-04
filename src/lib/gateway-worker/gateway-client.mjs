import crypto from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import { Readable } from 'node:stream'
import fs from 'node:fs'
import { WebSocket } from 'ws'
import { buildGatewayHeaders } from './gateway-auth.mjs'

function tlsOptions(instance = {}) {
  const certFile = instance.tls_client_cert_file || process.env.KIN_CODEX_GATEWAY_TLS_CLIENT_CERT_FILE
  const keyFile = instance.tls_client_key_file || process.env.KIN_CODEX_GATEWAY_TLS_CLIENT_KEY_FILE
  const caFile = instance.tls_ca_file || process.env.KIN_CODEX_GATEWAY_TLS_CA_FILE
  if (!certFile && !keyFile && !caFile) return null
  return {
    cert: certFile ? fs.readFileSync(certFile) : undefined,
    key: keyFile ? fs.readFileSync(keyFile) : undefined,
    ca: caFile ? fs.readFileSync(caFile) : undefined,
    servername: instance.tls_server_name || process.env.KIN_CODEX_GATEWAY_TLS_SERVER_NAME || undefined,
    rejectUnauthorized: true,
    checkServerIdentity(hostname, cert) {
      const standard = tls.checkServerIdentity(hostname, cert)
      if (!standard) return undefined
      const expected = instance.tls_server_name || process.env.KIN_CODEX_GATEWAY_TLS_SERVER_NAME || instance.id
      const alt = String(cert.subjectaltname || '')
      if (
        expected &&
        (alt.includes(`DNS:${expected}`) ||
          alt.includes(`URI:spiffe://vm2api/gateway-worker/${expected}`) ||
          alt.includes(`DNS:gateway-worker/${expected}`))
      )
        return undefined
      return standard
    },
  }
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
    const requireMtls =
      process.env.KIN_CODEX_GATEWAY_REQUIRE_MTLS === '1' || process.env.KIN_CODEX_GATEWAY_REQUIRE_MTLS === 'true'
    const insecureSetting = String(process.env.KIN_CODEX_GATEWAY_ALLOW_INSECURE || '')
      .trim()
      .toLowerCase()
    const loopback = ['127.0.0.1', '::1', 'localhost'].includes(target.hostname)
    const allowInsecure = insecureSetting ? !['0', 'false', 'no'].includes(insecureSetting) : loopback
    if (!allowInsecure && target.protocol !== 'https:')
      throw Object.assign(new Error('Insecure Gateway Worker transport is disabled'), { code: 'gateway_tls_required' })
    if (requireMtls && target.protocol !== 'https:')
      throw Object.assign(new Error('Gateway Worker mTLS is required'), { code: 'gateway_tls_required' })
    if (requireMtls && target.protocol === 'https:') {
      const certFile = instance.tls_client_cert_file || process.env.KIN_CODEX_GATEWAY_TLS_CLIENT_CERT_FILE
      const keyFile = instance.tls_client_key_file || process.env.KIN_CODEX_GATEWAY_TLS_CLIENT_KEY_FILE
      const caFile = instance.tls_ca_file || process.env.KIN_CODEX_GATEWAY_TLS_CA_FILE
      if (!certFile || !keyFile || !caFile)
        throw Object.assign(new Error('Gateway Worker client mTLS files are required'), {
          code: 'gateway_client_cert_invalid',
        })
    }
    const transport = target.protocol === 'https:' ? https : http
    const options = {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      path: `${target.pathname}${target.search}`,
      method,
      headers,
      ...(target.protocol === 'https:' ? { ...tlsOptions(instance) } : {}),
    }
    const req = transport.request(options)
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

async function request(
  instance,
  path,
  { method = 'GET', body = null, secret = '', timeoutMs = 15_000, raw = false, signal = null } = {},
) {
  const payload = body == null ? '' : JSON.stringify(body)
  const headers = {
    accept: 'application/json',
    ...buildGatewayHeaders({ secret, body: payload, keyId: instance.key_id || 'default' }),
  }
  if (payload && !['GET', 'HEAD'].includes(method.toUpperCase()))
    headers['content-length'] = String(Buffer.byteLength(payload))
  const response = await requestRaw(instance, path, { method, headers, payload, timeoutMs, signal })
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
    ...buildGatewayHeaders({ secret, body: payload, keyId: instance.key_id || 'default' }),
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
  'gateway_tls_required',
  'gateway_client_cert_invalid',
])

export class GatewayWorkerClient {
  constructor({ repo, secret = '', timeoutMs = 15_000 } = {}) {
    this.repo = repo
    this.secret = secret
    this.timeoutMs = timeoutMs
  }

  instance(id) {
    return this.repo.getInstance(id)
  }

  async health(instanceId) {
    const instance = this.instance(instanceId)
    if (!instance)
      throw Object.assign(new Error('gateway instance not found'), { code: 'gateway_instance_not_found', status: 404 })
    const result = await request(instance, '/internal/v1/health', { secret: this.secret, timeoutMs: this.timeoutMs })
    this.repo.upsertInstance({
      ...instance,
      health_state: result.ok ? 'healthy' : 'error',
      last_heartbeat_at: new Date().toISOString(),
      ...(result.data || {}),
    })
    return result
  }

  async capabilities(instanceId) {
    const instance = this.instance(instanceId)
    if (!instance) throw new Error('gateway instance not found')
    return request(instance, '/internal/v1/capabilities', { secret: this.secret, timeoutMs: this.timeoutMs })
  }

  async upsertAccount(instanceId, account) {
    const instance = this.instance(instanceId)
    if (!instance) throw new Error('gateway instance not found')
    return request(instance, '/internal/v1/accounts', {
      method: 'POST',
      body: account,
      secret: this.secret,
      timeoutMs: this.timeoutMs,
    })
  }

  async accountAction(instanceId, accountId, action, body = {}) {
    const instance = this.instance(instanceId)
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
    const instance = this.instance(instanceId)
    if (!instance) throw new Error('gateway instance not found')
    const path = `/internal/v1/accounts/${accountId}/${kind}`
    if (kind === 'avatar') return requestStream(instance, path, { secret: this.secret, timeoutMs: 60_000 })
    return request(instance, path, { secret: this.secret, timeoutMs: 20_000 })
  }

  async patchAccount(instanceId, accountId, patch = {}) {
    const instance = this.instance(instanceId)
    if (!instance) throw new Error('gateway instance not found')
    return request(instance, `/internal/v1/accounts/${accountId}`, {
      method: 'PATCH',
      body: patch,
      secret: this.secret,
      timeoutMs: this.timeoutMs,
    })
  }

  async oauthStart(instanceId, body = {}) {
    const instance = this.instance(instanceId)
    if (!instance) throw new Error('gateway instance not found')
    return request(instance, '/internal/v1/oauth/start', {
      method: 'POST',
      body,
      secret: this.secret,
      timeoutMs: this.timeoutMs,
    })
  }

  async oauthComplete(instanceId, body = {}) {
    const instance = this.instance(instanceId)
    if (!instance) throw new Error('gateway instance not found')
    return request(instance, '/internal/v1/oauth/complete', {
      method: 'POST',
      body,
      secret: this.secret,
      timeoutMs: 60_000,
    })
  }

  async projectAccount(instanceId, account = {}) {
    const instance = this.instance(instanceId)
    if (!instance) throw new Error('gateway instance not found')
    return request(instance, '/internal/v1/accounts/project', {
      method: 'POST',
      body: account,
      secret: this.secret,
      timeoutMs: this.timeoutMs,
    })
  }

  async exportAccount(instanceId, accountId) {
    const instance = this.instance(instanceId)
    if (!instance) throw new Error('gateway instance not found')
    return request(instance, `/internal/v1/accounts/${encodeURIComponent(accountId)}/export`, {
      secret: this.secret,
      timeoutMs: 30_000,
    })
  }

  // 运营导出账号文件：明文原生与 BPS 授权令牌（调用方负责审计）
  async accountCredentials(instanceId, accountId) {
    const instance = this.instance(instanceId)
    if (!instance) throw new Error('gateway instance not found')
    return request(instance, `/internal/v1/accounts/${encodeURIComponent(accountId)}/credentials`, {
      secret: this.secret,
      timeoutMs: 30_000,
    })
  }

  async importAccount(instanceId, accountId, account = {}) {
    const instance = this.instance(instanceId)
    if (!instance) throw new Error('gateway instance not found')
    return request(instance, `/internal/v1/accounts/${encodeURIComponent(accountId)}/import`, {
      method: 'POST',
      body: account,
      secret: this.secret,
      timeoutMs: 30_000,
    })
  }

  async replayReceipts(instanceId) {
    const instance = this.instance(instanceId)
    if (!instance) throw new Error('gateway instance not found')
    return request(instance, '/internal/v1/receipts/replay', { secret: this.secret, timeoutMs: 30_000 })
  }

  async cancel(instanceId, dispatchId) {
    const instance = this.instance(instanceId)
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
    const instance = this.instance(instanceId)
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
    const instance = this.instance(instanceId)
    if (!instance) throw new Error('gateway instance not found')
    return request(instance, '/internal/v1/ws/frame', {
      method: 'POST',
      body: { connection_key: connectionKey, frame },
      secret: this.secret,
      timeoutMs: this.timeoutMs,
    })
  }

  async wsClose(instanceId, connectionKey) {
    const instance = this.instance(instanceId)
    if (!instance) throw new Error('gateway instance not found')
    return request(instance, '/internal/v1/ws/close', {
      method: 'POST',
      body: { connection_key: connectionKey },
      secret: this.secret,
      timeoutMs: this.timeoutMs,
    })
  }

  async ackReceipt(instanceId, dispatchId, receiptId = null) {
    const instance = this.instance(instanceId)
    if (!instance) throw new Error('gateway instance not found')
    return request(instance, '/internal/v1/receipts/ack', {
      method: 'POST',
      body: { dispatch_id: dispatchId, receipt_id: receiptId },
      secret: this.secret,
      timeoutMs: this.timeoutMs,
    })
  }

  // 画像预览、发布状态与隐私规则预览：只读试运行，不发送上游请求
  async internal(instanceId, path, { method = 'GET', body = null } = {}) {
    const instance = this.instance(instanceId)
    if (!instance) throw new Error('gateway instance not found')
    return request(instance, path, { method, body, secret: this.secret, timeoutMs: this.timeoutMs })
  }

  async control(instanceId, action, body = {}) {
    const instance = this.instance(instanceId)
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
      this.repo.upsertInstance({
        ...instance,
        ...(data.id ? { id: data.id } : {}),
        ...(data.boot_id ? { boot_id: data.boot_id } : {}),
        ...(data.version ? { version: data.version } : {}),
        ...(data.protocol_version ? { protocol_version: data.protocol_version } : {}),
        ...(data.health_state ? { health_state: data.health_state } : { health_state: 'healthy' }),
        ...(data.drain_state ? { drain_state: data.drain_state } : {}),
        ...(data.drain_deadline !== undefined ? { drain_deadline: data.drain_deadline } : {}),
        ...(data.active_concurrency !== undefined ? { active_concurrency: data.active_concurrency } : {}),
        last_heartbeat_at: new Date().toISOString(),
      })
      this.repo.setDrain(instanceId, action === 'drain', data.drain_deadline || null)
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
    const instance = this.instance(instanceId)
    if (!instance) throw Object.assign(new Error('gateway instance not found'), { code: 'gateway_instance_not_found' })
    const nonce = crypto.randomUUID()
    const dispatchId = this.repo.createDispatch({
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
        this.repo.markDispatch(dispatchId, 'cancelled', { sent_at: new Date().toISOString() })
        throw Object.assign(error, { dispatch_id: dispatchId, send_state: 'cancelled' })
      }
      // 建连阶段失败（拒绝连接、DNS、本地 TLS 配置）说明 Worker 没有收到请求，可换实例
      const notSent = PRE_SEND_ERRORS.has(error?.code)
      this.repo.markDispatch(dispatchId, notSent ? 'failed' : 'ambiguous', { sent_at: new Date().toISOString() })
      throw Object.assign(error, { dispatch_id: dispatchId, send_state: notSent ? 'not_sent' : 'ambiguous' })
    }
    if (!stream) {
      this.repo.markDispatch(dispatchId, result.ok ? 'completed' : 'failed', { sent_at: new Date().toISOString() })
      return { ...result, dispatch_id: dispatchId }
    }
    this.repo.markDispatch(dispatchId, result.ok ? 'streaming' : 'failed', { sent_at: new Date().toISOString() })
    return { ...result, dispatch_id: dispatchId, stream: true }
  }

  // Live hangup：同一调用方随时可挂断（Worker 只复验调用方，不要求 sideband 认领）
  async liveHangup(instanceId, payload) {
    const instance = this.instance(instanceId)
    if (!instance) throw Object.assign(new Error('gateway instance not found'), { code: 'gateway_instance_not_found' })
    return request(instance, '/internal/v1/live/hangup', {
      method: 'POST',
      body: payload,
      secret: this.secret,
      raw: true,
    })
  }

  // Live sideband：签名参数放在 X-Kin-Gateway-Live 头（Body-Sha256 对它计算），返回连到 Worker 的 WebSocket
  liveSideband(instanceId, payload) {
    const instance = this.instance(instanceId)
    if (!instance) throw Object.assign(new Error('gateway instance not found'), { code: 'gateway_instance_not_found' })
    // 非 ASCII 转义为 \uXXXX，保证参数能放进 HTTP 头
    const blob = JSON.stringify(payload).replace(
      /[\u0080-\uffff]/g,
      (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
    )
    const target = new URL('/internal/v1/live/sideband', instance.base_url)
    target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:'
    const headers = {
      'x-kin-gateway-live': blob,
      ...buildGatewayHeaders({ secret: this.secret, body: blob, keyId: instance.key_id || 'default' }),
    }
    return new WebSocket(target, payload.subprotocols || [], {
      headers,
      handshakeTimeout: 20_000,
      perMessageDeflate: false,
      ...(target.protocol === 'wss:' ? tlsOptions(instance) || {} : {}),
    })
  }
}
