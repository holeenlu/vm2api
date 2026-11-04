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
  const binding = service.repo.getAccountBinding(account.id)
  if (!binding?.runtime_account_id) {
    push('error', '账号尚未投影到 Gateway Worker')
    return done({
      ok: false,
      model,
      error: { code: 'gateway_account_binding_not_found', message: '账号尚未授权或未同步到 Worker' },
    })
  }
  push('info', `prompt=${JSON.stringify(prompt).slice(0, 120)} effort=${effort || 'none'}`)
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
  push('ok', `HTTP ${status} · ${parsed.stop_reason || 'completed'}`)
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
  })
}
