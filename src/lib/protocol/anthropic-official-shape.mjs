/**
 * 原生 Anthropic `/v1/messages` 的官方结构校验：在清洗（sanitize / 补默认值）之前，按官方 API 会返回 400 的规则检查客户原始请求。
 * 按官方 API 编写的客户端（含 Claude Code）本来就满足这些规则；OpenAI 兼容入口走 openai.* 协议，不经过这里。
 * 网关不再替客户把官方会拒绝的请求修好后照常执行并计费（2026-11-05 客户试用反馈）。
 * role 例外：会话中段的 `system`（Claude Code 自带的提醒，上游接受；网关自己的 Environment 也写成这种消息）
 * 与 `developer`（已有客户端写法，后续按 system 处理）保留；其余取值按官方返回 400。
 */
import { ErrorType, makeError } from '../core/errors.mjs'

const ROLES = new Set(['user', 'assistant', 'system', 'developer'])

const fail = (message, param) => ({
  ok: false,
  errorResult: makeError({ type: ErrorType.INVALID_REQUEST, code: 'invalid_request', message, param, status: 400 }),
})

function emptyContent(content) {
  if (typeof content === 'string') return content.length === 0
  if (Array.isArray(content)) return content.length === 0
  return content == null
}

export function validateOfficialMessagesShape(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: true }
  const max = body.max_tokens
  if (max == null) return fail('max_tokens: Field required', 'max_tokens')
  if (typeof max !== 'number' || !Number.isInteger(max))
    return fail('max_tokens: Input should be a valid integer', 'max_tokens')
  if (max < 1) return fail('max_tokens: Input should be greater than or equal to 1', 'max_tokens')
  const messages = body.messages
  if (!Array.isArray(messages)) return { ok: true }
  if (messages.length === 0) return fail('messages: at least one message is required', 'messages')
  const last = messages.length - 1
  for (let i = 0; i <= last; i++) {
    const role = messages[i]?.role
    if (!ROLES.has(role)) return fail(`messages.${i}.role: Input should be 'user' or 'assistant'`, `messages.${i}.role`)
    if (emptyContent(messages[i]?.content) && !(i === last && role === 'assistant'))
      return fail(
        `messages.${i}: all messages must have non-empty content except for the optional final assistant message`,
        `messages.${i}.content`,
      )
  }
  return { ok: true }
}
