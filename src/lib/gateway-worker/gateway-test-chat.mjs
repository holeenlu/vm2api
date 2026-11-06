import crypto from 'node:crypto'
import { isModelEnabled } from '../protocol/model-policy.mjs'
import {
  codexTextInput,
  DEFAULT_CODEX_REASONING_EFFORT,
  normalizeCodexReasoningEffort,
} from '../protocol/codex-convert.mjs'
import { consumeResponsesResponse, isGptTestModel } from '../admin/vm-test-chat.mjs'

const DEFAULT_PROMPT = 'hello'

/**
 * 测试链接（Gateway 账号）：与 VM 槽的 test-chat 同一返回结构。
 * 发一条真实 Responses 对话，Worker 只用该账号执行，验证凭据、代理出口与 Worker 整条链路。
 */
export async function runGatewayAccountTestChat({ service, account, body = {} }) {
  const started = Date.now()
  const log = []
  const push = (level, message) => log.push({ at: new Date().toISOString(), level, message: String(message) })
  const done = (result) => ({ log, duration_ms: Date.now() - started, account_id: account.id, ...result })
  const model = String(body.model || '').trim()
  const prompt = String(body.prompt || DEFAULT_PROMPT).trim() || DEFAULT_PROMPT
  const effort = normalizeCodexReasoningEffort(
    body.reasoning_effort == null || body.reasoning_effort === ''
      ? DEFAULT_CODEX_REASONING_EFFORT
      : body.reasoning_effort,
  )
  push('info', `account=${account.name} model=${model || '—'}`)
  if (!model || !isGptTestModel({ id: model })) {
    push('error', 'Codex 账号只接受 GPT 模型')
    return done({
      ok: false,
      model,
      error: { code: 'model_not_allowed', message: 'Codex accounts only accept GPT models' },
    })
  }
  if (!isModelEnabled(model)) {
    push('error', '模型在策略中已禁用')
    return done({ ok: false, model, error: { code: 'model_disabled', message: 'model disabled by policy' } })
  }
  if (account.status !== 'active') push('info', `账号状态 ${account.status}：Worker 不会调度暂停或归档的账号`)
  const binding = await service.repo.getAccountBinding(account.id)
  if (!binding?.runtime_account_id) {
    push('error', '账号尚未投影到 Gateway Worker')
    return done({
      ok: false,
      model,
      error: { code: 'gateway_account_binding_not_found', message: '账号尚未授权或未同步到 Worker' },
    })
  }
  // 通道：auto 按账号 BPS 模型名单（与线上一致），native 只走原生，bps 只走 BPS（不回退原生）
  const route = ['native', 'bps'].includes(body.route) ? body.route : 'auto'
  const scheduling = {
    ...(route !== 'native' ? { bps_enabled: true } : {}),
    ...(route === 'bps' ? { route_policy: 'bps_only' } : route === 'native' ? { route_policy: 'native_only' } : {}),
  }
  if (body.verify_tools === true)
    return runStrictProbe({ service, account, binding, model, effort, route, scheduling, push, done })
  push('info', `prompt=${JSON.stringify(prompt).slice(0, 120)} effort=${effort || 'none'} route=${route}`)
  const requestId = `kin-test-${crypto.randomUUID()}`
  const inbound = {
    model,
    input: codexTextInput(prompt),
    stream: true,
    store: false,
    ...(effort ? { reasoning: { effort } } : {}),
  }
  let result
  try {
    push('info', 'POST Gateway Worker /internal/v1/execute (responses)')
    result = await service.execute({
      protocol: 'openai.responses',
      operation: 'responses',
      model,
      body: inbound,
      headers: { accept: 'text/event-stream', 'session-id': requestId },
      requestId,
      attemptId: `${requestId}:gateway:1`,
      scheduling,
      scope: { runtime_account_id: binding.runtime_account_id, account_resource_id: account.id },
    })
  } catch (error) {
    push('error', `Worker 请求失败: ${error?.code || error?.message || error}`)
    return done({
      ok: false,
      model,
      status: 0,
      error: {
        code: error?.code || 'gateway_worker_unavailable',
        message: error?.message || 'Gateway Worker 暂不可用',
      },
    })
  }
  if (result.instance_id) push('info', `instance=${result.instance_id} send_state=${result.send_state || '—'}`)
  let parsed
  if (result.stream && result.body) {
    const headers = new Headers(Object.entries(result.headers || {}))
    parsed = await consumeResponsesResponse(new Response(result.body, { status: result.status || 502, headers }))
    result.release?.()
  } else {
    parsed = { ok: false, status: result.status || 503, body: result.body, text: '', usage: null, stop_reason: null }
  }
  const status = parsed.status || result.status || 0
  if (!parsed.ok) {
    const error = parsed.body?.error || {}
    const message = error.message || (typeof error === 'string' ? error : 'upstream error')
    push('error', `HTTP ${status} ${error.code || ''} ${message}`.trim())
    return done({
      ok: false,
      model,
      prompt,
      status,
      error: {
        code: error.code || result.headers?.['x-kin-gateway-error-category'] || 'gateway_upstream_error',
        message,
        status,
      },
      body: parsed.body || null,
      via: 'gateway-worker',
    })
  }
  const authorizationMode = result.headers?.['x-kin-gateway-auth-mode'] || null
  push('ok', `HTTP ${status} · ${parsed.stop_reason || 'completed'} · route=${authorizationMode || '—'}`)
  if (parsed.text) push('content', parsed.text.slice(0, 2000))
  return done({
    ok: true,
    model: parsed.model || model,
    prompt,
    status,
    stop_reason: parsed.stop_reason,
    usage: parsed.usage || null,
    text: (parsed.text || '').slice(0, 4000),
    via: 'gateway-worker',
    credential_mode: 'oauth',
    authorization_mode: authorizationMode,
  })
}

const PROBE_TOOL = 'kin_probe_echo'

/** 读完 Worker 的 Responses SSE：返回状态、终态响应、完成的输出项与正文。 */
async function readProbeStream(result) {
  const status = result.status || 0
  if (!result.stream || !result.body) {
    result.release?.()
    return { ok: false, status: status || 503, body: result.body, items: [], text: '' }
  }
  let raw = ''
  const decoder = new TextDecoder()
  for await (const chunk of result.body)
    raw += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
  result.release?.()
  if (status >= 400) {
    let body = null
    try {
      body = JSON.parse(raw)
    } catch {}
    return { ok: false, status, body, items: [], text: '' }
  }
  const items = []
  let response = null
  let failure = null
  let text = ''
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue
    let event
    try {
      event = JSON.parse(line.slice(5).trim())
    } catch {
      continue
    }
    if (event.type === 'response.output_item.done' && event.item) items.push(event.item)
    else if (event.type === 'response.output_text.delta') text += String(event.delta || '')
    else if (event.type === 'response.completed') response = event.response
    else if (event.type === 'response.failed' || event.type === 'error')
      failure = event.response?.error || event.error || event
  }
  const output = Array.isArray(response?.output) && response.output.length ? response.output : items
  return { ok: !!response && !failure, status, response, failure, items: output, text }
}

/**
 * 严格探测（对齐 sub2api 的 BPS 精确模型探测）：用指定模型、指定通道发起一次真实工具往返——
 * 第一轮要求模型调用回显工具并带上随机 nonce，第二轮回传工具结果并要求文字回复。
 * 校验实际通道、响应模型与请求模型一致、工具调用的 nonce，并把证据写进日志。
 */
async function runStrictProbe({ service, account, binding, model, effort, route, scheduling, push, done }) {
  const nonce = crypto.randomBytes(6).toString('hex')
  const tools = [
    {
      type: 'function',
      name: PROBE_TOOL,
      description: 'Echo the provided nonce back to the caller.',
      parameters: {
        type: 'object',
        properties: { nonce: { type: 'string' } },
        required: ['nonce'],
        additionalProperties: false,
      },
    },
  ]
  const userTurn = codexTextInput(
    `Call the ${PROBE_TOOL} tool exactly once with nonce "${nonce}". Do not reply with text before calling it.`,
  )
  const sessionId = `kin-probe-${crypto.randomUUID()}`
  const call = async (input, step) => {
    const requestId = `${sessionId}-${step}`
    push('info', `strict probe step ${step}: POST Gateway Worker /internal/v1/execute route=${route}`)
    const result = await service.execute({
      protocol: 'openai.responses',
      operation: 'responses',
      model,
      body: {
        model,
        input,
        tools,
        tool_choice: 'auto',
        stream: true,
        store: false,
        ...(effort ? { reasoning: { effort } } : {}),
      },
      headers: { accept: 'text/event-stream', 'session-id': sessionId },
      requestId,
      attemptId: `${requestId}:gateway:1`,
      scheduling,
      scope: { runtime_account_id: binding.runtime_account_id, account_resource_id: account.id },
    })
    const parsed = await readProbeStream(result)
    return { parsed, mode: result.headers?.['x-kin-gateway-auth-mode'] || null }
  }
  const fail = (code, message, evidence = {}) => {
    push('error', `${code}: ${message}`)
    return done({
      ok: false,
      model,
      error: { code, message },
      probe: { nonce, route, ...evidence },
      via: 'gateway-worker',
    })
  }
  let first
  try {
    first = await call(userTurn, 1)
  } catch (error) {
    return fail(error?.code || 'gateway_worker_unavailable', error?.message || 'Gateway Worker 暂不可用')
  }
  if (!first.parsed.ok) {
    const error = first.parsed.failure || first.parsed.body?.error || {}
    return fail(error.code || 'probe_first_round_failed', error.message || `HTTP ${first.parsed.status}`, {
      mode: first.mode,
    })
  }
  if (route === 'bps' && first.mode !== 'bps')
    return fail('probe_route_mismatch', `expected BPS, served by ${first.mode || 'unknown'}`)
  if (route === 'native' && first.mode === 'bps') return fail('probe_route_mismatch', 'expected native, served by BPS')
  const responseModel = first.parsed.response?.model || null
  push('info', `round 1 · route=${first.mode || '—'} · response_model=${responseModel || '—'}`)
  if (responseModel && responseModel !== model && !responseModel.startsWith(`${model}-`))
    return fail('probe_model_mismatch', `requested ${model}, upstream answered as ${responseModel}`, {
      mode: first.mode,
    })
  const toolCall = first.parsed.items.find((item) => item?.type === 'function_call' && item.name === PROBE_TOOL)
  if (!toolCall) return fail('probe_tool_not_called', `the model did not call ${PROBE_TOOL}`, { mode: first.mode })
  let args = {}
  try {
    args = JSON.parse(toolCall.arguments || '{}')
  } catch {}
  if (args.nonce !== nonce)
    return fail('probe_tool_arguments_mismatch', `nonce ${JSON.stringify(args.nonce)} ≠ ${nonce}`, { mode: first.mode })
  push('ok', `tool call ${PROBE_TOOL}(${toolCall.call_id}) nonce verified`)
  const history = [
    ...userTurn,
    ...first.parsed.items.filter((item) => item?.type === 'reasoning' || item === toolCall),
    { type: 'function_call_output', call_id: toolCall.call_id, output: JSON.stringify({ ok: true, nonce }) },
  ]
  let second
  try {
    second = await call(history, 2)
  } catch (error) {
    return fail(error?.code || 'gateway_worker_unavailable', error?.message || 'Gateway Worker 暂不可用')
  }
  if (!second.parsed.ok) {
    const error = second.parsed.failure || second.parsed.body?.error || {}
    return fail(error.code || 'probe_second_round_failed', error.message || `HTTP ${second.parsed.status}`, {
      mode: second.mode,
    })
  }
  const text = second.parsed.text || ''
  push('ok', `round 2 · route=${second.mode || '—'} · tool result accepted`)
  if (text) push('content', text.slice(0, 2000))
  return done({
    ok: true,
    model: responseModel || model,
    status: second.parsed.status,
    stop_reason: second.parsed.response?.status || 'completed',
    usage: second.parsed.response?.usage || null,
    text: text.slice(0, 4000),
    via: 'gateway-worker',
    credential_mode: 'oauth',
    authorization_mode: second.mode,
    probe: {
      nonce,
      route,
      mode: first.mode,
      response_model: responseModel,
      tool_call_id: toolCall.call_id,
      verified: true,
    },
  })
}
