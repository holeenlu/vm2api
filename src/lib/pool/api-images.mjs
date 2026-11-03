import { once } from 'node:events'
import { keyScopeFromRequest, keyAllowsModel, groupScopeDenial } from '../admin/key-scope.mjs'
import { isImageToolModelEnabled } from '../protocol/gpt-model-policy.mjs'
import { canonicalImageToolModel } from '../protocol/image-tool-models.mjs'
import { consumeClaudeSSEData } from '../protocol/convert.mjs'
import { hasCompleteUsage } from '../protocol/usage-evidence.mjs'
import { forwardApi, readApiJson } from '../transport/api-kernel-client.mjs'
import { resolvePreset, upstreamAuthHeaders } from './api-presets.mjs'

/** Images use the same API key pool and proxy transport as text inference. */
export async function handleApiImages({
  req,
  res,
  kind,
  body,
  cfg,
  scheduler,
  store,
  logBag,
  stats,
  json,
  signal,
  forward = forwardApi,
}) {
  logBag.via = 'api-kernel'
  logBag.stream = body.stream === true
  const reject = (status, code, message) => {
    stats.errors++
    logBag.error_code = code
    logBag.error_message = message
    logBag.final_state = 'rejected'
    return json(res, status, { error: { type: status === 403 ? 'permission_error' : 'api_error', code, message } })
  }
  const model = body.model
  const scope = keyScopeFromRequest(req)
  if (groupScopeDenial(scope) || !keyAllowsModel(scope, model) || !['all', 'openai'].includes(scope.group_type))
    return reject(403, 'model_forbidden', '当前分组无权调用该模型')
  if (isImageToolModelEnabled(model) === false)
    return reject(400, 'model_disabled', `image model '${model}' is disabled by the model service policy`)
  // Filter before picking so a mixed group cannot send Images to an Anthropic endpoint.
  const allowed = scheduler.endpoints
    .filter(
      (ep) =>
        (scope.platform || scope.allowed_endpoints.includes(ep.id)) && resolvePreset(ep.kind, ep).protocol === 'openai',
    )
    .map((ep) => ep.id)
  const picked = scheduler.pick(model, Date.now(), allowed)
  if (!picked.ok) return reject(picked.code === 'model_not_found' ? 404 : 503, picked.code, picked.message)
  if (isImageToolModelEnabled(picked.upstream_model) === false)
    return reject(400, 'model_disabled', 'The mapped image model is disabled by the model service policy')
  const preset = resolvePreset(picked.endpoint.kind, picked.endpoint)
  logBag.account_id = picked.key.id
  logBag.final_account_id = picked.key.id
  logBag.endpoint_id = picked.endpoint.id
  logBag.upstream_model = picked.upstream_model
  logBag.image_model = canonicalImageToolModel(picked.upstream_model) || picked.upstream_model
  logBag.attempt_count = 1
  stats.requests++
  stats.by_route['openai.images'] = (stats.by_route['openai.images'] || 0) + 1
  try {
    const headers = upstreamAuthHeaders('openai', picked.key.api_key, picked.endpoint.headers)
    // Credentials and content framing belong to this hop, never to the client or custom headers.
    for (const name of Object.keys(headers)) {
      if (['authorization', 'x-api-key', 'content-type', 'content-length', 'accept'].includes(name.toLowerCase()))
        delete headers[name]
    }
    Object.assign(headers, {
      authorization: `Bearer ${picked.key.api_key}`,
      'content-type': 'application/json',
      accept: body.stream ? 'text/event-stream' : 'application/json',
    })
    const upstream = await forward({
      cfg,
      url: `${preset.base_url}/v1/images/${kind === 'edits' ? 'edits' : 'generations'}`,
      headers,
      body: { ...body, model: picked.upstream_model },
      proxyUrl: picked.key.proxy_url,
      signal,
      timeoutMs: cfg.limits.upstream_timeout_ms,
    })
    const status = Number(upstream.statusCode) || 502
    logBag.upstream_status = status
    if (status === 429 && !picked.endpoint.disable_cooling) {
      const retry = Number(upstream.headers?.['retry-after'])
      store.setKeyCooldown(
        picked.key.id,
        new Date(Date.now() + (Number.isFinite(retry) && retry > 0 ? retry : 30) * 1000).toISOString(),
      )
      scheduler.reload(store.listRaw())
    }
    if (status < 300 && String(upstream.headers?.['content-type']).includes('text/event-stream')) {
      res.statusCode = status
      res.setHeader('content-type', 'text/event-stream; charset=utf-8')
      res.setHeader('cache-control', 'no-cache')
      const parser = { dataBuf: '' }
      const decoder = new TextDecoder()
      let buffer = ''
      let completed = false
      let failed = false
      const line = (text) => {
        const event = consumeClaudeSSEData(text.replace(/\r$/, ''), parser)
        if (event?.type === 'error' || event?.error) {
          failed = true
          logBag.error_code = event.error?.code || event.code || 'upstream_error'
        }
        if (event?.type === `image_${kind === 'edits' ? 'edit' : 'generation'}.completed`) {
          completed = true
          logBag.image_usage = event.usage || null
          logBag.usage_complete = hasCompleteUsage(event.usage)
        }
      }
      for await (const chunk of upstream) {
        buffer += decoder.decode(chunk, { stream: true })
        if (buffer.length + parser.dataBuf.length > 64 * 1024 * 1024) throw new Error('image stream event too large')
        let end
        while ((end = buffer.indexOf('\n')) !== -1) {
          line(buffer.slice(0, end))
          buffer = buffer.slice(end + 1)
        }
        if (!res.write(chunk)) await once(res, 'drain', { signal })
      }
      buffer += decoder.decode()
      if (buffer) line(buffer)
      line('')
      logBag.final_state = completed && !failed ? 'verified' : 'incomplete'
      if (logBag.final_state !== 'verified') {
        stats.errors++
        logBag.error_code ||= 'upstream_incomplete'
        res.write(
          `event: error\ndata: ${JSON.stringify({ type: 'error', code: logBag.error_code, message: 'Image stream did not complete successfully' })}\n\n`,
        )
      }
      return res.end()
    }
    const payload = await readApiJson(upstream)
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
      return reject(502, 'upstream_invalid_body', 'Images upstream returned an invalid JSON response')
    if (status >= 300 || payload.error) {
      stats.errors++
      logBag.final_state = 'upstream_error'
      logBag.error_code = payload.error?.code || `upstream_${status}`
      return json(res, status >= 300 ? status : 502, payload)
    }
    if (!Array.isArray(payload.data))
      return reject(502, 'upstream_invalid_body', 'Images upstream response is missing image data')
    logBag.final_state = 'verified'
    logBag.image_usage = payload.usage || null
    logBag.usage_complete = hasCompleteUsage(payload.usage)
    return json(res, status, payload)
  } catch (error) {
    logBag.final_state = signal?.aborted ? 'cancelled' : 'upstream_error'
    logBag.error_code = signal?.aborted ? 'client_cancelled' : 'api_kernel_transport'
    stats.errors++
    if (signal?.aborted || res.destroyed) return
    if (res.headersSent) {
      res.write(
        `event: error\ndata: ${JSON.stringify({ type: 'error', code: logBag.error_code, message: 'Images upstream connection failed' })}\n\n`,
      )
      return res.end()
    }
    return json(res, 502, { error: { code: logBag.error_code, message: 'Images upstream connection failed' } })
  }
}
