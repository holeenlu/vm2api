/**
 * Shared HTTP helpers for protocol and panel. SSE headers flush immediately
 * and optionally disable Nagle so Claude Code subagent tokens are not delayed.
 */
import * as zlib from 'node:zlib'
import { promisify } from 'node:util'
import { ErrorCode, ErrorType, makeError } from '../core/errors.mjs'
import { CORS_ALLOW_HEADERS, corsHeadersForRequest } from './cors.mjs'

export { CORS_ALLOW_HEADERS } from './cors.mjs'

export function corsHeaders(extra = {}, req = null) {
  return corsHeadersForRequest(req, extra)
}

function requestFromResponse(res) {
  return res?.req || res?._kinReq || null
}

function collectBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      req.removeAllListeners('data')
      req.on('data', () => {})
      req.resume()
      reject(error)
    }
    req.on('data', (c) => {
      if (settled) return
      size += c.length
      if (size > maxBytes) {
        fail(
          makeError({
            type: ErrorType.INVALID_REQUEST,
            code: ErrorCode.BODY_TOO_LARGE,
            message: `Request body exceeds limit of ${maxBytes} bytes`,
            status: 413,
            details: { max_bytes: maxBytes, received: size },
          }),
        )
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks))
    })
    req.on('error', (e) =>
      fail(
        makeError({
          type: ErrorType.API,
          code: 'request_stream_error',
          message: String(e.message || e),
          status: 400,
        }),
      ),
    )
  })
}

const bodyDecoders = new Map(
  [
    ['gzip', zlib.gunzip],
    ['deflate', zlib.inflate],
    ['br', zlib.brotliDecompress],
    ['zstd', zlib.zstdDecompress],
  ]
    .filter(([, decode]) => typeof decode === 'function')
    .map(([name, decode]) => [name, promisify(decode)]),
)

async function decodeBody(buf, contentEncoding, maxBytes) {
  const header = String(contentEncoding || '')
    .trim()
    .toLowerCase()
  if (!header) return buf
  const encodings = header.split(',').map((encoding) => encoding.trim())
  for (const encoding of encodings) {
    if (encoding !== 'identity' && !bodyDecoders.has(encoding)) {
      throw makeError({
        type: ErrorType.INVALID_REQUEST,
        code: 'unsupported_content_encoding',
        message: `Unsupported request Content-Encoding: ${encoding || '(empty)'}`,
        status: 415,
      })
    }
  }
  // Content codings are applied in header order. Bound every decoded layer as
  // well as the wire bytes so a small compressed body cannot bypass the limit.
  for (const encoding of encodings.reverse()) {
    if (encoding === 'identity') continue
    try {
      buf = await bodyDecoders.get(encoding)(buf, { maxOutputLength: maxBytes })
    } catch (error) {
      if (error.code === 'ERR_BUFFER_TOO_LARGE') {
        throw makeError({
          type: ErrorType.INVALID_REQUEST,
          code: ErrorCode.BODY_TOO_LARGE,
          message: `Decoded request body exceeds limit of ${maxBytes} bytes`,
          status: 413,
          details: { max_bytes: maxBytes },
        })
      }
      throw makeError({
        type: ErrorType.INVALID_REQUEST,
        code: 'invalid_content_encoding',
        message: `Request body could not be decoded as ${encoding}`,
        status: 400,
      })
    }
  }
  return buf
}

export function readBody(req, maxBytes) {
  return collectBody(req, maxBytes).then(async (encoded) => {
    const buf = await decodeBody(encoded, req.headers?.['content-encoding'], maxBytes)
    const raw = buf.toString('utf8')
    if (!raw) return {}
    try {
      return JSON.parse(raw)
    } catch (e) {
      throw makeError({
        type: ErrorType.INVALID_REQUEST,
        code: ErrorCode.INVALID_JSON,
        message: 'Request body is not valid JSON: ' + (e.message || 'parse error'),
        status: 400,
        details: { parse_error: String(e.message || e) },
      })
    }
  })
}

/**
 * Node 的 WHATWG URL 会拒绝未加括号的 IPv6、非 ASCII Host、空 Host。
 * 安装探活打的是 127.0.0.1，浏览器若用这类 Host 打开 /cc，旧代码在进路由前就 500。
 * Host 解析失败时仍用路径路由；路径本身非法才返回 null。
 */
export function parseRequestUrl(req) {
  const raw = req?.url || '/'
  const host = String(req?.headers?.host || '').trim()
  const bases = []
  if (host) bases.push(`http://${host}`)
  bases.push('http://127.0.0.1')
  for (const base of bases) {
    try {
      return new URL(raw, base)
    } catch {
      // try the next base
    }
  }
  return null
}

export function readRawBody(req, maxBytes) {
  return collectBody(req, maxBytes)
}

export function applySseSocketTuning(res, { tcpNodelay = true } = {}) {
  if (typeof res.flushHeaders === 'function') {
    try {
      res.flushHeaders()
    } catch {}
  }
  if (tcpNodelay !== false) {
    try {
      res.socket?.setNoDelay?.(true)
    } catch {}
  }
}

export function createRespond(cfg, options = {}) {
  const resolveNodelay = () => {
    if (typeof options.tcpNodelay === 'function') return options.tcpNodelay() !== false
    return options.tcpNodelay !== false
  }

  function json(res, status, body) {
    const data = JSON.stringify(body)
    const headers = corsHeadersForRequest(requestFromResponse(res), {
      'content-type': 'application/json; charset=utf-8',
      'x-kin-rewrite': cfg.rewrite.enabled ? 'on' : 'off',
    })
    if (res._kinRequestId) headers['x-request-id'] = res._kinRequestId
    if (body?.error?.details?.retryable === false) headers['x-should-retry'] = 'false'
    res.writeHead(status, headers)
    res.end(data)
  }

  function writeSSEHeaders(res) {
    const headers = corsHeadersForRequest(requestFromResponse(res), {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-kin-rewrite': cfg.rewrite.enabled ? 'on' : 'off',
    })
    if (res._kinRequestId) headers['x-request-id'] = res._kinRequestId
    res.writeHead(200, headers)
    applySseSocketTuning(res, { tcpNodelay: resolveNodelay() })
  }

  return { json, writeSSEHeaders, readBody, readRawBody, corsHeaders }
}
