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

function isClientAbort(req, error) {
  if (req?.aborted === true) return true
  const code = String(error?.code || '').toUpperCase()
  return code === 'ECONNRESET' || code === 'ABORT_ERR' || code === 'ERR_STREAM_PREMATURE_CLOSE'
}

function collectBody(req, maxBytes, { timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    let timer = null
    const clearTimer = () => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    }
    const armTimer = () => {
      clearTimer()
      const wait = Math.max(0, Number(timeoutMs) || 0)
      if (!wait) return
      timer = setTimeout(() => {
        fail(
          makeError({
            type: ErrorType.TIMEOUT,
            code: ErrorCode.REQUEST_TIMEOUT,
            message: 'Request body upload timed out',
            status: 408,
            details: { timeout_ms: wait, received_bytes: size },
          }),
        )
      }, wait)
    }
    const fail = (error) => {
      if (settled) return
      settled = true
      clearTimer()
      req.removeAllListeners('data')
      req.on('data', () => {})
      req.resume()
      reject(error)
    }
    armTimer()
    req.on('data', (c) => {
      if (settled) return
      armTimer()
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
      clearTimer()
      resolve(Buffer.concat(chunks))
    })
    req.on('aborted', () => {
      fail(
        makeError({
          type: ErrorType.TIMEOUT,
          code: ErrorCode.CLIENT_CANCELLED,
          message: 'Client closed the connection',
          status: 499,
        }),
      )
    })
    req.on('error', (e) => {
      if (isClientAbort(req, e)) {
        fail(
          makeError({
            type: ErrorType.TIMEOUT,
            code: ErrorCode.CLIENT_CANCELLED,
            message: 'Client closed the connection',
            status: 499,
          }),
        )
        return
      }
      fail(
        makeError({
          type: ErrorType.API,
          code: 'request_stream_error',
          message: String(e.message || e),
          status: 400,
        }),
      )
    })
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

// Node 22 can silently accept incomplete zstd frames. Check framing before
// native decoding; leave block contents and checksums to zlib. Remove this
// guard when all supported runtimes reject truncated frames themselves.
// Format: https://github.com/facebook/zstd/blob/dev/doc/zstd_compression_format.md
function requireCompleteZstdFrames(buf) {
  let offset = 0
  const take = (size) => {
    const start = offset
    offset += size
    if (offset > buf.length) throw new Error('Truncated zstd frame')
    return start
  }
  if (!buf.length) throw new Error('Missing zstd frame')
  while (offset < buf.length) {
    const magic = buf.readUInt32LE(take(4))
    if (magic >= 0x184d2a50 && magic <= 0x184d2a5f) {
      take(buf.readUInt32LE(take(4)))
      continue
    }
    if (magic !== 0xfd2fb528) throw new Error('Invalid zstd frame')
    const descriptor = buf[take(1)]
    if (descriptor & 8) throw new Error('Reserved zstd frame bit')
    const singleSegment = (descriptor & 32) !== 0
    const contentSizeFlag = descriptor >>> 6
    take(singleSegment ? 0 : 1)
    take([0, 1, 2, 4][descriptor & 3])
    take(contentSizeFlag ? 2 ** contentSizeFlag : singleSegment ? 1 : 0)
    let lastBlock = false
    do {
      const header = buf.readUIntLE(take(3), 3)
      lastBlock = (header & 1) !== 0
      const type = (header >>> 1) & 3
      if (type === 3) throw new Error('Reserved zstd block type')
      take(type === 1 ? 1 : header >>> 3)
    } while (!lastBlock)
    if (descriptor & 4) take(4)
  }
}

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
      if (encoding === 'zstd') requireCompleteZstdFrames(buf)
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

export function readBody(req, maxBytes, options = {}) {
  return collectBody(req, maxBytes, options).then(async (encoded) => {
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

export function readRawBody(req, maxBytes, options = {}) {
  return collectBody(req, maxBytes, options)
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

  const bodyTimeoutMs = cfg?.limits?.request_body_timeout_ms
  const configuredReadBody = (req, maxBytes) => readBody(req, maxBytes, { timeoutMs: bodyTimeoutMs })
  const configuredReadRawBody = (req, maxBytes) => readRawBody(req, maxBytes, { timeoutMs: bodyTimeoutMs })
  return { json, writeSSEHeaders, readBody: configuredReadBody, readRawBody: configuredReadRawBody, corsHeaders }
}
