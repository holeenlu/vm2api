import http from 'node:http'
import { WebSocketServer } from 'ws'
import { codexClientScope } from '../db/repos/codex-response-owners-repo.mjs'
import { gatewayForwardHeaders } from '../gateway-worker/gateway-execution.mjs'

/**
 * Codex Live / Realtime 语音入口（对齐 codex-proxy-rs gateway-api openai/live）：
 *   POST /v1/live、/v1/realtime、/v1/realtime/calls      通话引导（SDP），经 Gateway Worker 选号发往 ChatGPT
 *   GET  /v1/live/{id}、/v1/realtime/calls/{id}          事件 sideband（WebSocket），中继到创建通话的 Worker
 *   GET  /v1/realtime?call_id={id}                       sideband 的 query 形态；无 call_id 的直连 Realtime 不支持
 *   POST /v1/realtime/calls/{id}/hangup                  挂断
 * 翻译、转写、client secrets、旧会话凭据与 SIP 控制返回 501。音频走 WebRTC，不经过网关。
 */

export const DEFAULT_LIVE_MODEL = 'gpt-live-1-codex'
const LIVE_CALL_TTL_MS = 60 * 60_000
const MAX_LIVE_CALLS = 4096

export const LIVE_UNSUPPORTED_PATHS = new Map([
  ['/v1/realtime/translations', 'Realtime translation sessions'],
  ['/v1/realtime/translations/client_secrets', 'Realtime translation sessions'],
  ['/v1/realtime/transcription_sessions', 'Realtime transcription-only sessions'],
  ['/v1/realtime/client_secrets', 'Realtime client secrets'],
  ['/v1/realtime/sessions', 'Legacy realtime session credentials'],
])

export function isLiveCallPath(pathname) {
  return pathname === '/v1/live' || pathname === '/v1/realtime' || pathname === '/v1/realtime/calls'
}

export function liveHangupCallId(pathname) {
  return /^\/v1\/realtime\/calls\/([^/]+)\/hangup$/.exec(pathname)?.[1] || null
}

export function liveSipPath(pathname) {
  return /^\/v1\/realtime\/calls\/[^/]+\/(accept|reject|refer)$/.test(pathname)
}

/** sideband 路径 → {callId, style}；不是 sideband 返回 null。 */
export function liveSidebandTarget(url) {
  let parsed
  try {
    parsed = new URL(url || '/', 'http://local')
  } catch {
    return null
  }
  const live = /^\/v1\/live\/([^/]+)$/.exec(parsed.pathname)
  if (live) return { callId: decodeURIComponent(live[1]), style: 'live' }
  const calls = /^\/v1\/realtime\/calls\/([^/]+)$/.exec(parsed.pathname)
  if (calls) return { callId: decodeURIComponent(calls[1]), style: 'realtime_calls' }
  if (parsed.pathname === '/v1/realtime') {
    const callId = parsed.searchParams.get('call_id')
    return callId ? { callId, style: 'realtime_query' } : { callId: null, style: 'realtime_direct' }
  }
  return null
}

export function liveErrorBody(shape, status, message, code) {
  if (shape === 'live') return { error: message }
  return {
    error: { message, type: status >= 400 && status < 500 ? 'invalid_request_error' : 'api_error', code },
  }
}

export function realtimeUnsupportedBody(capability) {
  return {
    error: {
      message: `Unsupported by Codex OAuth: ${capability}.`,
      type: 'not_supported_error',
      code: 'realtime_capability_not_supported',
    },
  }
}

/** realtime 系模型名归一到 Codex 语音模型；其余模型原样透传。 */
export function codexRealtimeModel(model) {
  const trimmed = typeof model === 'string' ? model.trim() : ''
  const lowered = trimmed.toLowerCase()
  if (
    !lowered ||
    lowered === 'gpt-realtime' ||
    lowered.startsWith('gpt-realtime-') ||
    lowered.includes('realtime-preview')
  )
    return DEFAULT_LIVE_MODEL
  return trimmed
}

function requestedModel(payload) {
  const pick = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null)
  return pick(payload?.session?.model) || pick(payload?.model)
}

function multipartFields(raw, contentType) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '')
  if (!boundary) return null
  const marker = `--${boundary[1] || boundary[2]}`
  const fields = {}
  for (const part of raw.toString('utf8').split(marker)) {
    const [head, ...rest] = part.split('\r\n\r\n')
    const name = /name="([^"]+)"/i.exec(head || '')?.[1]
    if (!name) continue
    fields[name] = rest.join('\r\n\r\n').replace(/\r\n$/, '')
  }
  return fields
}

/**
 * 引导体标准化：JSON 原样（写回归一后的模型）、SDP 文本包装为 {sdp}、multipart 的 sdp+session 重组。
 * 返回 {ok, body(Buffer), contentType, model} 或 {ok:false, status, message}。
 */
export function normalizeLiveCallRequest(raw, contentType) {
  const media = String(contentType || '')
    .split(';')[0]
    .trim()
    .toLowerCase()
  const invalid = (message, status = 400) => ({ ok: false, status, message })
  let payload
  if (media === 'multipart/form-data') {
    const fields = multipartFields(raw, contentType)
    if (!fields?.sdp?.trim()) return invalid('Codex live call request requires an SDP offer.')
    let session = null
    if (fields.session) {
      try {
        session = JSON.parse(fields.session)
      } catch {
        return invalid('Codex live multipart body is invalid.')
      }
    }
    payload = { sdp: fields.sdp, ...(session ? { session } : {}) }
  } else if (media === 'application/sdp' || media === 'text/plain') {
    const sdp = raw.toString('utf8')
    if (!sdp.trim()) return invalid('Codex live call request requires an SDP offer.')
    payload = { sdp }
  } else {
    const model = codexRealtimeModel(requestedModel(safeJson(raw)))
    const parsed = safeJson(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      // 按官方合同：session 存在时写 session.model，否则仅当原文带 model 时改写
      if (parsed.session && typeof parsed.session === 'object') parsed.session.model = model
      else if (Object.hasOwn(parsed, 'model')) parsed.model = model
      return {
        ok: true,
        body: Buffer.from(JSON.stringify(parsed)),
        contentType: contentType || 'application/json',
        model,
      }
    }
    return { ok: true, body: raw, contentType: contentType || 'application/json', model }
  }
  const model = codexRealtimeModel(requestedModel(payload))
  if (payload.session && typeof payload.session === 'object') payload.session.model = model
  return { ok: true, body: Buffer.from(JSON.stringify(payload)), contentType: 'application/json', model }
}

function safeJson(raw) {
  try {
    return JSON.parse(raw.toString('utf8'))
  } catch {
    return null
  }
}

/** 进程内 call → Worker 实例登记（Worker 侧同样只在内存中钉住账号）。 */
export function createLiveCallDirectory() {
  const calls = new Map()
  const sweep = (now) => {
    for (const [id, entry] of calls) if (entry.expiresAt <= now) calls.delete(id)
  }
  return {
    remember(callId, instanceId, clientScope) {
      if (!callId || !instanceId) return
      const now = Date.now()
      sweep(now)
      if (calls.size >= MAX_LIVE_CALLS) calls.delete(calls.keys().next().value)
      calls.set(callId, { instanceId, clientScope, expiresAt: now + LIVE_CALL_TTL_MS })
    },
    lookup(callId) {
      const entry = calls.get(callId)
      if (!entry) return null
      if (entry.expiresAt <= Date.now()) {
        calls.delete(callId)
        return null
      }
      entry.expiresAt = Date.now() + LIVE_CALL_TTL_MS
      return entry
    },
    forget(callId) {
      calls.delete(callId)
    },
  }
}

export function callIdFromLocation(location) {
  const value = String(location || '').trim()
  const valid = (id) => /^[A-Za-z0-9_-]{1,128}$/.test(id)
  if (valid(value)) return value
  const query = /call_id=([^&]+)/.exec(value)?.[1]
  if (query && valid(query)) return query
  const tail = value.split('?')[0].replace(/\/+$/, '').split('/').pop()
  return tail && valid(tail) ? tail : null
}

function writeHttp(socket, status, body) {
  const payload = JSON.stringify(body)
  try {
    socket.write(
      `HTTP/1.1 ${status} ${http.STATUS_CODES[status] || 'Error'}\r\nconnection: close\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`,
    )
  } catch {}
  socket.destroy()
}

/**
 * sideband WebSocket 升级：认证后打开到创建通话的 Worker 的签名 WS，Worker 认领通话并拨上游；
 * 双向原样中继帧，关闭码透传。上游拒绝（含 404/410 通话已结束）按原状态返回。
 */
export function createLiveSidebandHandler({ requireAuth, getGateway, directory }) {
  function handleUpgrade(req, socket, head) {
    const target = liveSidebandTarget(req.url)
    if (!target) return false
    if (target.style === 'realtime_direct') {
      writeHttp(socket, 501, realtimeUnsupportedBody('Direct Realtime WebSocket'))
      return true
    }
    const shape = target.style === 'live' ? 'live' : 'realtime'
    const res = {
      statusCode: 200,
      writeHead(status) {
        this.statusCode = status
      },
      setHeader() {},
      end(data) {
        writeHttp(socket, this.statusCode || 401, safeJson(Buffer.from(String(data || '{}'))) || {})
      },
    }
    if (typeof requireAuth === 'function' && !requireAuth(req, res)) return true
    const gateway = getGateway?.()
    const entry = directory.lookup(target.callId)
    const clientScope = codexClientScope(req)
    if (!gateway || !entry || entry.clientScope !== clientScope) {
      writeHttp(
        socket,
        entry ? 403 : 404,
        liveErrorBody(
          shape,
          entry ? 403 : 404,
          entry ? 'This API key cannot access the voice call.' : 'The voice call was not found or has expired.',
          entry ? 'owner_mismatch' : 'call_not_found',
        ),
      )
      return true
    }
    const subprotocols = String(req.headers['sec-websocket-protocol'] || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
    let upstream
    try {
      upstream = gateway.client.liveSideband(entry.instanceId, {
        call_id: target.callId,
        style: target.style,
        client_scope: clientScope,
        headers: gatewayForwardHeaders(req.headers),
        subprotocols,
      })
    } catch {
      writeHttp(
        socket,
        503,
        liveErrorBody(shape, 503, 'The voice connection could not be established.', 'upstream_unavailable'),
      )
      return true
    }
    upstream.once('unexpected-response', (_request, response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.once('end', () => {
        if (response.statusCode === 404 || response.statusCode === 410) directory.forget(target.callId)
        writeHttp(
          socket,
          response.statusCode || 502,
          safeJson(Buffer.concat(chunks)) ||
            liveErrorBody(
              shape,
              response.statusCode || 502,
              'The voice connection could not be established.',
              'upstream_unavailable',
            ),
        )
      })
    })
    upstream.once('error', () => {
      if (!socket.destroyed && upstream.readyState !== upstream.OPEN)
        writeHttp(
          socket,
          502,
          liveErrorBody(shape, 502, 'The voice connection could not be established.', 'upstream_unavailable'),
        )
    })
    upstream.once('open', () => {
      // 下游只回应上游实际协商的子协议
      const negotiated = upstream.protocol || false
      const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, handleProtocols: () => negotiated })
      wss.handleUpgrade(req, socket, head, (client) => relay(client, upstream))
    })
    return true
  }
  return { handleUpgrade }
}

function relay(client, upstream) {
  const close = (target, code, reason) => {
    try {
      if (target.readyState === target.OPEN)
        target.close(code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1000, reason)
      else target.terminate()
    } catch {}
  }
  client.on('message', (data, binary) => upstream.readyState === upstream.OPEN && upstream.send(data, { binary }))
  upstream.on('message', (data, binary) => client.readyState === client.OPEN && client.send(data, { binary }))
  client.on('ping', (data) => upstream.readyState === upstream.OPEN && upstream.ping(data))
  upstream.on('ping', (data) => client.readyState === client.OPEN && client.ping(data))
  client.once('close', (code, reason) => close(upstream, code, reason))
  upstream.once('close', (code, reason) => close(client, code, reason))
  client.once('error', () => upstream.terminate())
  upstream.once('error', () => client.terminate())
}
