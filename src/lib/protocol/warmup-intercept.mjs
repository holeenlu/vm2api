/**
 * Port of sub2api detectInterceptType / sendMockIntercept*
 * (backend/internal/handler/gateway_handler.go). Answered before any account
 * is selected, so these never take a seat, a sticky pin, quota, or an
 * upstream call. One addition: requests with tools are never intercepted.
 */
import crypto from 'node:crypto'
import { isOfficialClaudeUa } from '../identity/official-claude-ua.mjs'

const TITLE_PROMPT = 'Please write a 5-10 word title for the following conversation:'
// Real CLI text starts with "Analyze"; sub2api matches without the first letter.
const TOPIC_SYSTEM = 'nalyze if this message indicates a new conversation topic. If it does, extract a 2-3 word title'
const SUGGESTION_PREFIX = '[SUGGESTION MODE:'

/**
 * sub2api decodes into typed structs: messages[].content and system must be
 * arrays of {type,text} objects. Any other shape (a string content turn, a
 * string system) fails json.Unmarshal and the request is not intercepted.
 * Real Claude Code sessions carry string-content system turns, which is what
 * keeps long conversations out.
 */
function typedParse(body) {
  const isStr = (v) => v == null || typeof v === 'string'
  const blocks = (list, keys) => {
    if (list == null) return []
    if (!Array.isArray(list)) return null
    const out = []
    for (const item of list) {
      if (item == null) {
        out.push({})
        continue
      }
      if (typeof item !== 'object' || Array.isArray(item)) return null
      for (const key of keys) if (!isStr(item[key])) return null
      out.push(item)
    }
    return out
  }
  if (body.messages != null && !Array.isArray(body.messages)) return null
  const messages = []
  for (const msg of body.messages || []) {
    if (msg == null) {
      messages.push({ role: '', content: [] })
      continue
    }
    if (typeof msg !== 'object' || Array.isArray(msg) || !isStr(msg.role)) return null
    const content = blocks(msg.content, ['type', 'text'])
    if (!content) return null
    messages.push({ role: msg.role || '', content })
  }
  const system = blocks(body.system, ['text'])
  if (!system) return null
  return { messages, system }
}

/**
 * @param {object} body inbound Messages body
 * @param {{ userAgent?: string }} [opts] sub2api isClaudeCodeClient; a
 *   max_tokens=1 body passes its validator on the claude-cli UA alone.
 * @returns {null | 'haiku_ping' | 'suggestion' | 'warmup'}
 */
export function detectWarmupIntercept(body = {}, { userAgent = '' } = {}) {
  if (!body || typeof body !== 'object') return null
  const model = String(body.model || '')
  if (isOfficialClaudeUa(userAgent) && Number(body.max_tokens) === 1 && model.toLowerCase().includes('haiku')) {
    return 'haiku_ping'
  }
  // tapmodels guard beyond sub2api: warmup / title / suggestion side calls never
  // carry tools, while a real turn that quotes these texts always does.
  if (Array.isArray(body.tools) ? body.tools.length : body.tools) return null
  const raw = JSON.stringify(body)
  const hasSuggestionMode = raw.includes(SUGGESTION_PREFIX)
  const hasWarmupKeyword = raw.includes('title') || raw.includes('Warmup')
  if (!hasSuggestionMode && !hasWarmupKeyword) return null
  const req = typedParse(body)
  if (!req) return null
  if (hasSuggestionMode && req.messages.length > 0) {
    const last = req.messages[req.messages.length - 1]
    const first = last.content[0]
    if (
      last.role === 'user' &&
      first &&
      first.type === 'text' &&
      String(first.text || '').startsWith(SUGGESTION_PREFIX)
    ) {
      return 'suggestion'
    }
  }
  if (hasWarmupKeyword) {
    for (const msg of req.messages) {
      for (const block of msg.content) {
        if (block.type !== 'text') continue
        const text = String(block.text || '')
        if (text.includes(TITLE_PROMPT) || text === 'Warmup') return 'warmup'
      }
    }
    for (const sys of req.system) {
      if (String(sys.text || '').includes(TOPIC_SYSTEM)) return 'warmup'
    }
  }
  return null
}

/** sub2api generateRealisticMsgID: msg_01 + 22 Base62 chars. */
function messageId() {
  const charset = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
  const bytes = crypto.randomBytes(22)
  let id = ''
  for (const byte of bytes) id += charset[byte % charset.length]
  return `msg_01${id}`
}

/** sub2api sendMockInterceptResponse. */
export function warmupMockMessage(kind, model) {
  let text = 'New Conversation'
  let outputTokens = 2
  let stopReason = 'end_turn'
  if (kind === 'suggestion') {
    text = ''
    outputTokens = 1
  } else if (kind === 'haiku_ping') {
    text = '#'
    outputTokens = 1
    stopReason = 'max_tokens'
  }
  return {
    model: String(model || ''),
    id: messageId(),
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text }],
    stop_reason: stopReason,
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: 10,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
      output_tokens: outputTokens,
    },
  }
}

/**
 * sub2api sendMockInterceptStream. Its switch only knows SuggestionMode vs
 * default, so a streamed haiku ping gets "New Conversation" / end_turn.
 */
export function formatWarmupSse(kind, model) {
  const suggestion = kind === 'suggestion'
  const outputTokens = suggestion ? 1 : 2
  const deltas = suggestion ? [''] : ['New', ' Conversation']
  const events = [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          model: String(model || ''),
          id: messageId(),
          type: 'message',
          role: 'assistant',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
        },
      },
    ],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ...deltas.map((text) => [
      'content_block_delta',
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    ]),
    ['content_block_stop', { index: 0, type: 'content_block_stop' }],
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null, stop_details: null },
        usage: { output_tokens: outputTokens },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  ]
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')
}
