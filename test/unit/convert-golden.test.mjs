/**
 * Golden tests for the protocol converters (audit stage 2, W8).
 *
 * Each `test/fixtures/convert-golden/<scenario>.json` holds hand-written inputs: one inbound
 * request per client protocol and one upstream SSE event list per backend. The matching
 * `<scenario>.golden.json` holds the recorded outbound request and client output (stream and
 * non-stream) for both backends, produced by the same call chains the handlers use:
 *
 *   Claude backend (handle-protocol / api-protocol):
 *     toClaudeMessages → Anthropic SSE → claudeSSELineTo* (stream) / applyClaudeSSELineToMessage → fromClaudeTo* (JSON)
 *   Codex backend (handle-codex / handle-codex-gateway):
 *     toCodexResponses → Responses SSE → responsesSseTo* or the event namer (stream) /
 *     assembleCodexBodyFromSse → codexBodyToAnthropicMessage → fromClaudeToOpenAIChat (JSON)
 *
 * Default run compares only. `UPDATE_GOLDEN=1` rewrites every `.golden.json` from the current
 * converters; review the diff before committing it. Round-trip checks assert that the semantic
 * fields (text, tool calls, stop/status, usage) survive A→B→A conversions.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import {
  toClaudeMessages,
  createClaudeMessageAssembler,
  applyClaudeSSELineToMessage,
  fromClaudeToOpenAIChat,
  fromClaudeToResponses,
  createOpenAIChatStreamState,
  claudeSSELineToOpenAIChatChunks,
  createResponsesStreamState,
  claudeSSELineToResponsesEvents,
} from '../../src/lib/protocol/convert.mjs'
import {
  toCodexResponses,
  createChatSseState,
  responsesSseToChatChunk,
  createAnthropicSseState,
  responsesSseToAnthropicEvents,
  createResponsesSseEventNamer,
  assembleCodexBodyFromSse,
  codexBodyToAnthropicMessage,
  withChatUrlCitations,
} from '../../src/lib/protocol/codex-convert.mjs'

const DIR = new URL('../fixtures/convert-golden/', import.meta.url)
const UPDATE = process.env.UPDATE_GOLDEN === '1'
const PROTOCOLS = ['anthropic.messages', 'openai.chat', 'openai.responses']
const MODELS = { claude: 'claude-sonnet-4-5-20250929', codex: 'gpt-5.4' }
const VM = 'vm-golden'
const FIXED_NOW = Date.UTC(2026, 0, 1)

/**
 * Converter gaps found by W8. The golden files record current behaviour; the round-trip
 * fields listed here run as separate `todo` tests (reported, not failing) while every other
 * field of the same check still asserts. Drop an entry once the converter is fixed.
 * `scenarios` omitted = every scenario.
 */
const GAP = {
  G1: 'G1 claudeSSELineToResponsesEvents: response.completed carries no usage',
  G2: 'G2 claudeSSELineToResponsesEvents drops tool_use blocks (Responses+tools to Anthropic endpoints is rejected by responsesNeedsUnsupportedItems)',
  G3: 'G3 Anthropic stop_reason max_tokens becomes Responses status completed instead of incomplete/max_output_tokens',
  G4: 'G4 anthropicReasoningEffort maps budget 16384 (thinking.mjs "high") back to medium',
  G5: 'G5 responsesToClaude flattens function_call / function_call_output items to empty text (guarded by responses_endpoint_incompatible)',
  G6: 'G6 responsesSseToAnthropicEvents keeps the text block open while a tool_use block starts and stops (blocks interleave)',
  G7: 'G7 claudeSSELineToResponsesEvents emits message done events for every content_block_stop, including thinking/tool_use blocks never added',
}
const KNOWN_GAPS = [
  { check: 'claude-stream', field: 'usage', reason: GAP.G1 },
  { check: 'codex-stream', field: 'usage', reason: GAP.G1 },
  { check: 'claude-stream', field: 'tools', scenarios: ['02-tool-single', '03-tool-parallel'], reason: GAP.G2 },
  { check: 'claude-stream', field: 'stop', scenarios: ['02-tool-single', '03-tool-parallel'], reason: GAP.G2 },
  { check: 'codex-stream', field: 'tools', scenarios: ['02-tool-single', '03-tool-parallel'], reason: GAP.G2 },
  { check: 'claude-json', field: 'stop', scenarios: ['07-incomplete-max-tokens'], reason: GAP.G3 },
  { check: 'claude-stream', field: 'stop', scenarios: ['07-incomplete-max-tokens'], reason: GAP.G3 },
  { check: 'codex-json', field: 'status', scenarios: ['07-incomplete-max-tokens'], reason: GAP.G3 },
  { check: 'codex-json', field: 'incomplete', scenarios: ['07-incomplete-max-tokens'], reason: GAP.G3 },
  { check: 'codex-stream', field: 'status', scenarios: ['07-incomplete-max-tokens'], reason: GAP.G3 },
  { check: 'codex-stream', field: 'incomplete', scenarios: ['07-incomplete-max-tokens'], reason: GAP.G3 },
  { check: 'chat-request', field: 'effort', scenarios: ['05-reasoning'], reason: GAP.G4 },
  { check: 'anthropic-request', field: 'turns', scenarios: ['04-tool-result'], reason: GAP.G5 },
]

/** Round trips that do not apply: failure terminals are mapped by the transport, not the converters. */
const NOT_APPLICABLE = {
  '09-failed':
    'response.failed / Anthropic error events are turned into client errors by the transport (go-worker-client, api-protocol) before conversion',
}

/** Stream well-formedness violations, keyed `<backend> <protocol>`. */
const STREAM_GAPS = [
  { stream: 'codex anthropic.messages', scenarios: ['02-tool-single'], reason: GAP.G6 },
  {
    stream: 'claude openai.responses',
    scenarios: ['02-tool-single', '03-tool-parallel', '05-reasoning'],
    reason: GAP.G7,
  },
]

const gapsFor = (check, scenario) =>
  KNOWN_GAPS.filter((gap) => gap.check === check && (!gap.scenarios || gap.scenarios.includes(scenario)))

const plain = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)))

/** Freeze clock and randomness so ids/timestamps are stable regardless of call counts. */
function deterministic(fn) {
  const { now } = Date
  const { random } = Math
  Date.now = () => FIXED_NOW
  Math.random = () => 0.5
  try {
    return fn()
  } finally {
    Date.now = now
    Math.random = random
  }
}

/** Anthropic SSE: one named event per payload. Strings pass through as raw lines. */
function claudeLines(events) {
  return events.flatMap((e) => (typeof e === 'string' ? [e] : [`event: ${e.type}`, `data: ${JSON.stringify(e)}`, '']))
}

/** Responses SSE as kin-codex-kernel emits it: every frame labelled `event: response`. */
function codexLines(events) {
  return events.flatMap((e) => (typeof e === 'string' ? [e] : ['event: response', `data: ${JSON.stringify(e)}`, '']))
}

/** SSE text → [{ event?, data }] with JSON data parsed (`[DONE]` kept as a string). */
function parseSseText(text) {
  const frames = []
  for (const block of String(text || '').split('\n\n')) {
    if (!block.trim()) continue
    let event = null
    const data = []
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).trim())
    }
    const raw = data.join('\n')
    frames.push({ ...(event ? { event } : {}), data: raw === '[DONE]' ? raw : JSON.parse(raw) })
  }
  return frames
}

function captureError(fn) {
  try {
    return fn()
  } catch (error) {
    return { error: error.code || error.message }
  }
}

function assembleClaude(lines) {
  const assembler = createClaudeMessageAssembler()
  for (const line of lines) applyClaudeSSELineToMessage(line, assembler)
  return assembler.message
}

function runClaude(protocol, request, upstream) {
  return deterministic(() => {
    const { claude: outbound, mode } = toClaudeMessages(protocol, request, { rewrite: false, model_map: false })
    const lines = claudeLines(upstream)
    const message = assembleClaude(lines)
    const model = request.model
    if (protocol === 'anthropic.messages') return plain({ mode, outbound, stream: 'passthrough', nonStream: message })
    if (protocol === 'openai.chat') {
      const state = createOpenAIChatStreamState(model, VM)
      return plain({
        mode,
        outbound,
        stream: lines.flatMap((line) => claudeSSELineToOpenAIChatChunks(line, state)),
        nonStream: fromClaudeToOpenAIChat(message, model, VM, mode),
      })
    }
    const state = createResponsesStreamState(model, VM)
    return plain({
      mode,
      outbound,
      stream: lines.flatMap((line) => claudeSSELineToResponsesEvents(line, state)),
      nonStream: fromClaudeToResponses(message, model, VM, mode),
    })
  })
}

function codexStreamText(protocol, lines) {
  let text = ''
  if (protocol === 'openai.responses') {
    const name = createResponsesSseEventNamer()
    for (const line of lines) text += name(line)
  } else if (protocol === 'anthropic.messages') {
    const state = createAnthropicSseState()
    for (const line of lines) text += responsesSseToAnthropicEvents(line, state) || ''
  } else {
    const state = createChatSseState('codex')
    for (const line of lines) text += responsesSseToChatChunk(line, 'codex', state) || ''
  }
  return text
}

function codexJson(protocol, lines, model) {
  const assembled = assembleCodexBodyFromSse(lines, {})
  if (protocol === 'openai.responses') return assembled
  const message = codexBodyToAnthropicMessage(assembled, model)
  return protocol === 'openai.chat' ? withChatUrlCitations(fromClaudeToOpenAIChat(message, model), assembled) : message
}

function runCodex(protocol, request, upstream) {
  return deterministic(() => {
    const outbound = toCodexResponses(protocol, request, { anthropic_to_codex: true })
    const lines = codexLines(upstream)
    const model = outbound.body?.model || request.model
    return plain({
      outbound,
      stream: captureError(() => parseSseText(codexStreamText(protocol, lines))),
      nonStream: captureError(() => codexJson(protocol, lines, model)),
    })
  })
}

const withModel = (request, backend) => ({ model: MODELS[backend], ...request })

function render(fixture) {
  const out = { claude: {}, codex: {} }
  for (const protocol of PROTOCOLS) {
    const request = fixture.requests[protocol]
    out.claude[protocol] = runClaude(protocol, withModel(request, 'claude'), fixture.upstream.claude)
    out.codex[protocol] = runCodex(protocol, withModel(request, 'codex'), fixture.upstream.codex)
  }
  return out
}

// ---------- stream well-formedness ----------

/** Anthropic SSE: message_start first; each content block starts, receives deltas and stops before the next. */
function anthropicStreamProblems(frames) {
  const problems = []
  let open = null
  frames.forEach((frame, i) => {
    const { type, index } = frame.data || {}
    if (i === 0 && type !== 'message_start') problems.push('first frame is not message_start')
    if (type === 'content_block_start') {
      if (open != null) problems.push(`block ${index} starts while block ${open} is open`)
      open = index
    } else if (type === 'content_block_delta' && index !== open) {
      problems.push(`delta for block ${index} while block ${open} is open`)
    } else if (type === 'content_block_stop') {
      if (index !== open) problems.push(`stop for block ${index} while block ${open} is open`)
      else open = null
    }
  })
  if (open != null) problems.push(`block ${open} never stops`)
  return problems
}

/** Responses events: item-scoped events only between that item's added and its single done. */
function responsesStreamProblems(events) {
  const problems = []
  const added = new Set()
  const done = new Set()
  for (const event of events) {
    const at = event.output_index
    if (event.type === 'response.output_item.added') added.add(at)
    else if (event.type === 'response.output_item.done') {
      if (!added.has(at) || done.has(at)) problems.push(`output_item.done ${at} without a matching open item`)
      done.add(at)
    } else if (at != null && (!added.has(at) || done.has(at))) {
      problems.push(`${event.type} ${at} outside an open item`)
    }
  }
  return problems
}

/** Chat chunks: tool arguments follow their header; exactly one finish_reason, on the last chunk. */
function chatStreamProblems(chunks) {
  const problems = []
  const headers = new Set()
  chunks.forEach((chunk, i) => {
    const choice = chunk.choices?.[0] || {}
    for (const call of choice.delta?.tool_calls || []) {
      if (call.id) headers.add(call.index)
      else if (!headers.has(call.index)) problems.push(`tool_calls[${call.index}] arguments before its header`)
    }
    if (choice.finish_reason != null && i !== chunks.length - 1) problems.push('finish_reason before the last chunk')
  })
  if (chunks[chunks.length - 1]?.choices?.[0]?.finish_reason == null) problems.push('no finish_reason')
  return problems
}

const STREAMS = [
  'claude openai.chat',
  'claude openai.responses',
  'codex anthropic.messages',
  'codex openai.chat',
  'codex openai.responses',
]

const dataOf = (frames) => frames.map((frame) => frame.data).filter((data) => data !== '[DONE]')

/** `<backend> <protocol>` → problems in that client stream (passthrough Anthropic is not converted). */
function streamProblems(rendered) {
  return {
    'claude openai.chat': chatStreamProblems(rendered.claude['openai.chat'].stream),
    'claude openai.responses': responsesStreamProblems(rendered.claude['openai.responses'].stream),
    'codex anthropic.messages': anthropicStreamProblems(rendered.codex['anthropic.messages'].stream),
    'codex openai.chat': chatStreamProblems(dataOf(rendered.codex['openai.chat'].stream)),
    'codex openai.responses': responsesStreamProblems(dataOf(rendered.codex['openai.responses'].stream)),
  }
}

// ---------- semantic projections for round trips ----------

function claudeSemantic(message = {}) {
  const content = message?.content || []
  const usage = message?.usage || {}
  return {
    text: content
      .filter((b) => b?.type === 'text')
      .map((b) => b.text || '')
      .join(''),
    tools: content.filter((b) => b?.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, input: b.input })),
    stop: message?.stop_reason ?? null,
    usage: {
      input:
        Number(usage.input_tokens || 0) +
        Number(usage.cache_read_input_tokens || 0) +
        Number(usage.cache_creation_input_tokens || 0),
      output: Number(usage.output_tokens || 0),
      cached: Number(usage.cache_read_input_tokens || 0),
    },
  }
}

function responsesSemantic(body = {}) {
  const output = body?.output || []
  const usage = body?.usage || {}
  return {
    text: output
      .filter((item) => item?.type === 'message')
      .flatMap((item) => item.content || [])
      .filter((part) => part?.type === 'output_text')
      .map((part) => part.text || '')
      .join(''),
    tools: output
      .filter((item) => item?.type === 'function_call')
      .map((item) => ({
        call_id: item.call_id || item.id,
        name: item.name,
        input: JSON.parse(item.arguments || '{}'),
      })),
    status: body?.status ?? null,
    incomplete: body?.incomplete_details?.reason ?? null,
    usage: {
      input: Number(usage.input_tokens || 0),
      output: Number(usage.output_tokens || 0),
      cached: Number(usage.input_tokens_details?.cached_tokens || 0),
    },
  }
}

/** Responses request body → ordered conversation turns, tool names and reasoning effort. */
function codexRequestSemantic(body = {}) {
  const turns = []
  for (const item of body.input || []) {
    if (item.type === 'function_call') {
      turns.push({ call: item.call_id, name: item.name, input: JSON.parse(item.arguments || '{}') })
    } else if (item.type === 'function_call_output') {
      turns.push({ result: item.call_id, output: item.output })
    } else {
      const parts = Array.isArray(item.content) ? item.content : [{ type: 'input_text', text: item.content }]
      const text = parts
        .filter((p) => p?.type === 'input_text' || p?.type === 'output_text')
        .map((p) => p.text)
        .join('\n')
      const images = parts.filter((p) => p?.type === 'input_image').map((p) => p.image_url)
      const previous = turns[turns.length - 1]
      // Text and images split by a converter into adjacent same-role messages read as one turn.
      if (previous?.role === item.role && previous.text != null) {
        previous.text = [previous.text, text].filter(Boolean).join('\n')
        previous.images.push(...images)
      } else turns.push({ role: item.role, text, images })
    }
  }
  return {
    turns,
    tools: (body.tools || []).map((tool) => tool.name),
    effort: body.reasoning?.effort ?? null,
  }
}

/** Claude request → system text plus ordered role/text turns (no tools or images). */
function claudeTextSemantic(body = {}) {
  const system = Array.isArray(body.system)
    ? body.system.map((b) => b.text).join('\n')
    : typeof body.system === 'string'
      ? body.system
      : ''
  const textOf = (content) =>
    typeof content === 'string'
      ? content
      : (content || [])
          .filter((b) => b?.type === 'text')
          .map((b) => b.text)
          .join('\n')
  return {
    system,
    turns: (body.messages || []).map((m) => ({ role: m.role, text: textOf(m.content) })).filter((m) => m.text),
  }
}

/** Anthropic SSE text → assembled Messages JSON. */
function assembleClaudeSseText(text) {
  return assembleClaude(text.split('\n'))
}

/** Responses events (objects) → data lines. */
const responsesEventLines = (events) => events.flatMap((e) => [`data: ${JSON.stringify(e)}`, ''])

const ROUND_TRIPS = {
  // Anthropic message → Responses JSON → Anthropic message
  'claude-json': (fixture) =>
    deterministic(() => {
      const message = assembleClaude(claudeLines(fixture.upstream.claude))
      const back = codexBodyToAnthropicMessage(fromClaudeToResponses(message, MODELS.claude), MODELS.claude)
      return [claudeSemantic(back), claudeSemantic(message)]
    }),
  // Responses JSON → Anthropic message → Responses JSON
  'codex-json': (fixture) =>
    deterministic(() => {
      const body = assembleCodexBodyFromSse(codexLines(fixture.upstream.codex), {})
      const back = fromClaudeToResponses(codexBodyToAnthropicMessage(body, MODELS.codex), MODELS.codex)
      return [responsesSemantic(back), responsesSemantic(body)]
    }),
  // Anthropic SSE → Responses events → Anthropic SSE
  'claude-stream': (fixture) =>
    deterministic(() => {
      const lines = claudeLines(fixture.upstream.claude)
      const state = createResponsesStreamState(MODELS.claude, VM)
      const events = lines.flatMap((line) => claudeSSELineToResponsesEvents(line, state))
      const anthropic = createAnthropicSseState()
      const text = responsesEventLines(events)
        .map((line) => responsesSseToAnthropicEvents(line, anthropic) || '')
        .join('')
      return [claudeSemantic(assembleClaudeSseText(text)), claudeSemantic(assembleClaude(lines))]
    }),
  // Responses SSE → Anthropic SSE → Responses events
  'codex-stream': (fixture) =>
    deterministic(() => {
      const lines = codexLines(fixture.upstream.codex)
      const anthropic = createAnthropicSseState()
      const text = lines.map((line) => responsesSseToAnthropicEvents(line, anthropic) || '').join('')
      const state = createResponsesStreamState(MODELS.codex, VM)
      const events = text.split('\n').flatMap((line) => claudeSSELineToResponsesEvents(line, state))
      const back = assembleCodexBodyFromSse(responsesEventLines(events), {})
      return [responsesSemantic(back), responsesSemantic(assembleCodexBodyFromSse(lines, {}))]
    }),
  // Chat request → Responses directly, and via the Claude request: same conversation reaches Codex
  'chat-request': (fixture) =>
    deterministic(() => {
      const chat = withModel(fixture.requests['openai.chat'], 'codex')
      const direct = toCodexResponses('openai.chat', chat).body
      const { claude } = toClaudeMessages('openai.chat', chat, { rewrite: false, model_map: false })
      const viaClaude = toCodexResponses('anthropic.messages', claude, { anthropic_to_codex: true }).body
      return [codexRequestSemantic(viaClaude), codexRequestSemantic(direct)]
    }),
  // Anthropic request → Responses request → Anthropic request (text conversation only)
  'anthropic-request': (fixture) =>
    deterministic(() => {
      const anthropic = withModel(fixture.requests['anthropic.messages'], 'claude')
      const responses = toCodexResponses('anthropic.messages', anthropic, { anthropic_to_codex: true }).body
      const back = toClaudeMessages('openai.responses', responses, { rewrite: false, model_map: false }).claude
      const original = toClaudeMessages('anthropic.messages', anthropic, { rewrite: false, model_map: false }).claude
      return [claudeTextSemantic(back), claudeTextSemantic(original)]
    }),
}

const fixtures = readdirSync(DIR)
  .filter((name) => name.endsWith('.json') && !name.endsWith('.golden.json'))
  .sort()
  .map((name) => ({ name: name.slice(0, -'.json'.length), ...JSON.parse(readFileSync(new URL(name, DIR), 'utf8')) }))

test('golden fixtures cover every scenario with requests for all three inbound protocols', () => {
  assert.ok(fixtures.length >= 10)
  for (const fixture of fixtures) {
    assert.deepEqual(Object.keys(fixture.requests).sort(), PROTOCOLS, fixture.name)
    assert.ok(fixture.upstream.claude?.length && fixture.upstream.codex?.length, fixture.name)
  }
})

for (const fixture of fixtures) {
  test(`golden: ${fixture.name}`, () => {
    const actual = render(fixture)
    const file = new URL(`${fixture.name}.golden.json`, DIR)
    if (UPDATE) {
      writeFileSync(file, `${JSON.stringify(actual, null, 2)}\n`)
      return
    }
    const expected = JSON.parse(readFileSync(file, 'utf8'))
    for (const backend of ['claude', 'codex']) {
      for (const protocol of PROTOCOLS) {
        assert.deepEqual(actual[backend][protocol], expected[backend][protocol], `${backend} ${protocol}`)
      }
    }
  })

  for (const stream of STREAMS) {
    const skip = NOT_APPLICABLE[fixture.name]
    const gap = STREAM_GAPS.find((entry) => entry.stream === stream && entry.scenarios.includes(fixture.name))
    test(`stream contract ${stream}: ${fixture.name}`, skip ? { skip } : gap ? { todo: gap.reason } : {}, () => {
      assert.deepEqual(streamProblems(render(fixture))[stream], [])
    })
  }

  for (const [check, run] of Object.entries(ROUND_TRIPS)) {
    const skip = check.endsWith('-request') ? undefined : NOT_APPLICABLE[fixture.name]
    const gaps = gapsFor(check, fixture.name)
    const gapFields = new Set(gaps.map((gap) => gap.field))
    const without = (value) => Object.fromEntries(Object.entries(value).filter(([key]) => !gapFields.has(key)))
    test(`round trip ${check}: ${fixture.name}`, skip ? { skip } : {}, () => {
      const [actual, expected] = run(fixture)
      assert.deepEqual(without(actual), without(expected))
    })
    for (const gap of gaps) {
      test(`round trip ${check} ${gap.field}: ${fixture.name}`, skip ? { skip } : { todo: gap.reason }, () => {
        const [actual, expected] = run(fixture)
        assert.deepEqual(actual[gap.field], expected[gap.field])
      })
    }
  }
}
