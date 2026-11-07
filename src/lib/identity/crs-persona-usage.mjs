/**
 * Estimate the tokens the gateway injects into an unofficial (non-Claude-Code)
 * request: the official persona blocks (billing / identity / Environment), any
 * other template or overlay text the caller did not send (harness, standing,
 * parked reminder), and gateway-injected tools.
 * The caller's prompt, the caller's own tools and the caller's
 * `--system` / `--append-system-prompt` leftover are never counted.
 * Injected server tools (web_search) count at their upstream schema cost, not
 * at the size of the `{type,name}` stub we put on the wire.
 * Official Claude Code passthrough is not rewritten and injects nothing.
 * The count drives both billing and the usage returned to the customer
 * (see protocol/customer-usage.mjs); usage_logs keep real Anthropic counts.
 */
import {
  CRS_AGENT_EXPANSION,
  CRS_OFFICIAL_CLI_SYSTEM,
  CRS_OFFICIAL_SYSTEM,
  CRS_OFFICIAL_AGENT_PROMPT,
  CRS_SYSTEM_EXPANSION,
  callerSystemBlocksWithoutBilling,
} from './crs-persona.mjs'
import { CRS_OFFICIAL_CONTINUATION } from './official-cc-system-2.1.241.mjs'

const SYSTEM_REMINDER_RE = /<system-reminder>\n[\s\S]*?<\/system-reminder>\n?/

/** Calibrated so rewrite 3-block (~1668 chars) ≥ observed short-request 554. */
export const PERSONA_TOKEN_CHAR_DIVISOR = 3

export function estimateClaudeInputTokens(text) {
  const s = String(text || '')
  if (!s) return 0
  return Math.ceil(s.length / PERSONA_TOKEN_CHAR_DIVISOR)
}

function isBlankIdentitySlot(text) {
  return /^[\u200b\u200c\u200d\ufeff\s]*$/.test(String(text || ''))
}

function extractSystemTexts(system) {
  if (!system) return []
  if (typeof system === 'string') return isBlankIdentitySlot(system) ? [] : [system]
  if (Array.isArray(system)) {
    return system.map((b) => (typeof b === 'string' ? b : b?.text || '')).filter((t) => !isBlankIdentitySlot(t))
  }
  if (typeof system === 'object' && typeof system.text === 'string') {
    return isBlankIdentitySlot(system.text) ? [] : [system.text]
  }
  return []
}

function firstUserRaw(messages) {
  if (!Array.isArray(messages)) return ''
  for (const msg of messages) {
    if (msg?.role !== 'user') continue
    if (typeof msg.content === 'string') return msg.content
    if (Array.isArray(msg.content)) {
      return msg.content
        .map((block) => (typeof block === 'string' ? block : block?.text || ''))
        .filter(Boolean)
        .join('\n')
    }
    return msg.content == null ? '' : String(msg.content)
  }
  return ''
}

function extractParkedReminder(messages) {
  const raw = firstUserRaw(messages)
  const m = raw.match(SYSTEM_REMINDER_RE)
  return m ? m[0].trim() : ''
}

function extractSystemRoleTexts(messages) {
  if (!Array.isArray(messages)) return []
  const out = []
  for (const message of messages) {
    if (message?.role !== 'system') continue
    out.push(...extractSystemTexts(message.content))
  }
  return out
}

function isOfficialPersonaText(text) {
  const t = String(text || '')
  if (/^\s*x-anthropic-billing-header:/i.test(t)) return true
  if (t.trim() === CRS_OFFICIAL_SYSTEM || t.trim() === CRS_OFFICIAL_CLI_SYSTEM) return true
  if (t === CRS_SYSTEM_EXPANSION) return true
  if (t === CRS_OFFICIAL_AGENT_PROMPT || t.startsWith(CRS_OFFICIAL_AGENT_PROMPT.slice(0, 80))) return true
  if (t === CRS_AGENT_EXPANSION || t.startsWith(CRS_AGENT_EXPANSION.slice(0, 80))) return true
  if (t.startsWith(CRS_OFFICIAL_CONTINUATION.slice(0, 80))) return true
  if (t.includes('# Environment\nYou have been invoked in the following environment:')) return true
  if (
    /^# Environment\b/m.test(t) &&
    /Timezone:/.test(t) &&
    !t.includes('# Text output') &&
    !t.includes('# Doing tasks')
  )
    return true
  return false
}

function officialPersonaTexts(system) {
  const out = []
  for (const t of extractSystemTexts(system)) {
    if (isOfficialPersonaText(t)) {
      out.push(t)
      continue
    }
    if (t.startsWith(CRS_SYSTEM_EXPANSION)) {
      out.push(CRS_SYSTEM_EXPANSION)
      continue
    }
    if (t.includes(CRS_OFFICIAL_AGENT_PROMPT)) {
      // Standing constraints may lead the official agent block; only the prompt is official.
      out.push(CRS_OFFICIAL_AGENT_PROMPT)
      continue
    }
    if (!t.includes(CRS_OFFICIAL_SYSTEM)) continue
    const billing = t.match(/x-anthropic-billing-header:[^\n]*/i)
    if (billing) out.push(billing[0])
    out.push(CRS_OFFICIAL_SYSTEM)
    if (t.includes(CRS_SYSTEM_EXPANSION)) out.push(CRS_SYSTEM_EXPANSION)
  }
  return out
}

export function officialPersonaText(system) {
  return officialPersonaTexts(system).join('')
}

function stripKnownTexts(text, known) {
  let rest = String(text || '')
  for (const prev of known) {
    if (!prev) continue
    rest = rest.split(prev).join('')
  }
  return rest.replace(/^\s+|\s+$/g, '').replace(/\n{3,}/g, '\n\n')
}

/** Overlay text we injected; caller leftover is not included. */
export function injectedOverlayText(before, after) {
  if (!after || before === after) return ''
  const beforeSys = extractSystemTexts(before?.system)
  const beforeMsg = extractSystemRoleTexts(before?.messages)
  const known = [...beforeSys, ...beforeMsg]
  const parts = []
  for (const t of extractSystemTexts(after.system)) {
    if (isOfficialPersonaText(t)) continue
    if (beforeSys.includes(t)) continue
    const raw = t.startsWith(CRS_SYSTEM_EXPANSION) ? t.slice(CRS_SYSTEM_EXPANSION.length) : t
    const rest = stripKnownTexts(raw, [
      ...known,
      CRS_OFFICIAL_SYSTEM,
      CRS_OFFICIAL_CLI_SYSTEM,
      CRS_SYSTEM_EXPANSION,
      CRS_OFFICIAL_AGENT_PROMPT,
      CRS_AGENT_EXPANSION,
    ])
    if (rest && !isOfficialPersonaText(rest)) parts.push(rest)
  }
  for (const t of extractSystemRoleTexts(after.messages)) {
    if (isOfficialPersonaText(t)) continue
    if (beforeMsg.includes(t)) continue
    const rest = stripKnownTexts(t, [
      ...known,
      CRS_OFFICIAL_SYSTEM,
      CRS_OFFICIAL_CLI_SYSTEM,
      CRS_SYSTEM_EXPANSION,
      CRS_OFFICIAL_AGENT_PROMPT,
      CRS_AGENT_EXPANSION,
    ])
    if (rest && !isOfficialPersonaText(rest)) parts.push(rest)
  }
  const afterReminder = extractParkedReminder(after.messages)
  const beforeReminder = extractParkedReminder(before?.messages)
  if (afterReminder && afterReminder !== beforeReminder) parts.push(afterReminder)
  return parts.join('\n\n')
}

function callerOfficialTexts(system) {
  // Zero can replace billing lines inside a caller text block. Compare the
  // retained text against the same normalized source, as well as the original.
  return new Set([...officialPersonaTexts(system), ...officialPersonaTexts(callerSystemBlocksWithoutBilling(system))])
}

function officialInjectedTokens(before, after) {
  if (!after || before === after) return 0
  const callerTexts = callerOfficialTexts(before?.system)
  const added = officialPersonaTexts(after.system).filter((text) => !callerTexts.has(text))
  return estimateClaudeInputTokens(added.join(''))
}

function toolKey(tool) {
  if (!tool || typeof tool !== 'object') return ''
  return String(tool.name || tool.type || tool.function?.name || '').trim()
}

function callerToolKeys(body) {
  return new Set((Array.isArray(body?.tools) ? body.tools : []).map(toolKey).filter(Boolean))
}

/**
 * Server tools ship as a bare `{type,name}` stub because the schema lives
 * upstream, so the outbound bytes are ~18 tokens while Anthropic bills the
 * whole tool contract. Measured on the vm-05 zero baseline (claude-sonnet-5,
 * two identical runs 2026-08-28): 2837 input with `web_search_20250305`
 * against 43 for the same request shape without it.
 */
export const SERVER_TOOL_INPUT_TOKENS = Object.freeze({
  web_search_20250305: 2794,
  web_search_20260209: 2794,
  web_search_20260318: 2794,
})

function serverToolTokens(tool) {
  const type = String(tool?.type || '').trim()
  return type && SERVER_TOOL_INPUT_TOKENS[type] != null ? SERVER_TOOL_INPUT_TOKENS[type] : 0
}

/** Gateway-injected tools only. Caller tools are kept in client usage. */
export function injectedTools(before, after) {
  if (!Array.isArray(after?.tools) || !after.tools.length) return []
  const keep = callerToolKeys(before)
  return after.tools.filter((tool) => {
    const key = toolKey(tool)
    return key && !keep.has(key)
  })
}

export function injectedToolsPayload(before, after) {
  const extra = injectedTools(before, after)
  return extra.length ? JSON.stringify(extra) : ''
}

/** Injected server tools bill their upstream schema, not the outbound stub. */
export function injectedToolTokens(before, after) {
  const extra = injectedTools(before, after)
  if (!extra.length) return 0
  const stubs = []
  let total = 0
  for (const tool of extra) {
    const billed = serverToolTokens(tool)
    if (billed) total += billed
    else stubs.push(tool)
  }
  if (stubs.length) total += estimateClaudeInputTokens(JSON.stringify(stubs))
  return total
}

function stripParkedReminderFromMessages(messages) {
  if (!Array.isArray(messages)) return messages
  let used = false
  return messages.map((message) => {
    if (used || message?.role !== 'user') return message
    used = true
    if (typeof message.content === 'string') {
      const next = message.content.replace(SYSTEM_REMINDER_RE, '').replace(/^\n+/, '')
      return next === message.content ? message : { ...message, content: next }
    }
    return message
  })
}

/** Caller-visible body: keep caller --system leftover, drop parked overlay reminder. */
export function callerUsageBaseline(body) {
  if (!body || typeof body !== 'object') return { messages: [] }
  return {
    ...(body.system != null ? { system: body.system } : {}),
    messages: stripParkedReminderFromMessages(body.messages),
    ...(Array.isArray(body.tools) ? { tools: body.tools } : {}),
    ...(body.tool_choice != null ? { tool_choice: body.tool_choice } : {}),
  }
}

/**
 * Gateway-injected tokens by origin, against the caller-visible baseline.
 * `official` = official persona blocks the caller did not send; `overlay` =
 * every other system / role=system / parked-reminder text we added; `tools` =
 * tools the caller did not declare. The three never overlap.
 */
export function gatewayInjectedBreakdown(inbound, outbound) {
  if (!outbound) return { official: 0, overlay: 0, tools: 0 }
  const baseline = callerUsageBaseline(inbound)
  return {
    official: officialInjectedTokens(baseline, outbound),
    overlay: estimateClaudeInputTokens(injectedOverlayText(baseline, outbound)),
    tools: injectedToolTokens(baseline, outbound),
  }
}

/** Total tokens the customer must not pay for. 0 for official passthrough. */
export function gatewayInjectedTokens(inbound, outbound, { officialClient = false } = {}) {
  if (officialClient || !outbound || inbound === outbound) return 0
  const { official, overlay, tools } = gatewayInjectedBreakdown(inbound, outbound)
  return official + overlay + tools
}

/**
 * English prose runs ~4 chars per token, code and JSON fewer, CJK far fewer;
 * so chars/4 rarely exceeds the caller's real count.
 */
export const CALLER_FLOOR_CHAR_DIVISOR = 4

function callerBlockText(block) {
  if (typeof block === 'string') return block
  if (!block || typeof block !== 'object') return ''
  if (block.type === 'text') return block.text || ''
  if (block.type === 'tool_use') return JSON.stringify(block.input ?? '')
  if (block.type === 'tool_result') {
    if (typeof block.content === 'string') return block.content
    return Array.isArray(block.content) ? block.content.map(callerBlockText).join('') : ''
  }
  // Images, documents and thinking are not text the floor can price; leave them out.
  return ''
}

/**
 * Lower bound of the caller's own prompt tokens. chars/3 overestimates the
 * English persona (official_full: ~2.7k chars measured ~640 tokens, estimated
 * ~910), so on a short prompt the injected estimate alone would bill the
 * caller zero input. Billing never deducts below this floor.
 */
export function callerPromptTokenFloor(inbound) {
  const baseline = callerUsageBaseline(inbound)
  let chars = extractSystemTexts(baseline.system).join('').length
  for (const message of Array.isArray(baseline.messages) ? baseline.messages : []) {
    const content = message?.content
    chars += Array.isArray(content) ? content.map(callerBlockText).join('').length : String(content ?? '').length
  }
  if (Array.isArray(baseline.tools) && baseline.tools.length) chars += JSON.stringify(baseline.tools).length
  return Math.floor(chars / CALLER_FLOOR_CHAR_DIVISOR)
}
