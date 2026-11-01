import { consumeClaudeSSEData } from './convert.mjs'

const counter = (value) => Number.isSafeInteger(value) && value >= 0
export function hasCompleteUsage(usage) {
  return (
    !!usage &&
    counter(usage.input_tokens ?? usage.prompt_tokens) &&
    counter(usage.output_tokens ?? usage.completion_tokens)
  )
}

/** Collect supplier usage before conversion/persona hiding. Initial output=0 is
 * provisional; only a terminal usage event makes counters safe for settlement.
 * HTTP success and message_stop alone do not supply missing counters. */
export function createUsageEvidence() {
  let usage = null
  let complete = false
  const parser = { dataBuf: '' }
  const observe = (event) => {
    if (!event) return
    if (event.type === 'message_start') {
      usage = event.message?.usage ? { ...event.message.usage } : null
      complete = false
    } else if (event.type === 'message_delta') {
      if (event.usage) usage = { ...usage, ...event.usage }
      if (event.delta?.stop_reason && counter(event.usage?.output_tokens)) complete = hasCompleteUsage(usage)
    } else if (/^response\.(completed|done|failed|incomplete)$/.test(event.type || '')) {
      usage = event.response?.usage || event.usage || null
      complete = hasCompleteUsage(usage)
    }
  }
  return {
    observe,
    line(line) {
      const event = consumeClaudeSSEData(line, parser)
      observe(event)
      return event
    },
    snapshot() {
      return { usage, usageComplete: complete }
    },
  }
}
