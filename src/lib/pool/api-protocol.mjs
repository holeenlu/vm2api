import { createUsageEvidence } from '../protocol/usage-evidence.mjs'
import { createStreamTiming } from '../protocol/stream-timing.mjs'
import { keyScopeFromRequest, keyAllowsModel } from '../admin/key-scope.mjs'
import { OFFICIAL_CLAUDE_CLI_UA } from '../identity/vm-identity.mjs'
import { isBillingText, isOfficialIdentityText } from '../identity/official-profiles.mjs'
import { restoreToolNamesInSSELine } from '../protocol/anthropic-policy.mjs'
import { officialMessagesBody } from '../protocol/anthropic-messages.mjs'
import { prepareClassifierBody } from '../protocol/request-purpose.mjs'
import { isCompleteAssistantMessage, mapUpstreamError } from '../core/errors.mjs'
import { isContentPolicyErrorCode } from '../core/refusal-guard.mjs'
import { forwardApi, readApiJson } from '../transport/api-kernel-client.mjs'
import { messagesUrl, normalizeProtocol, resolvePreset, responsesUrl, upstreamAuthHeaders } from './api-presets.mjs'
import { claudeToOpenAIResponsesRequest } from './api-openai.mjs'
import {
  assembleCodexBodyFromSse,
  codexBodyToAnthropicMessage,
  createAnthropicSseState,
  createChatSseState,
  responsesSseToAnthropicEvents,
  isToolArgumentsError,
  responsesSseToChatChunk,
  stripCodexIdentity,
  chatToCodexResponses,
} from '../protocol/codex-convert.mjs'
import { BETA_CLAUDE_CODE, BETA_CONTEXT_1M } from '../protocol/claude-code-betas.mjs'
import { stripCacheScopeFields } from '../protocol/cache-ttl.mjs'
import { shouldPassContext1mByPolicy } from '../protocol/model-policy.mjs'
import { upstreamPathForLog } from '../protocol/log-fields.mjs'

export function resolveInferenceBackend(req) {
  if (req?.apiKeyKind !== 'managed') return 'oauth'
  if (req.apiKeyRecord?.group_id) return keyScopeFromRequest(req).allowed_endpoints?.length ? 'api' : 'oauth'
  return String(req.apiKeyRecord?.category || '')
    .trim()
    .toLowerCase() === 'api'
    ? 'api'
    : 'oauth'
}

export { messagesUrl, responsesUrl } from './api-presets.mjs'

const STATELESS_RESPONSES_FIELDS = new Set([
  'model',
  'input',
  'instructions',
  'max_output_tokens',
  'max_tool_calls',
  'parallel_tool_calls',
  'reasoning',
  'text',
  'tool_choice',
  'tools',
  'truncation',
  'temperature',
  'top_p',
  'stream',
  'stream_options',
  'store',
  'metadata',
  'service_tier',
  'user',
  'safety_identifier',
  'prompt_cache_key',
  'prompt_cache_retention',
  'include',
])
const STATELESS_OPENAI_TOOLS = new Set(['function', 'custom', 'web_search', 'web_search_preview', 'image_generation'])

// Endpoint credentials are shared across managed keys; never resolve caller-supplied account resources.
export function validateApiOpenAIRequest(protocol, body = {}) {
  if (!['openai.responses', 'openai.chat'].includes(protocol)) return null
  const invalid = (field) => ({
    code: 'api_shared_resource_forbidden',
    message: `Shared API endpoints require stateless input; unsupported field or resource: ${field}`,
  })
  if (protocol === 'openai.responses') {
    for (const field of Object.keys(body)) {
      if (!STATELESS_RESPONSES_FIELDS.has(field)) return invalid(field)
    }
  }
  if (body.tools != null && !Array.isArray(body.tools)) return invalid('tools')
  for (const tool of body.tools || []) {
    if (!STATELESS_OPENAI_TOOLS.has(tool?.type)) return invalid('tools.type')
  }
  const pending = [body.input]
  for (const tool of body.tools || []) {
    if (!['function', 'custom'].includes(tool.type)) pending.push(tool)
  }
  while (pending.length) {
    const value = pending.pop()
    if (!value || typeof value !== 'object') continue
    if (Array.isArray(value)) {
      for (const child of value) pending.push(child)
      continue
    }
    if (value.type === 'item_reference' || (value.id && !value.type && !value.role))
      return invalid('input.item_reference')
    for (const [field, child] of Object.entries(value)) {
      if (['file_id', 'file_ids', 'vector_store_ids', 'container', 'server_url'].includes(field)) return invalid(field)
      pending.push(child)
    }
  }
  return null
}

function joinHeaderMap(headers = {}) {
  const out = {}
  for (const [k, v] of Object.entries(headers)) {
    if (v == null || v === '') continue
    out[k] = String(v)
  }
  return out
}

/**
 * Native Anthropic Messages is a compatibility boundary.  Keep protocol
 * headers supplied by the caller, including beta names this gateway does not
 * know yet.  Headers the operator configured on the endpoint win; anthropic-beta
 * is the union of endpoint and caller tokens so neither opt-in is dropped.
 */
function forwardAnthropicProtocolHeaders(headers = {}, protocol = '', protocolKind = '', { passthrough = false } = {}) {
  if (protocol !== 'anthropic.messages' || protocolKind !== 'anthropic') return {}
  const out = {}
  for (const [rawName, rawValue] of Object.entries(headers || {})) {
    const name = String(rawName || '').toLowerCase()
    if (name === 'user-agent' && !passthrough) continue
    if (
      !name.startsWith('anthropic-') &&
      !name.startsWith('x-claude-code-') &&
      !name.startsWith('x-stainless-') &&
      name !== 'x-app' &&
      name !== 'x-client-request-id' &&
      name !== 'user-agent' &&
      name !== 'accept-language' &&
      name !== 'sec-fetch-mode'
    )
      continue
    if (rawValue == null || rawValue === '') continue
    out[name] = Array.isArray(rawValue) ? rawValue.join(',') : String(rawValue)
  }
  return out
}

function splitBetas(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Console personal / service-account keys (`sk-ant-usr-`, `sk-ant-svc-`) are
 * plain x-api-key keys, but Anthropic bills a request as Claude Code usage —
 * which their API credit does not cover ("credit balance is too low") —
 * whenever it carries a Claude Code entrypoint marker. Verified 2026-11-04,
 * each marker alone: the `claude-code-20250219` beta; a `cli` /
 * `claude-desktop-3p` user-agent or billing-header entrypoint (`sdk-cli` /
 * `sdk-ts` pass); a system block that is exactly the Claude Code / Agent SDK
 * identity line (the same text inside a longer block passes). Other betas,
 * x-app, x-stainless-*, metadata and streaming do not matter.
 */
export function apiBilledConsoleKey(apiKey) {
  return /^sk-ant-(usr|svc)-/.test(String(apiKey || ''))
}

/**
 * Remove those markers from a Messages body without changing what the model
 * reads: the billing-header block (attribution metadata) is dropped, and a
 * standalone identity block is folded into the next text block, which keeps
 * the earliest cache breakpoint. An identity block with no text after it is
 * dropped.
 */
export function withoutClaudeCodeAttribution(body) {
  const system = body?.system
  if (typeof system === 'string') {
    if (isBillingText(system) || isOfficialIdentityText(system)) {
      const { system: _drop, ...rest } = body
      return rest
    }
    return body
  }
  if (!Array.isArray(system)) return body
  const out = []
  let pending = null
  for (const block of system) {
    const text = block?.type === 'text' && typeof block.text === 'string' ? block.text : null
    if (text != null && isBillingText(text)) continue
    if (text != null && isOfficialIdentityText(text)) {
      pending = pending
        ? {
            ...pending,
            text: `${pending.text}\n\n${text.trim()}`,
            cache_control: pending.cache_control || block.cache_control,
          }
        : { text: text.trim(), cache_control: block.cache_control }
      continue
    }
    if (pending && text != null) {
      const merged = { ...block, text: `${pending.text}\n\n${text}` }
      if (pending.cache_control && !block.cache_control) merged.cache_control = pending.cache_control
      out.push(merged)
      pending = null
      continue
    }
    out.push(block)
  }
  if (out.length === system.length && !pending) return body
  if (!out.length) {
    const { system: _drop, ...rest } = body
    return rest
  }
  return { ...body, system: out }
}

/** Caller context-1m follows the model-page 1M policy, same as the slot path. */
function callerBetaTokens(value, model, apiKey = '') {
  let tokens = splitBetas(value)
  if (apiBilledConsoleKey(apiKey)) tokens = tokens.filter((t) => t !== BETA_CLAUDE_CODE)
  if (!tokens.includes(BETA_CONTEXT_1M) || shouldPassContext1mByPolicy(model)) return tokens
  return tokens.filter((t) => t !== BETA_CONTEXT_1M)
}

function mergeCallerProtocolHeaders(base = {}, caller = {}, configured = {}, model = '', apiKey = '') {
  const out = { ...base }
  const configuredNames = new Set(Object.keys(configured).map((k) => k.toLowerCase()))
  for (const [name, value] of Object.entries(caller)) {
    const existing = Object.keys(out).filter((k) => k.toLowerCase() === name)
    if (name === 'anthropic-beta') {
      const merged = new Set([
        ...existing.flatMap((k) => splitBetas(out[k])),
        ...callerBetaTokens(value, model, apiKey),
      ])
      for (const k of existing) delete out[k]
      if (merged.size) out[name] = [...merged].join(',')
      continue
    }
    if (configuredNames.has(name)) continue
    for (const k of existing) delete out[k]
    out[name] = value
  }
  return out
}

async function readLines(stream, onLine) {
  let buf = ''
  let receivedAt = null
  for await (const chunk of stream) {
    receivedAt = Date.now()
    buf += chunk.toString('utf8')
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      await onLine(line, receivedAt)
    }
  }
  if (buf) await onLine(buf, receivedAt)
}

function openAIResponsesSseEvent(line) {
  const raw = String(line || '').trim()
  if (!raw.startsWith('data:')) return null
  const payload = raw.slice(5).trim()
  if (!payload || payload === '[DONE]') return null
  try {
    return JSON.parse(payload)
  } catch {
    return null
  }
}

function openAIResponsesItemHasOutput(item) {
  if (!item || typeof item !== 'object') return false
  if (item.arguments || item.input || item.result || item.encrypted_content) return true
  for (const value of [item.content, item.summary]) {
    if (!Array.isArray(value)) continue
    if (
      value.some(
        (part) =>
          part &&
          typeof part === 'object' &&
          (part.text || part.transcript || part.arguments || part.input || part.result || part.encrypted_content),
      )
    )
      return true
  }
  return false
}

/** Lifecycle events are transport metadata, not downstream model output. */
export function isOpenAIResponsesCommitEvent(event) {
  if (!event || typeof event !== 'object') return false
  const type = String(event.type || '').trim()
  if (
    !type ||
    type === 'error' ||
    type === 'response.failed' ||
    type === 'response.created' ||
    type === 'response.queued' ||
    type === 'response.in_progress' ||
    type === 'response.metadata' ||
    type === 'keepalive'
  )
    return false
  if (type === 'response.output_item.added' || type === 'response.output_item.done')
    return openAIResponsesItemHasOutput(event.item)
  if (
    type === 'response.content_part.added' ||
    type === 'response.content_part.done' ||
    type === 'response.reasoning_summary_part.added' ||
    type === 'response.reasoning_summary_part.done'
  )
    return !!(event.part?.text || event.part?.transcript)
  if (type === 'response.function_call_arguments.done') return !!event.arguments
  if (type === 'response.custom_tool_call_input.done') return !!event.input
  if (type === 'response.image_generation_call.partial_image') return !!event.partial_image_b64
  return type.startsWith('response.output_') || (type.startsWith('response.') && /\.(delta|done)$/.test(type))
}

function openAIResponsesFailure(event) {
  if (!event || typeof event !== 'object') return null
  if (event.type === 'error') return event
  if (event.type !== 'response.failed') return null
  return {
    type: 'error',
    error: event.response?.error || event.error || { type: 'server_error', message: 'Response failed' },
  }
}

function mappedOpenAIResponsesFailure(resultBase, event, committed, extras = {}) {
  const declared = Number(event?.error?.status || event?.status)
  const mapped = mapUpstreamError(declared >= 400 && declared < 600 ? declared : 500, event)
  return {
    ...resultBase,
    ...mapped,
    ok: false,
    terminalState: committed ? 'incomplete' : 'rejected',
    committed,
    ...extras,
  }
}

/** Restore client tool names before either upstream protocol is assembled or converted. */
function restoreApiToolNames(line, reverse) {
  if (!Object.keys(reverse).length || !String(line).startsWith('data:')) return line
  const restored = restoreToolNamesInSSELine(line, reverse)
  let event
  try {
    event = JSON.parse(String(restored).slice(5).trim())
  } catch {
    return restored
  }
  const restoreItem = (item) => {
    if (['function_call', 'custom_tool_call'].includes(item?.type) && reverse[item.name]) {
      item.name = reverse[item.name]
    }
  }
  restoreItem(event.item)
  for (const item of event.response?.output || []) restoreItem(item)
  return `data: ${JSON.stringify(event)}`
}

export async function runApiInference({
  req,
  res,
  cfg,
  scheduler,
  picked: selected = null,
  store,
  protocol,
  inbound,
  convertedBody,
  clientStream,
  deliveryMode,
  signal,
  timeoutMs,
  personaHideTokens,
  cacheTtl,
  converters,
  requestContext = null,
  passthrough = false,
  toolNames = {},
} = {}) {
  const canonical = officialMessagesBody(convertedBody)
  const model = canonical.model
  const scope = keyScopeFromRequest(req)
  if (!keyAllowsModel(scope, inbound?.model || model))
    return {
      ok: false,
      status: 403,
      terminalState: 'rejected',
      body: { error: { type: 'permission_error', code: 'model_forbidden', message: '当前分组无权调用该模型' } },
    }
  // handle-protocol 已在 Key 授权范围内选好端点；直接调用时仍按同一范围挑选
  const picked = selected || scheduler.pick(model, Date.now(), scope.platform ? null : scope.allowed_endpoints)
  if (!picked.ok) {
    return {
      ok: false,
      status: picked.code === 'model_not_found' ? 404 : 503,
      via: 'api-kernel',
      body: { type: 'error', error: { type: 'api_error', code: picked.code, message: picked.message } },
      terminalState: 'exhausted',
    }
  }

  const preset = resolvePreset(picked.endpoint.kind, picked.endpoint)
  const protocolKind = normalizeProtocol(picked.endpoint.protocol || preset.protocol, preset.kind)
  const extraHeaders = joinHeaderMap(picked.endpoint.headers)
  const isOpenAI = protocolKind === 'openai'
  if (requestContext && (isOpenAI || picked.upstream_model !== canonical.model)) {
    return {
      ok: false,
      status: 400,
      terminalState: 'rejected',
      body: {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          code: 'classifier_model_incompatible',
          message: 'Classifier requests require the selected Anthropic model without endpoint model substitution.',
        },
      },
    }
  }
  // Claude Code sends `cache_control.scope` (prompt-caching-scope beta); API-key
  // Messages rejects it with `...scope: Extra inputs are not permitted`.
  // OpenAI endpoints receive the caller's Responses body (minus gateway identity fields)
  // or the Chat conversion, never a Claude round-trip, so tool history and reasoning survive.
  const body = isOpenAI
    ? {
        ...(protocol === 'openai.responses'
          ? stripCodexIdentity(inbound)
          : protocol === 'openai.chat'
            ? chatToCodexResponses(inbound)
            : claudeToOpenAIResponsesRequest(canonical)),
        model: picked.upstream_model,
        stream: true,
        store: false,
      }
    : { ...stripCacheScopeFields(canonical), model: picked.upstream_model, stream: true }
  if (isOpenAI && protocol === 'openai.chat') {
    for (const name of ['temperature', 'top_p', 'parallel_tool_calls']) {
      if (inbound?.[name] != null) body[name] = inbound[name]
    }
    if (body.reasoning_effort != null) {
      body.reasoning = { ...body.reasoning, effort: body.reasoning?.effort ?? body.reasoning_effort }
      delete body.reasoning_effort
    }
  }
  // Native Responses and Chat bodies never had tool names rewritten, so there is nothing to restore.
  const upstreamToolNames = isOpenAI && protocol !== 'anthropic.messages' ? {} : toolNames
  if (requestContext) Object.assign(body, prepareClassifierBody(body))
  const consoleKey = !isOpenAI && apiBilledConsoleKey(picked.key.api_key)
  const outboundBody = consoleKey ? withoutClaudeCodeAttribution(body) : body
  // A passed-through Claude Code user-agent names a cli / desktop entrypoint.
  const callerProtocolHeaders = forwardAnthropicProtocolHeaders(req?.headers, protocol, protocolKind, {
    passthrough: passthrough && !consoleKey,
  })
  const authHeaders = upstreamAuthHeaders(protocolKind, picked.key.api_key, {
    ...extraHeaders,
    auth_scheme: picked.endpoint.auth_scheme || extraHeaders.auth_scheme || extraHeaders.anthropic_apikey_auth_scheme,
  })
  if (
    protocolKind === 'anthropic' &&
    (!passthrough || consoleKey) &&
    !Object.keys(authHeaders).some((key) => key.toLowerCase() === 'user-agent')
  ) {
    authHeaders['user-agent'] = OFFICIAL_CLAUDE_CLI_UA
  }
  const headers = mergeCallerProtocolHeaders(
    {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...authHeaders,
    },
    callerProtocolHeaders,
    extraHeaders,
    canonical.model,
    picked.key.api_key,
  )

  let upstream
  const upstreamUrl = isOpenAI ? responsesUrl(preset.base_url) : messagesUrl(preset.base_url)
  if (req?.relayLog) {
    req.relayLog.attempt_count = 1
    req.relayLog.upstream_path = upstreamPathForLog(upstreamUrl)
    req.relayLog.upstream_transport = 'http'
  }
  try {
    upstream = await forwardApi({
      cfg,
      url: upstreamUrl,
      headers,
      body: outboundBody,
      proxyUrl: picked.key.proxy_url,
      signal,
      timeoutMs,
    })
  } catch (error) {
    return {
      ok: false,
      status: 502,
      via: 'api-kernel',
      body: {
        type: 'error',
        error: {
          type: 'api_error',
          code: error.code || 'api_kernel_transport',
          message: String(error.message || error).slice(0, 300),
        },
      },
      terminalState: 'transport_error',
      transportError: true,
    }
  }

  const status = Number(upstream.statusCode) || 502
  if (status === 429 && !picked.endpoint.disable_cooling) {
    const retry = Number(upstream.headers['retry-after'] || 30)
    const until = new Date(Date.now() + Math.max(1, retry) * 1000).toISOString()
    try {
      store.setKeyCooldown(picked.key.id, until)
    } catch {}
    scheduler.reload(store.listRaw())
  }

  const resultBase = {
    ok: status >= 200 && status < 300,
    status,
    via: 'api-kernel',
    vmId: null,
    accountId: picked.key.id,
    endpointId: picked.endpoint.id,
    model: picked.upstream_model,
    headers: { ...upstream.headers },
  }

  if (status >= 400) {
    const payload = await readApiJson(upstream).catch(() => ({}))
    const message = payload?.error?.message || payload?.message || `upstream ${status}`
    const upstreamCode = String(payload?.error?.code || payload?.code || '').trim()
    const contentCode = isContentPolicyErrorCode(upstreamCode) ? upstreamCode.toLowerCase() : ''
    return {
      ...resultBase,
      ok: false,
      body: {
        type: 'error',
        error: {
          ...(requestContext ? payload?.error : {}),
          ...(requestContext && payload?.error?.code ? { upstream_code: payload.error.code } : {}),
          ...(!requestContext && contentCode ? { code: contentCode } : {}),
          type: requestContext ? payload?.error?.type || 'api_error' : 'api_error',
          message: String(message).slice(0, 300),
        },
      },
      terminalState: 'rejected',
    }
  }

  if (isOpenAI) {
    return await runOpenAIResponsesUpstream({
      upstream,
      resultBase,
      protocol,
      inbound,
      clientStream,
      deliveryMode,
      res,
      converters,
      body,
      toolNames: upstreamToolNames,
    })
  }

  const evidence = createUsageEvidence()
  const timing = createStreamTiming()
  let upstreamError = null
  let upstreamStopped = false
  const readUpstreamLines = async (onLine) => {
    try {
      await readLines(upstream, async (line, receivedAt) => {
        const event = evidence.line(line)
        timing.observe(event, receivedAt)
        if (event?.type === 'error')
          upstreamError = {
            ...event,
            error: {
              ...event.error,
              ...(requestContext && event.error?.code ? { upstream_code: event.error.code } : {}),
            },
          }
        if (event?.type === 'message_stop') upstreamStopped = true
        await onLine(restoreApiToolNames(line, toolNames), receivedAt)
      })
    } catch (error) {
      upstreamError = {
        type: 'error',
        error: {
          type: 'api_error',
          code: 'upstream_stream_interrupted',
          status: 502,
          message: String(error.message || 'Upstream stream interrupted').slice(0, 300),
        },
      }
    }
  }
  const upstreamFailure = () => {
    if (!upstreamError && (!requestContext || upstreamStopped)) return null
    const body = upstreamError || {
      type: 'error',
      error: {
        type: 'api_error',
        code: 'upstream_stream_interrupted',
        status: 502,
        message: 'Classifier stream ended before message_stop',
      },
    }
    const declared = Number(body.error?.status)
    const status = declared >= 400 && declared < 600 ? declared : mapUpstreamError(200, body).status
    return {
      ...resultBase,
      ok: false,
      status,
      body,
      headers: {
        ...resultBase.headers,
        ...(body.error?.retry_after ? { 'retry-after': String(body.error.retry_after) } : {}),
      },
      terminalState: 'rejected',
      ...evidence.snapshot(),
      ...timing.snapshot(),
    }
  }

  if (!clientStream) {
    const assembler = converters.createClaudeMessageAssembler()
    let committed = false
    await readUpstreamLines(async (line) => {
      converters.applyClaudeSSELineToMessage(line, assembler)
      if (String(line || '').startsWith('data:')) committed = true
    })
    const failure = upstreamFailure()
    if (failure) return { ...failure, committed: false, ...timing.snapshot() }
    const assembled = assembler.message
    if (!upstreamStopped) {
      return {
        ...resultBase,
        ok: false,
        body: assembled || { type: 'error', error: { message: 'empty api upstream' } },
        ...evidence.snapshot(),
        ...timing.snapshot(),
        terminalState: assembled || committed ? 'incomplete' : 'rejected',
        committed,
        sawMessageStop: false,
      }
    }
    const hop = { body: assembled, stopReason: assembled?.stop_reason, sawMessageStop: true }
    const complete = resultBase.ok && isCompleteAssistantMessage(hop)
    return {
      ...resultBase,
      ok: complete,
      body: assembled || { type: 'error', error: { message: 'empty api upstream' } },
      ...evidence.snapshot(),
      ...timing.snapshot(),
      terminalState: complete ? 'verified' : 'incomplete',
      committed,
      sawMessageStop: true,
    }
  }

  let state
  if (protocol === 'openai.chat')
    state = converters.createOpenAIChatStreamState(inbound.model || body.model, picked.endpoint.id)
  else if (protocol === 'openai.completions')
    state = converters.createOpenAICompletionStreamState(inbound.model || body.model, picked.endpoint.id)
  else if (protocol === 'openai.responses')
    state = converters.createResponsesStreamState(inbound.model || body.model, picked.endpoint.id)

  let committed = false
  let sawStop = false
  const started = Date.now()
  let ttftMs = null
  await readUpstreamLines(async (line) => {
    if (personaHideTokens) line = converters.hidePersonaUsageInSseLine(line, personaHideTokens, cacheTtl) || line
    if (String(line).startsWith('data:') && ttftMs == null) ttftMs = Date.now() - started
    sawStop = upstreamStopped
    if (!committed && String(line).startsWith('data:')) {
      committed = true
      if (protocol === 'anthropic.messages' && !res.headersSent) converters.writeSSEHeaders(res)
    }
    if (protocol === 'anthropic.messages') {
      if (!res.headersSent) converters.writeSSEHeaders(res)
      res.write(String(line).endsWith('\n') ? String(line) : `${line}\n`)
      return
    }
    const writeChunks = (chunks) => {
      if (!chunks.length) return
      if (!res.headersSent) converters.writeSSEHeaders(res)
      for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
    }
    if (protocol === 'openai.chat') writeChunks(converters.claudeSSELineToOpenAIChatChunks(line, state))
    else if (protocol === 'openai.completions')
      writeChunks(converters.claudeSSELineToOpenAICompletionChunks(line, state))
    else writeChunks(converters.claudeSSELineToResponsesEvents(line, state))
  })

  const failure = upstreamFailure()
  if (failure) return { ...failure, committed, ttftMs }

  return {
    ...resultBase,
    ok: resultBase.ok && (deliveryMode !== 'verified' || sawStop),
    terminalState: sawStop ? 'verified' : committed ? 'incomplete' : 'rejected',
    ...evidence.snapshot(),
    committed,
    ttftMs,
  }
}

async function runOpenAIResponsesUpstream({
  upstream,
  resultBase,
  protocol,
  inbound,
  clientStream,
  deliveryMode,
  res,
  converters,
  body,
  toolNames,
}) {
  const chunks = []
  const anthropicSse = protocol === 'anthropic.messages' ? createAnthropicSseState() : null
  const chatSse = createChatSseState()
  let conversionError = null
  let committed = false
  let completed = false
  let sawTerminal = false
  let ttftMs = null
  const evidence = createUsageEvidence()
  let terminalFailure = null
  const pendingLines = []
  const started = Date.now()
  const timing = createStreamTiming(started)

  const writeStreamLine = (raw) => {
    if (!res.headersSent) converters.writeSSEHeaders(res)
    if (protocol === 'openai.responses') {
      res.write(raw.endsWith('\n') ? raw : raw + '\n')
      if (/response\.(completed|done)/.test(raw)) completed = true
      return
    }
    try {
      const mapped =
        protocol === 'anthropic.messages'
          ? responsesSseToAnthropicEvents(raw, anthropicSse)
          : responsesSseToChatChunk(raw, 'codex', chatSse)
      if (mapped) {
        res.write(mapped)
        if (mapped.includes('[DONE]') || mapped.includes('event: message_stop\n')) completed = true
      }
    } catch (error) {
      if (error.code !== 'tool_arguments_mismatch') throw error
      conversionError = { type: 'upstream_protocol_error', code: error.code, message: error.message }
      const payload = JSON.stringify({ error: conversionError })
      res.write(
        protocol === 'anthropic.messages'
          ? 'event: error\ndata: ' + JSON.stringify({ type: 'error', error: conversionError }) + '\n\n'
          : 'data: ' + payload + '\n\ndata: [DONE]\n\n',
      )
    }
  }

  await readLines(upstream, async (line, receivedAt) => {
    line = restoreApiToolNames(line, toolNames)
    const event = openAIResponsesSseEvent(line)
    timing.observe(event, receivedAt)
    evidence.line(line)
    if (conversionError) return
    const raw = String(line || '')
    const failure = openAIResponsesFailure(event)
    if (failure) terminalFailure = failure
    const startsOutput = isOpenAIResponsesCommitEvent(event)
    const completes = event?.type === 'response.completed' || event?.type === 'response.done'
    const wasCommitted = committed
    if ((startsOutput || completes) && ttftMs == null) ttftMs = Date.now() - started
    if (!committed && (startsOutput || completes)) committed = true
    if (!clientStream) {
      chunks.push(raw)
      if (/response\.(completed|done)/.test(raw) || raw.trim() === 'data: [DONE]') sawTerminal = true
      return
    }
    if (!wasCommitted) {
      pendingLines.push(raw)
      if (!committed) return
      for (const pending of pendingLines.splice(0)) writeStreamLine(pending)
      return
    }
    writeStreamLine(raw)
  }).catch((error) => {
    conversionError = {
      type: 'upstream_protocol_error',
      code: 'upstream_stream_interrupted',
      message: String(error.message || error).slice(0, 300),
    }
  })

  if (conversionError)
    return {
      ...resultBase,
      ok: false,
      status: 502,
      body: { error: conversionError },
      terminalState: 'incomplete',
      committed,
      ttftMs,
      ...evidence.snapshot(),
      ...timing.snapshot(),
    }

  if (!clientStream) {
    if (terminalFailure)
      return mappedOpenAIResponsesFailure(resultBase, terminalFailure, committed, {
        ...evidence.snapshot(),
        ...timing.snapshot(),
        ttftMs,
      })
    let assembled
    let outBody
    try {
      assembled = assembleCodexBodyFromSse(chunks, {})
      outBody =
        protocol !== 'openai.responses'
          ? codexBodyToAnthropicMessage(assembled, inbound?.model || body?.model)
          : assembled
    } catch (error) {
      if (!isToolArgumentsError(error)) throw error
      return {
        ...resultBase,
        ok: false,
        status: 502,
        body: { error: { type: 'upstream_protocol_error', code: error.code, message: error.message } },
        terminalState: 'incomplete',
        committed,
        ...evidence.snapshot(),
      }
    }
    const hasBody = !!(assembled && (assembled.output || assembled.id || outBody))
    const complete = resultBase.ok && sawTerminal && hasBody
    return {
      ...resultBase,
      ok: complete,
      body: outBody,
      ...evidence.snapshot(),
      ...timing.snapshot(),
      terminalState: complete ? 'verified' : hasBody ? 'incomplete' : 'rejected',
      committed,
    }
  }
  if (terminalFailure)
    return mappedOpenAIResponsesFailure(resultBase, terminalFailure, committed, {
      ...evidence.snapshot(),
      ...timing.snapshot(),
      ttftMs,
    })
  return {
    ...resultBase,
    ok: resultBase.ok && (deliveryMode !== 'verified' || completed || committed),
    ...evidence.snapshot(),
    terminalState: completed ? 'verified' : committed ? 'incomplete' : 'rejected',
    committed,
    ttftMs,
  }
}
