/**
 * Upstream sometimes closes a Claude stream mid-response: no error event, no
 * message_stop. Interactive Claude Code then shows "Connection lost
 * mid-response" and ends the turn. It recovers from max_tokens everywhere:
 * a cut tool call comes back as an input validation error and the model
 * re-issues it, cut text gets the output-limit resume nudge. Once output
 * reached the client, close the message as max_tokens instead of dropping it.
 * A thinking block cut mid-way cannot be closed (it needs a signature).
 */

import { isKernelStreamOverflow, mapUpstreamError, rewritePoolErrorForClient } from '../core/errors.mjs'
import { semanticStatusForStreamError } from './stream-error-status.mjs'

const CLOSABLE_BLOCKS = new Set(['text', 'tool_use'])

function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/** Anthropic streaming error. `type` is what clients branch on (`overloaded_error`, …). */
export function buildAnthropicSseError(error = {}) {
  const body = {
    type: String(error.type || 'api_error'),
    message: String(error.message || 'An error occurred while processing the request'),
  }
  if (error.code) body.code = String(error.code)
  if (error.request_id) body.request_id = String(error.request_id)
  return sse('error', { type: 'error', error: body })
}

/**
 * Remap upstream `event: error` SSE data lines through mapUpstreamError so
 * streaming Anthropic clients see the same taxonomy as non-streaming responses.
 * `requestId` (the gateway request id) fills a frame that carries none, so the
 * caller can look the request up in the request logs (#689).
 */
export function createAnthropicSseErrorRemapper({ headers = {}, requestId = null } = {}) {
  let pendingEvent = null
  return {
    remapLine(line) {
      const text = String(line)
      const trimmed = text.trimEnd()
      const bare = trimmed.trim()
      if (bare.startsWith('event:')) {
        pendingEvent = bare.slice(6).trim()
        return line
      }
      if (bare === '') {
        pendingEvent = null
        return line
      }
      if (!bare.startsWith('data:') || pendingEvent !== 'error') return line
      pendingEvent = null
      let payload
      try {
        payload = JSON.parse(bare.slice(5).trim())
      } catch {
        return line
      }
      if (payload?.type !== 'error' && !payload?.error) return line
      const hopStatus = semanticStatusForStreamError(payload)
      const mapped = rewritePoolErrorForClient(mapUpstreamError(hopStatus, payload, headers), payload)
      const err = mapped.body?.error
      if (!err) return line
      const suffix = text.slice(trimmed.length)
      const data = JSON.stringify({
        type: 'error',
        error: {
          type: err.type,
          message: err.message,
          ...(err.code ? { code: err.code } : {}),
          ...(err.details && Object.keys(err.details).length ? { details: err.details } : {}),
          ...(err.request_id || requestId ? { request_id: err.request_id || requestId } : {}),
        },
      })
      return `data: ${data}${suffix || '\n'}`
    },
  }
}

export function createAnthropicStreamTracker() {
  let started = false
  let finished = false
  let open = null
  let outputTokens = 0
  return {
    observe(line) {
      const text = String(line)
      const dataLine = text
        .split('\n')
        .map((row) => row.trim())
        .find((row) => row.startsWith('data:'))
      if (!dataLine) return
      let event
      try {
        event = JSON.parse(dataLine.slice(5).trim())
      } catch {
        return
      }
      switch (event?.type) {
        case 'message_start':
          started = true
          outputTokens = event.message?.usage?.output_tokens || outputTokens
          break
        case 'content_block_start':
          open = { index: event.index, type: event.content_block?.type }
          break
        case 'content_block_stop':
          if (open?.index === event.index) open = null
          break
        case 'message_delta':
          outputTokens = event.usage?.output_tokens || outputTokens
          break
        case 'message_stop':
        case 'error':
          finished = true
          break
        default:
          break
      }
    },
    hasStarted() {
      return started
    },
    isFinished() {
      return finished
    },
    /** SSE text that ends the message as max_tokens, or null when it cannot be closed. */
    closingEvents() {
      if (!started || finished) return null
      if (open && !CLOSABLE_BLOCKS.has(open.type)) return null
      let out = ''
      if (open) out += sse('content_block_stop', { type: 'content_block_stop', index: open.index })
      out += sse('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'max_tokens', stop_sequence: null },
        usage: { output_tokens: outputTokens },
      })
      out += sse('message_stop', { type: 'message_stop' })
      finished = true
      return out
    },
  }
}

/** A timeout would just stall again if the client retries. An upstream error event already reached the client. */
export function isRecoverableTruncation(result) {
  const error = result?.body?.error
  if (!error) return true
  return !/timeout/i.test(`${error.code || ''} ${error.type || ''} ${error.message || ''}`)
}

/**
 * What already reached the client on this request (#689): bytes written and SSE
 * `data:` frames, across every attempt of the request.
 */
export function createStreamForwardMeter() {
  let bytes = 0
  let frames = 0
  return {
    note(text) {
      const chunk = String(text)
      bytes += Buffer.byteLength(chunk)
      for (let at = chunk.indexOf('data:'); at >= 0; at = chunk.indexOf('data:', at + 5)) {
        if (at === 0 || chunk[at - 1] === '\n') frames += 1
      }
    },
    snapshot() {
      return { bytes, frames }
    },
  }
}

/**
 * #689: one structured warning when the slot kernel ended a job with `job stream
 * overflow` (its 256-frame / 2 MiB in-flight sink filled because nothing drained it).
 * Returns the entry, or null when `result` is not that failure.
 */
export function reportKernelStreamOverflow(
  result,
  { requestId = null, protocol = null, model = null, forwarded = null } = {},
) {
  if (!isKernelStreamOverflow(result)) return null
  const sent = forwarded?.snapshot?.() || forwarded || {}
  const entry = {
    event: 'kernel_stream_overflow',
    request_id: requestId,
    vm_id: result?.vmId || null,
    account_id: result?.accountId || null,
    protocol,
    model,
    attempt_count: result?.attemptCount ?? null,
    committed: result?.committed === true,
    forwarded_bytes: Number(sent.bytes) || 0,
    forwarded_frames: Number(sent.frames) || 0,
  }
  console.warn(JSON.stringify(entry))
  return entry
}
