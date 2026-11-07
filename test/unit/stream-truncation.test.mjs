import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildAnthropicSseError,
  createAnthropicSseErrorRemapper,
  createAnthropicStreamTracker,
  createStreamForwardMeter,
  isRecoverableTruncation,
  reportKernelStreamOverflow,
} from '../../src/lib/protocol/stream-truncation.mjs'
import { isKernelStreamOverflow, mapUpstreamError } from '../../src/lib/core/errors.mjs'
import { classifyRequestError } from '../../src/lib/admin/error-class.mjs'

test('a cut tool call closes as max_tokens and a thinking block does not', () => {
  const tracker = createAnthropicStreamTracker()
  tracker.observe('data: {"type":"message_start","message":{"usage":{"output_tokens":3}}}\n\n')
  tracker.observe(
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"Write"}}\n\n',
  )
  tracker.observe(
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"file"}}\n\n',
  )
  const closing = tracker.closingEvents()
  assert.match(closing, /content_block_stop/)
  assert.match(closing, /"stop_reason":"max_tokens"/)
  assert.match(closing, /message_stop/)
  assert.equal(tracker.closingEvents(), null)

  const thinking = createAnthropicStreamTracker()
  thinking.observe('data: {"type":"message_start","message":{"usage":{"output_tokens":1}}}\n\n')
  thinking.observe('data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}\n\n')
  assert.equal(thinking.closingEvents(), null)
})

test('an unstarted stream reports that, and an error event names overloaded_error', () => {
  const tracker = createAnthropicStreamTracker()
  assert.equal(tracker.hasStarted(), false)
  assert.equal(tracker.isFinished(), false)
  const event = buildAnthropicSseError({
    type: 'overloaded_error',
    code: 'pool_overloaded',
    message: '号池负载过高，稍后再试',
    details: { reason: 'pool_deadline_exceeded' },
  })
  assert.match(event, /^event: error\ndata: /)
  const payload = JSON.parse(event.split('\n')[1].slice(5).trim())
  assert.equal(payload.type, 'error')
  assert.equal(payload.error.type, 'overloaded_error')
  assert.equal(payload.error.code, 'pool_overloaded')
  assert.equal(payload.error.details, undefined)
})

test('a worker timeout is not closed as max_tokens', () => {
  assert.equal(isRecoverableTruncation({ ok: false }), true)
  assert.equal(
    isRecoverableTruncation({ body: { error: { code: 'worker_timeout', message: 'slot worker idle timeout' } } }),
    false,
  )
})

test('streaming Usage Policy SSE error remaps to policy_blocked / refusal_guard (#503)', () => {
  const msg =
    'provider error: provider error: API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy (https://www.anthropic.com/legal/aup). Try rephrasing the request'
  const upstream = JSON.stringify({
    type: 'error',
    error: { type: 'invalid_request_error', message: msg },
  })
  const remapper = createAnthropicSseErrorRemapper()
  remapper.remapLine('event: error\n')
  const remapped = remapper.remapLine(`data: ${upstream}\n`)
  assert.match(remapped, /^data: /)
  const payload = JSON.parse(remapped.trim().slice(5))
  assert.equal(payload.type, 'error')
  assert.equal(payload.error.type, 'policy_blocked')
  assert.equal(payload.error.code, 'refusal_guard')
  assert.notEqual(payload.error.type, 'invalid_request_error')
  assert.notEqual(payload.error.code, 'upstream_invalid_request')
  assert.equal(payload.error.details?.blocked_by, 'upstream')
  assert.equal(payload.error.details?.retryable, false)
})

test('non-error SSE lines pass through the Anthropic error remapper unchanged', () => {
  const remapper = createAnthropicSseErrorRemapper()
  const line = 'data: {"type":"message_start","message":{"id":"msg_1","content":[]}}\n'
  assert.equal(remapper.remapLine(line), line)
})

// #689: the kernel's own terminal frame when its 256-frame / 2 MiB job sink overflows.
const KERNEL_OVERFLOW = {
  type: 'error',
  error: { type: 'api_error', code: 'kernel_error', message: 'job stream overflow' },
}

test('#689 job stream overflow maps to kernel_stream_overflow, not an upstream error', () => {
  assert.equal(isKernelStreamOverflow(KERNEL_OVERFLOW), true)
  assert.equal(isKernelStreamOverflow({ body: KERNEL_OVERFLOW }), true)
  assert.equal(isKernelStreamOverflow({ error: { code: 'kernel_error', message: 'boom' } }), false)
  const mapped = mapUpstreamError(502, KERNEL_OVERFLOW)
  assert.equal(mapped.status, 502)
  assert.equal(mapped.body.error.code, 'kernel_stream_overflow')
  assert.equal(mapped.body.error.type, 'api_error')
  assert.equal(mapped.body.error.details.owner, 'gateway')
  // The status a kernel failure arrives with does not turn it into an auth / rate / overload error.
  for (const status of [400, 429, 500, 529]) {
    assert.equal(mapUpstreamError(status, KERNEL_OVERFLOW).body.error.code, 'kernel_stream_overflow', String(status))
  }
  // Other kernel errors keep their code.
  assert.equal(
    mapUpstreamError(502, { error: { code: 'kernel_error', message: 'boom' } }).body.error.code,
    'kernel_error',
  )
})

test('#689 the streamed overflow frame carries the gateway request id', () => {
  const remapper = createAnthropicSseErrorRemapper({ requestId: 'req-kin-689' })
  remapper.remapLine('event: error\n')
  const payload = JSON.parse(
    remapper
      .remapLine(`data: ${JSON.stringify(KERNEL_OVERFLOW)}\n`)
      .trim()
      .slice(5),
  )
  assert.equal(payload.error.code, 'kernel_stream_overflow')
  assert.equal(payload.error.type, 'api_error')
  assert.equal(payload.error.request_id, 'req-kin-689')
  // An upstream request id already on the frame is kept.
  remapper.remapLine('event: error\n')
  const upstream = { type: 'error', error: { type: 'api_error', message: 'x', request_id: 'req_upstream' } }
  const kept = JSON.parse(
    remapper
      .remapLine(`data: ${JSON.stringify(upstream)}\n`)
      .trim()
      .slice(5),
  )
  assert.equal(kept.error.request_id, 'req_upstream')
  const closing = buildAnthropicSseError({
    type: 'api_error',
    code: 'kernel_stream_overflow',
    request_id: 'req-kin-689',
  })
  assert.equal(JSON.parse(closing.split('\n')[1].slice(5)).error.request_id, 'req-kin-689')
})

test('#689 overflow writes one structured log with what reached the client', (t) => {
  const meter = createStreamForwardMeter()
  meter.note('event: message_start\n')
  meter.note('data: {"type":"message_start"}\n')
  meter.note('\n')
  meter.note('data: {"a":1}\n\ndata: {"b":"data: inner"}\n\n')
  assert.deepEqual(meter.snapshot(), {
    bytes: Buffer.byteLength(
      'event: message_start\ndata: {"type":"message_start"}\n\ndata: {"a":1}\n\ndata: {"b":"data: inner"}\n\n',
    ),
    frames: 3,
  })
  const lines = []
  t.mock.method(console, 'warn', (line) => lines.push(line))
  const result = {
    ok: false,
    status: 502,
    vmId: 'vm-7',
    accountId: 'acct-7',
    attemptCount: 1,
    committed: true,
    body: KERNEL_OVERFLOW,
  }
  const entry = reportKernelStreamOverflow(result, {
    requestId: 'req-kin-689',
    protocol: 'anthropic.messages',
    model: 'claude-sonnet-5-5',
    forwarded: meter,
  })
  assert.equal(lines.length, 1)
  assert.deepEqual(JSON.parse(lines[0]), entry)
  assert.equal(entry.event, 'kernel_stream_overflow')
  assert.equal(entry.request_id, 'req-kin-689')
  assert.equal(entry.vm_id, 'vm-7')
  assert.equal(entry.forwarded_frames, 3)
  assert.equal(entry.forwarded_bytes, meter.snapshot().bytes)
  assert.equal(
    reportKernelStreamOverflow({ ok: false, body: { error: { code: 'kernel_error', message: 'boom' } } }),
    null,
  )
  assert.equal(lines.length, 1)
})

test('#689 request logs class the overflow as a platform fault, old rows included', () => {
  const fresh = classifyRequestError({
    status: 502,
    error_code: 'kernel_stream_overflow',
    error_message: 'job stream overflow',
  })
  assert.equal(fresh.error_class, 'other')
  assert.equal(fresh.error_owner, 'platform')
  const legacy = classifyRequestError({ status: 502, error_code: 'kernel_error', error_message: 'job stream overflow' })
  assert.equal(legacy.error_class, 'other')
  assert.equal(
    classifyRequestError({ status: 502, error_code: 'kernel_error', error_message: 'boom' }).error_class,
    'upstream',
  )
})
