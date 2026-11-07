import { Readable } from 'node:stream'
import { createProtocolRes } from './responses-ws.mjs'

// POST /v1/responses/compact（旧版 Codex 远程压缩 v1）：转成带 compaction_trigger 的 Responses 请求
// （与新版 Codex 远程压缩 v2 相同的上游形式，tool_choice=none），
// 走同一套鉴权、选路、计费，再把最终响应改写为压缩结果 { output, usage }。
export function compactResponsesBody(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  let input
  if (Array.isArray(body.input)) input = body.input
  else if (typeof body.input === 'string') input = [{ role: 'user', content: body.input }]
  else return null
  const { previous_response_id: _previous, ...rest } = body
  return {
    ...rest,
    input: [...input.filter((item) => item?.type !== 'compaction_trigger'), { type: 'compaction_trigger' }],
    tool_choice: 'none',
    stream: false,
    store: false,
  }
}

export function compactionResult(response = {}) {
  return {
    id: response.id,
    object: 'response.compaction',
    created_at: response.created_at,
    model: response.model,
    output: Array.isArray(response.output) ? response.output : [],
    ...(response.usage ? { usage: response.usage } : {}),
  }
}

export async function handleResponsesCompact(req, res, { handleProtocol, readBody, json }) {
  let body
  try {
    body = await readBody(req)
  } catch {
    return json(res, 400, {
      error: { type: 'invalid_request_error', code: 'invalid_json', message: 'Invalid JSON body' },
    })
  }
  const next = compactResponsesBody(body)
  if (!next)
    return json(res, 400, {
      error: { type: 'invalid_request_error', code: 'invalid_request', message: 'Compaction requires input' },
    })
  const payload = Buffer.from(JSON.stringify(next))
  const inner = Readable.from([payload])
  Object.assign(inner, {
    method: 'POST',
    url: '/v1/responses',
    httpVersion: '1.1',
    socket: req.socket,
    connection: req.socket,
    complete: false,
    aborted: false,
    headers: { ...req.headers, 'content-type': 'application/json', 'content-length': String(payload.length) },
  })
  delete inner.headers['transfer-encoding']
  inner.abort = () => {
    if (inner.aborted) return
    inner.aborted = true
    inner.emit('aborted')
  }
  req.once('aborted', () => inner.abort())
  res.once('close', () => {
    if (!res.writableEnded) inner.abort()
  })
  const captured = createProtocolRes()
  let text = ''
  captured.on('chunk', (chunk) => {
    text += chunk
  })
  await handleProtocol(inner, captured, 'openai.responses', '/v1/responses')
  if (res.writableEnded || res.destroyed) return
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {}
  const status = captured.statusCode || 502
  for (const name of ['retry-after', 'x-request-id'])
    if (captured._headers[name] != null) res.setHeader(name, captured._headers[name])
  if (status === 200 && parsed && typeof parsed === 'object' && parsed.object === 'response')
    return json(res, 200, compactionResult(parsed))
  if (parsed && typeof parsed === 'object') return json(res, status >= 400 ? status : 502, parsed)
  return json(res, 502, {
    error: { type: 'server_error', code: 'compaction_failed', message: 'Compaction did not return a response' },
  })
}
