/**
 * routing failover.eager_tool_streaming (default on): mark every custom tool
 * eager_input_streaming, the shape official Claude Code sends when its
 * fine-grained tool streaming is on. Without it upstream buffers a whole Write
 * content and stays silent for minutes, which trips the stream idle limit.
 * Official Claude Code only enables it on a first-party base URL, so relayed
 * clients never send it. Explicit false disables; a caller's own boolean wins;
 * server tools are left alone.
 */
import { isAnthropicServerTool, isWebSearchTool } from './web-search.mjs'

export function eagerToolStreamingEnabled(routing) {
  return routing?.failover?.eager_tool_streaming !== false
}

export function callerEagerInputStreaming(tool) {
  if (typeof tool?.eager_input_streaming === 'boolean') return tool.eager_input_streaming
  const fn = tool?.function
  if (fn && typeof fn === 'object' && typeof fn.eager_input_streaming === 'boolean') {
    return fn.eager_input_streaming
  }
  return undefined
}

function isCustomTool(tool) {
  if (!tool || typeof tool !== 'object') return false
  if (isWebSearchTool(tool) || isAnthropicServerTool(tool)) return false
  if (tool.input_schema) return true
  if (tool.type === 'function' || tool.function) return true
  return !!(tool.parameters && (tool.name || tool.function?.name))
}

export function applyEagerToolStreaming(body, routing) {
  if (!eagerToolStreamingEnabled(routing) || !Array.isArray(body?.tools)) return body
  let changed = false
  const tools = body.tools.map((tool) => {
    if (!isCustomTool(tool)) return tool
    if (typeof callerEagerInputStreaming(tool) === 'boolean') return tool
    changed = true
    const next = { ...tool, eager_input_streaming: true }
    if (tool.function && typeof tool.function === 'object') {
      next.function = { ...tool.function, eager_input_streaming: true }
    }
    return next
  })
  return changed ? { ...body, tools } : body
}
