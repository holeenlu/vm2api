import crypto from 'node:crypto'

// Gateway Worker 流式请求的首帧等待保活（对齐 codex-proxy-rs responses/keepalive.rs）：准入后 15 秒
// 仍未拿到 Worker 响应（排队、重试、换号）时提前建立 200 SSE，并每 15 秒写一次 `: keep-alive`；
// 此后 Worker 返回的 HTTP 错误改为流内失败事件，避免客户端或代理按空闲超时断开。15 秒内的
// 鉴权、准入与快速失败仍保留原 HTTP 状态。
export const GATEWAY_SSE_KEEPALIVE_MS = 15_000
const KEEPALIVE_FRAME = ': keep-alive\n\n'

function writable(res) {
  return !(res.writableEnded || res.destroyed)
}

/**
 * @param {{ res: import('node:http').ServerResponse, writeHeaders: (res: any) => void, intervalMs?: number }} opts
 */
export function createGatewayKeepalive({ res, writeHeaders, intervalMs = GATEWAY_SSE_KEEPALIVE_MS }) {
  let committed = false
  let timer = null
  const beat = () => {
    if (!writable(res)) return stop()
    if (!committed) {
      if (res.headersSent) return stop()
      // 与 CPR 一致：关闭中间层缓冲与变换
      res.setHeader?.('cache-control', 'no-cache, no-transform')
      res.setHeader?.('x-accel-buffering', 'no')
      writeHeaders(res)
      committed = true
    }
    res.write(KEEPALIVE_FRAME)
    timer = setTimeout(beat, intervalMs)
    timer.unref?.()
  }
  const stop = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }
  timer = setTimeout(beat, intervalMs)
  timer.unref?.()
  return {
    stop,
    get committed() {
      return committed
    },
  }
}

/** HTTP 错误体投影为 Responses `response.failed` 数据；保留错误扩展字段与重试建议。 */
export function responseFailedFromError(payload, { status = 502, message = '', retryAfter = null } = {}) {
  const raw = payload?.error
  const error =
    raw && typeof raw === 'object'
      ? { ...raw }
      : {
          type: 'server_error',
          code: 'upstream_error',
          message: message || (typeof raw === 'string' ? raw : '') || `Response stream failed (HTTP ${status}).`,
        }
  if (retryAfter) {
    const headers = error.headers && typeof error.headers === 'object' ? { ...error.headers } : {}
    if (!Object.keys(headers).some((name) => name.toLowerCase() === 'retry-after'))
      headers['retry-after'] = String(retryAfter)
    error.headers = headers
  }
  return {
    type: 'response.failed',
    response: { id: `resp_${crypto.randomBytes(12).toString('hex')}`, status: 'failed', error },
    error,
  }
}

/** 已提交保活后交付错误：按调用方协议写失败事件并结束流。 */
export function writeGatewayStreamFailure(res, protocol, payload, opts = {}) {
  if (!writable(res)) return
  const failed = responseFailedFromError(payload, opts)
  if (protocol === 'anthropic.messages') {
    const error = {
      type: failed.error.type === 'server_error' ? 'api_error' : failed.error.type || 'api_error',
      message: failed.error.message || '',
    }
    res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error })}\n\n`)
  } else if (protocol === 'openai.responses') {
    res.write(`event: response.failed\ndata: ${JSON.stringify(failed)}\n\ndata: [DONE]\n\n`)
  } else {
    res.write(`data: ${JSON.stringify({ error: failed.error })}\n\ndata: [DONE]\n\n`)
  }
  res.end()
}
