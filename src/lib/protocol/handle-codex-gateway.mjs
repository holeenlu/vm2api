import { writeWithBackpressure } from './sse-events.mjs'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { isDbOpen, getDb } from '../db/database.mjs'
import { RequestAttemptsRepo } from '../db/repos/request-attempts-repo.mjs'
import { codexResponseOwners, codexClientScope } from '../db/repos/codex-response-owners-repo.mjs'
import { hasCompleteUsage } from './usage-evidence.mjs'
import { isClientStream, fromClaudeToOpenAIChat, fromClaudeToOpenAICompletions } from './convert.mjs'
import { computedUpstreamTransport } from './codex-route.mjs'
import {
  responsesSseToChatChunk,
  responsesSseToAnthropicEvents,
  createAnthropicSseState,
  createChatSseState,
  assembleCodexBodyFromSse,
  codexBodyToAnthropicMessage,
  withChatUrlCitations,
  isToolArgumentsError,
  toCodexResponses,
} from './codex-convert.mjs'
import { gatewayAttempts, recordGatewayAttempts } from '../gateway-worker/gateway-execution.mjs'
import { disjointOpenaiUsage, mergeUsage } from './openai-usage.mjs'
import { applyGatewayUpstream, sessionIdForLog } from './log-fields.mjs'
import { createStreamTiming } from './stream-timing.mjs'
import { createGatewayKeepalive, writeGatewayStreamFailure } from './gateway-keepalive.mjs'
import { codexSettings } from '../executor/settings-store.mjs'
import { commitCodexDelivery, normalizeServiceTier, responseClosed, sessionFrom } from './codex-hop-shared.mjs'
import { markInflightDispatch } from '../admin/billing-inflight.mjs'

async function markInflightDispatchSafe(requestId, instanceId, dispatchId) {
  if (!isDbOpen()) return
  await markInflightDispatch(getDb(), requestId, instanceId, dispatchId)
}

// Codex 请求经 Gateway Worker 执行（分组绑定了 Gateway 账号时）。从 handle-codex 的 Codex 入口拆出：
// 返回值即请求的处理结果；Worker 明确未发出且满足回退条件时返回 gatewayFallbackOutcome，由调用方改走 VM。

// Responses 增量事件行（官方序列化 type 在首位）；type 不在首位时照常解析
const GATEWAY_DELTA_LINE = /^data: ?\{"type":"response\.[a-z_.]*\.delta"/

const GATEWAY_TERMINAL_EVENTS = new Set([
  'response.completed',
  'response.done',
  'response.failed',
  'response.incomplete',
])

const GATEWAY_FALLBACK = Symbol('gateway_fallback')

function gatewayFallbackOutcome(code) {
  return { [GATEWAY_FALLBACK]: true, code }
}

/** Gateway 未发出请求且应改走 VM 时返回回退原因，否则返回 null。 */
export function gatewayFallbackCode(outcome) {
  return outcome?.[GATEWAY_FALLBACK] ? outcome.code : null
}

// Gateway 请求诊断（迁移 092）：Worker 的错误分类、结构化上游错误、续接不可用原因与重试等待写入使用记录。
export function recordGatewayDiagnostics(logBag, headers = {}, payload = null) {
  const category = headers['x-kin-gateway-error-category']
  if (category) logBag.error_kind = category
  const reason = headers['x-kin-gateway-continuation-reason']
  if (reason) logBag.continuation_unavailable_reason = reason
  let upstream = null
  try {
    upstream = headers['x-kin-gateway-upstream-error'] ? JSON.parse(headers['x-kin-gateway-upstream-error']) : null
  } catch {}
  if (!upstream && payload?.error && typeof payload.error === 'object') {
    const { code, type, message, param } = payload.error
    upstream = { code, type, message, param }
  }
  if (upstream) logBag.upstream_error = upstream
  const retryAfter = Number(headers['retry-after'])
  if (Number.isFinite(retryAfter) && retryAfter >= 0) logBag.retry_after_ms = Math.round(retryAfter * 1000)
}

// 流式响应结束后读取 Worker trailer：上游 WS 在终态前断开的关闭码、关闭原因、最后事件与连接退出原因。
function recordGatewayStreamDiagnostic(logBag, result) {
  let diagnostic = null
  try {
    const raw = result.trailers?.()?.['x-kin-gateway-diagnostic']
    diagnostic = raw ? JSON.parse(raw) : null
  } catch {}
  if (!diagnostic || typeof diagnostic !== 'object') return
  if (Number.isInteger(diagnostic.websocket_close_code)) logBag.websocket_close_code = diagnostic.websocket_close_code
  if (typeof diagnostic.connection_exit_reason === 'string')
    logBag.upstream_connection_exit_reason = diagnostic.connection_exit_reason
  logBag.upstream_error = {
    ...(logBag.upstream_error || {}),
    ...(typeof diagnostic.close_reason === 'string' ? { close_reason: diagnostic.close_reason } : {}),
    ...(typeof diagnostic.last_event_type === 'string' ? { last_event_type: diagnostic.last_event_type } : {}),
  }
}

export async function dispatchCodexGateway({
  req,
  res,
  protocol,
  ctx,
  inbound,
  logBag,
  stats,
  json,
  writeSSEHeaders,
  routing,
  codex,
  converted,
  gatewayWorker,
  gatewayKeepaliveMs,
  requestStartedAt,
  gatewayPreviousOwner,
  scheduling,
  vmFallbackReady = null,
}) {
  const requestId = res._kinRequestId || randomUUID()
  const operation = protocol === 'openai.chat' || protocol === 'openai.completions' ? 'chat' : 'responses'
  const scope = {
    group_ids: req.apiKeyRecord?.group_id ? [Number(req.apiKeyRecord.group_id)] : [],
    ...(sessionFrom(req, converted.body).session_id ? { session_id: sessionFrom(req, converted.body).session_id } : {}),
    ...(gatewayPreviousOwner?.runtime_account_id
      ? { runtime_account_id: gatewayPreviousOwner.runtime_account_id }
      : {}),
    ...(gatewayPreviousOwner?.account_resource_id
      ? { account_resource_id: gatewayPreviousOwner.account_resource_id }
      : {}),
  }
  stats.requests++
  stats.by_route[protocol] = (stats.by_route[protocol] || 0) + 1
  // Codex 上游只接受流式 Responses（VM 路径与 CPR 相同）；调用方仍可选择 JSON 或 SSE。
  const gatewayClientStream = isClientStream(inbound || ctx.body, req.headers) && ctx.body?.stream !== false
  const gatewayDecoder = new TextDecoder()
  // 入站 Responses WS：同一连接绑定同一条上游 WS。连接内续接优先原生 previous_response_id，
  // Worker 已失去原连接时改发此处展开的完整历史（replay_body）
  const ws = req.gatewayWs || null
  const nativeWsBody = ws?.nativeBody?.previous_response_id
    ? toCodexResponses('openai.responses', ws.nativeBody, codex.convert)
    : null
  // 原生续接只取增量 input 与 previous_response_id；模型映射、Fast 别名、清洗等顶层处理沿用展开请求的结果，
  // 保证正文模型与选号、计费使用的模型一致
  const gatewayBody = nativeWsBody?.ok
    ? {
        ...converted.body,
        input: nativeWsBody.body.input,
        previous_response_id: nativeWsBody.body.previous_response_id,
        stream: true,
      }
    : { ...converted.body, stream: true }
  // 流式 HTTP 调用方在 Worker 排队、重试期间收到保活（入站 WS 由连接自身保活）
  const gatewayKeepalive =
    gatewayClientStream && !ws
      ? createGatewayKeepalive({ res, writeHeaders: writeSSEHeaders, intervalMs: gatewayKeepaliveMs })
      : null
  // 保活已提交 200 SSE 时，错误改为流内失败事件；否则保留原 HTTP 状态
  const deliverGatewayError = (status, payload) => {
    if (gatewayKeepalive?.committed) {
      writeGatewayStreamFailure(res, protocol, payload, {
        status,
        retryAfter: result?.headers?.['retry-after'] || null,
      })
      return
    }
    // Worker 的重试提示（如全池过载时的 Retry-After: 3）交给调用方；WS 由错误帧 headers 携带
    const retryAfter = result?.headers?.['retry-after']
    if (retryAfter && !res.headersSent) res.setHeader('retry-after', retryAfter)
    // 上游失败响应下发的 turn-state 同样交还客户端，同一 turn 重试时带回（CPR 790f3147）
    const turnState = result?.headers?.['x-codex-turn-state']
    if (turnState && protocol === 'openai.responses' && !res.headersSent) res.setHeader('x-codex-turn-state', turnState)
    return json(res, status, payload)
  }
  let result
  // 调用方在 Worker 返回前取消（HTTP 断开、WS 中断或关闭）：断开到 Worker 的请求，停止其排队、重试与换号
  const gatewayAbort = new AbortController()
  const abortGateway = () => {
    if (!res.writableEnded) gatewayAbort.abort()
  }
  req.once?.('aborted', abortGateway)
  res.once?.('close', abortGateway)
  try {
    result = await gatewayWorker.execute({
      signal: gatewayAbort.signal,
      req,
      scheduling,
      connectionKey: ws?.connectionKey || null,
      preferInstance: ws?.instanceId || null,
      upstreamTransport: computedUpstreamTransport(routing),
      replayBody: nativeWsBody?.ok ? { ...converted.body, stream: true } : null,
      protocol,
      operation,
      model: converted.body?.model || null,
      body: gatewayBody,
      headers: req.headers,
      requestId,
      attemptId: `${requestId}:gateway:1`,
      scope,
    })
  } catch (error) {
    result = {
      ok: false,
      status: error?.status || 503,
      send_state: error?.send_state || 'ambiguous',
      instance_id: error?.instance_id || null,
      dispatch_id: error?.dispatch_id || null,
      body: {
        error: {
          type: 'server_error',
          code: error?.code || 'gateway_worker_unavailable',
          message: error?.message || 'Gateway Worker unavailable',
        },
      },
    }
  } finally {
    gatewayKeepalive?.stop()
    req.off?.('aborted', abortGateway)
    res.off?.('close', abortGateway)
  }
  // 回退条件：Worker 明确未发出、不是 Gateway 续接、调用方尚未收到任何内容、路由未强制 Gateway、
  // 分组绑定了 VM 且其中有能接单的 Codex 槽位（没有时回退只会以 no_codex_vm 结束，原样交付 Worker 的错误）
  if (
    !result.ok &&
    result.send_state === 'not_sent' &&
    !gatewayAbort.signal.aborted &&
    !gatewayPreviousOwner &&
    !nativeWsBody &&
    !ws?.activeGateway &&
    !res.headersSent &&
    !gatewayKeepalive?.committed &&
    String(codexSettings().gateway_worker?.preference || 'auto') !== 'gateway_worker' &&
    (await gatewayWorker.hasVmScope?.(req)) &&
    (vmFallbackReady ? await vmFallbackReady() : true)
  ) {
    result.cancel?.()
    result.release?.()
    stats.requests--
    stats.by_route[protocol] = Math.max(0, (stats.by_route[protocol] || 1) - 1)
    return gatewayFallbackOutcome(
      result.body?.error?.code || result.headers?.['x-kin-gateway-error-category'] || 'gateway_worker_unavailable',
    )
  }
  if (gatewayAbort.signal.aborted && !result.ok) {
    logBag.via = 'gateway-worker'
    logBag.execution_kind = 'gateway_worker'
    logBag.gateway_instance_id = result.instance_id || null
    logBag.dispatch_id = result.dispatch_id || null
    logBag.final_state = 'cancelled'
    logBag.error_code = 'client_cancelled'
    logBag.usage_confidence = 'unknown'
    if (!res.writableEnded) res.end?.()
    return
  }
  logBag.via = 'gateway-worker'
  logBag.execution_kind = 'gateway_worker'
  logBag.gateway_instance_id = result.instance_id || null
  logBag.dispatch_id = result.dispatch_id || null
  // 进程中断时据此把这次请求补入回执对账（审计阶段 1 W2）
  if (req.relayBilling?.request_id && result.dispatch_id)
    void markInflightDispatchSafe(req.relayBilling.request_id, result.instance_id, result.dispatch_id)
  // Worker 内的上游尝试次数（含同号重试与换号）；没有逐次记录但已拿到账号头时至少发出一次
  logBag.attempt_count = gatewayAttempts(result.headers).length || (result.headers?.['x-kin-gateway-account'] ? 1 : 0)
  // Worker 回传实际发往上游的会话 ID（按账号映射后），与 VM 路径的出站 Session 同义
  const outboundSession = sessionIdForLog(result.headers?.['x-kin-gateway-outbound-session'])
  if (outboundSession) logBag.outbound_session_id = outboundSession
  if (ws && result.instance_id) {
    ws.instanceId = result.instance_id
    ws.activeGateway = true
  }
  const runtimeAccountId = result.headers?.['x-kin-gateway-account'] || null
  logBag.account_id = runtimeAccountId
  applyGatewayUpstream(logBag, result.headers)
  const binding =
    runtimeAccountId && result.instance_id
      ? await gatewayWorker.repo.findAccountByRuntime(result.instance_id, runtimeAccountId)
      : null
  logBag.account_resource_id = binding?.account_resource_id || null
  if (binding?.account_resource_id) logBag.vm_id = `gateway:${binding.account_resource_id}`
  logBag.final_state = result.ok ? 'verified' : 'rejected'
  logBag.upstream_status = result.status || 0
  const attemptsRepo = isDbOpen() ? new RequestAttemptsRepo(getDb()) : null
  const gatewayResponseOwners = isDbOpen() ? codexResponseOwners(getDb()) : null
  const gatewayScope = codexClientScope(req)
  const rememberGatewayResponse = async (responseId, credentialRevision = null) => {
    if (!responseId || !gatewayScope || !binding?.account_resource_id) return
    try {
      await gatewayResponseOwners?.remember(gatewayScope, responseId, {
        vmId: `gateway:${binding.account_resource_id}`,
        identity: runtimeAccountId,
        sessionId: sessionFrom(req, converted.body).session_id,
        executionKind: 'gateway_worker',
        gatewayInstanceId: result.instance_id,
        runtimeAccountId,
        credentialRevision,
        accountResourceId: binding.account_resource_id,
      })
    } catch {}
  }
  const credentialRevision = () =>
    Number(result.headers?.['x-kin-gateway-credential-revision'] || 0) || binding?.credential_revision || null
  const recordGatewayAttempt = ({ terminalState, downstreamCommitted, usage = null, errorCode = null }) =>
    recordGatewayAttempts(attemptsRepo, {
      requestId,
      model: converted.body?.model,
      result,
      accountId: runtimeAccountId,
      final: { terminalState, downstreamCommitted, usage, errorCode },
      settingsRevision: scheduling?.settings_revision ?? null,
    })
  if (result.stream && result.body && !result.ok) {
    // 上游拒绝时 Worker 原样返回错误体；读完后按 JSON 交给调用方。
    let text = ''
    try {
      for await (const chunk of Readable.fromWeb(result.body)) text += gatewayDecoder.decode(chunk, { stream: true })
      text += gatewayDecoder.decode()
    } catch {}
    result.release?.()
    let payload = null
    try {
      payload = text ? JSON.parse(text) : null
    } catch {}
    logBag.final_state = 'upstream_error'
    logBag.usage_confidence = 'unknown'
    recordGatewayDiagnostics(logBag, result.headers, payload)
    // Worker 只在拿到上游响应后才回传账号头；没有账号头说明请求未发出。
    logBag.error_code =
      payload?.error?.code || result.headers?.['x-kin-gateway-error-category'] || 'gateway_upstream_error'
    await recordGatewayAttempt({
      terminalState: 'upstream_error',
      downstreamCommitted: false,
      errorCode: logBag.error_code,
    })
    return deliverGatewayError(
      result.status || 502,
      payload || {
        error: {
          type: 'server_error',
          code: 'gateway_upstream_error',
          message: text.slice(0, 500) || 'Gateway Worker upstream error',
        },
      },
    )
  }
  if (result.stream && result.body) {
    let clientGone = false
    let streamFinished = false
    const cancelGateway = () => {
      if (clientGone || streamFinished || !result.dispatch_id || !result.instance_id) return
      clientGone = true
      gatewayWorker.cancel?.(result.instance_id, result.dispatch_id).catch?.(() => {})
    }
    req.once?.('aborted', cancelGateway)
    res.once?.('close', cancelGateway)
    // 上游始终是 Responses SSE；按调用方协议转回 Chat/Completions/Anthropic，非流式调用方组装成 JSON。
    const gatewayAnthropicSse = protocol === 'anthropic.messages' ? createAnthropicSseState() : null
    const gatewayChatSse = createChatSseState('codex')
    const mapLine =
      protocol === 'anthropic.messages'
        ? (line) => responsesSseToAnthropicEvents(line, gatewayAnthropicSse)
        : protocol === 'openai.chat' || protocol === 'openai.completions'
          ? (line) => responsesSseToChatChunk(line, 'codex', gatewayChatSse)
          : null
    if (gatewayClientStream && !res.headersSent) {
      if (mapLine) writeSSEHeaders(res)
      else {
        const passthrough = new Set([
          'content-type',
          'cache-control',
          'x-request-id',
          'x-codex-turn-state',
          'x-ratelimit-limit-requests',
          'x-ratelimit-remaining-requests',
          'x-ratelimit-reset-requests',
        ])
        for (const [key, value] of Object.entries(result.headers || {}))
          if (passthrough.has(key.toLowerCase())) res.setHeader(key, value)
        res.writeHead(result.status || 200)
      }
    }
    const chunks = []
    let streamedUsage = null
    let conversionError = null
    let downstreamCommitted = false
    let sseBuffer = ''
    let terminalSeen = false
    let gatewayStreamFailure = null
    let gatewayServiceTier = null
    // 首字节、首 Token 与生成时间与 VM 路径同一口径（stream-timing.mjs），起点为入站请求
    const gatewayTiming = createStreamTiming(requestStartedAt)
    // 续接归属每个响应 ID 只写一次（created、in_progress、completed 都带同一个 ID）
    const rememberedResponseIds = new Set()
    const onLine = async (line) => {
      // 首个生成内容之后的增量事件（*.delta）不带用量、终态、响应 ID 或模型，不再逐行解析；
      // 每行最多解析一次，用量与档位从同一个事件对象读取
      if (line.startsWith('data:') && !(gatewayTiming.firstTokenSeen() && GATEWAY_DELTA_LINE.test(line))) {
        let event = null
        try {
          event = JSON.parse(line.slice(5).trim())
        } catch {}
        if (event && typeof event === 'object') {
          gatewayTiming.observe(event)
          if (GATEWAY_TERMINAL_EVENTS.has(event.type)) terminalSeen = true
          // 已提交后的流内失败（如上游过载）是失败终态，不能记为成功
          if (event.type === 'response.failed' || event.type === 'error') {
            gatewayStreamFailure = event.response?.error?.code || event.error?.code || 'upstream_error'
            const failure = event.response?.error || event.error
            if (failure && typeof failure === 'object')
              logBag.upstream_error = {
                code: failure.code,
                type: failure.type,
                message: failure.message,
                param: failure.param,
              }
            logBag.error_kind = event.type === 'error' ? 'stream_error' : 'response_failed'
          }
          const id = event.response?.id || event.id
          if (id && !rememberedResponseIds.has(id)) {
            rememberedResponseIds.add(id)
            await rememberGatewayResponse(id, credentialRevision())
          }
          const responseModel = event.response?.model
          if (typeof responseModel === 'string' && responseModel.trim()) logBag.response_model = responseModel.trim()
          const usage = event.response?.usage || event.usage
          if (usage && typeof usage === 'object') streamedUsage = mergeUsage(streamedUsage, usage)
          const tier = normalizeServiceTier(event.response?.service_tier ?? event.service_tier)
          if (tier) gatewayServiceTier = tier
        }
      }
      if (!gatewayClientStream) {
        chunks.push(line)
        return
      }
      if (!mapLine || conversionError) return
      try {
        const mapped = mapLine(line)
        if (mapped) {
          // 客户端读得慢时等 drain 再继续读 Worker 的流（有上限，见 sse-events.mjs，审计阶段 2 W15）
          await writeWithBackpressure(res, mapped)
          downstreamCommitted = true
        }
      } catch (error) {
        if (!isToolArgumentsError(error)) throw error
        conversionError = { type: 'upstream_protocol_error', code: error.code, message: error.message }
        res.write(
          protocol === 'anthropic.messages'
            ? `event: error\ndata: ${JSON.stringify({ type: 'error', error: conversionError })}\n\n`
            : `data: ${JSON.stringify({ error: conversionError })}\n\ndata: [DONE]\n\n`,
        )
      }
    }
    try {
      for await (const chunk of Readable.fromWeb(result.body)) {
        if (responseClosed(res)) {
          result.cancel?.()
          break
        }
        if (gatewayClientStream && !mapLine) {
          await writeWithBackpressure(res, chunk)
          downstreamCommitted = true
        }
        sseBuffer += gatewayDecoder.decode(chunk, { stream: true })
        const lines = sseBuffer.split('\n')
        sseBuffer = lines.pop() || ''
        for (const line of lines) await onLine(line.replace(/\r$/, ''))
      }
      sseBuffer += gatewayDecoder.decode()
      if (sseBuffer) await onLine(sseBuffer.replace(/\r$/, ''))
      recordGatewayStreamDiagnostic(logBag, result)
      if (conversionError) {
        logBag.final_state = 'incomplete'
        logBag.error_code = conversionError.code
      } else if (gatewayStreamFailure) {
        logBag.final_state = 'upstream_error'
        logBag.error_code = String(gatewayStreamFailure)
      } else if (!terminalSeen && !responseClosed(res)) {
        // 上游流在终态事件前结束：不能当作成功，流式调用方要收到错误帧。
        logBag.final_state = 'incomplete'
        logBag.error_code = 'gateway_stream_incomplete'
        logBag.error_message = 'Gateway Worker stream ended before a terminal event'
        if (gatewayClientStream) {
          const error = {
            type: protocol === 'anthropic.messages' ? 'api_error' : 'server_error',
            code: logBag.error_code,
            message: logBag.error_message,
          }
          res.write(
            protocol === 'openai.responses' || protocol === 'anthropic.messages'
              ? `event: error\ndata: ${JSON.stringify({ type: 'error', error })}\n\n`
              : `data: ${JSON.stringify({ error })}\n\ndata: [DONE]\n\n`,
          )
        }
      } else if (!terminalSeen) {
        // 调用方在终态前断开：记为取消，不计费、单独统计。Worker 若已收到终态且回执带完整用量，
        // 仍由对账按实际用量结算（回执终态为 cancelled 时直接记为不计量）
        logBag.final_state = 'cancelled'
        logBag.error_code = 'client_cancelled'
        logBag.gateway_await_receipt = true
      } else logBag.final_state = 'verified'
    } catch (error) {
      logBag.final_state = 'ambiguous'
      logBag.error_code = 'gateway_stream_error'
      logBag.error_message = String(error?.message || error)
    } finally {
      streamFinished = true
      result.release?.()
      const timing = gatewayTiming.snapshot()
      logBag.first_byte_ms = timing.firstByteMs
      logBag.first_token_ms = timing.ttftMs
      logBag.generation_ms = timing.generationMs
    }
    if (streamedUsage) {
      // 计费按实际发送的 service_tier（与 VM 路径相同），上游回显另存
      // Worker 按分组 Fast 策略可能改写档位，以其报告的实际发送档位为准
      const sentTier = result.headers?.['x-kin-gateway-service-tier'] ?? converted.body?.service_tier
      const logged = disjointOpenaiUsage({ ...streamedUsage, service_tier: normalizeServiceTier(sentTier) })
      logBag.usage = logged
      logBag.usage_complete = hasCompleteUsage(logged)
      logBag.usage_confidence = logBag.usage_complete ? 'complete' : 'partial'
      if (gatewayServiceTier) logBag.upstream_service_tier = gatewayServiceTier
    } else logBag.usage_confidence = 'unknown'
    // 与 VM 路径同一契约：upstream_model 是实际发送、用于计价的模型，上游回显只记在 response_model
    logBag.upstream_model = gatewayBody.model || null
    if (!gatewayClientStream && logBag.final_state === 'verified' && !responseClosed(res)) {
      let body
      try {
        const assembled = assembleCodexBodyFromSse(chunks, {})
        body = assembled
        if (protocol !== 'openai.responses') {
          const message = codexBodyToAnthropicMessage(assembled, converted.body.model)
          body =
            protocol === 'openai.chat'
              ? withChatUrlCitations(fromClaudeToOpenAIChat(message, converted.body.model), assembled)
              : protocol === 'openai.completions'
                ? fromClaudeToOpenAICompletions(message, converted.body.model)
                : message
        }
      } catch (error) {
        if (!isToolArgumentsError(error)) throw error
        logBag.error_code = error.code
        logBag.final_state = 'incomplete'
        await recordGatewayAttempt({ terminalState: 'incomplete', downstreamCommitted: false, usage: streamedUsage })
        return json(res, 502, {
          error: { type: 'upstream_protocol_error', code: error.code, message: error.message },
        })
      }
      commitCodexDelivery(req)
      await recordGatewayAttempt({ terminalState: 'verified', downstreamCommitted: true, usage: streamedUsage })
      // 上游 turn-state 交还客户端，同一 turn 的后续请求带回（官方 Core 合同）
      const turnState = result.headers?.['x-codex-turn-state']
      if (turnState && protocol === 'openai.responses') res.setHeader('x-codex-turn-state', turnState)
      return json(res, 200, body)
    }
    if (downstreamCommitted) commitCodexDelivery(req)
    if (!responseClosed(res)) {
      if (!gatewayClientStream && !res.headersSent)
        json(res, 502, {
          error: {
            type: 'server_error',
            code: logBag.error_code || 'gateway_stream_error',
            message: logBag.error_message || 'Gateway Worker stream ended before completion',
          },
        })
      else res.end()
    }
    await recordGatewayAttempt({ terminalState: logBag.final_state, downstreamCommitted, usage: streamedUsage })
    return
  }
  logBag.usage_confidence = 'unknown'
  logBag.final_state = 'upstream_error'
  recordGatewayDiagnostics(logBag, result.headers || {}, result.body)
  logBag.error_code =
    result.body?.error?.code || result.headers?.['x-kin-gateway-error-category'] || 'gateway_worker_unavailable'
  await recordGatewayAttempt({
    terminalState: 'upstream_error',
    downstreamCommitted: false,
    errorCode: logBag.error_code,
  })
  return deliverGatewayError(
    result.status || 503,
    result.body || {
      error: { type: 'server_error', code: 'gateway_worker_unavailable', message: 'Gateway Worker 暂不可用' },
    },
  )
}
