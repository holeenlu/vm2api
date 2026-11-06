/**
 * 客户视角的 usage：计费与返回给客户的 usage 都由这里的同一份实现得出。
 *
 * 1. 网关注入的 token（persona / overlay / 注入工具，见
 *    identity/crs-persona-usage.mjs 的 gatewayInjectedTokens）不由客户承担。
 *    注入量按字符估算，最多扣到只剩客户自己内容的下限（callerPromptTokenFloor）。
 *    注入内容位于提示词最前面（tools → system → 首条 user 的 reminder），
 *    而 Anthropic 的 usage 沿提示词顺序依次是 cache_read → cache_creation
 *    （1h 段在 5m 段之前）→ 未缓存 input，所以按这个顺序扣减，任何桶都不会为负。
 * 2. 缓存计费跟随客户自己的 cache_control 语义（protocol/cache-ttl.mjs 的
 *    customerCacheIntent）：'none' 时缓存读写全部按普通 input 计；'5m' 时缓存写入
 *    按 5m 计；'1h' 或未知时按上游实际拆分计。
 *
 * usage_logs 的 token 列与 total_cost 仍记录上游真实消耗（账号侧口径），只有
 * 计费（billing_charges / actual_cost / Key 用量）和客户响应使用这里的结果。
 */

function n(value) {
  const x = Number(value)
  return Number.isFinite(x) && x > 0 ? x : 0
}

function has(obj, key) {
  return obj[key] != null
}

/** 无需改写时返回 null，调用方原样透传。 */
function activeView(view) {
  if (!view || typeof view !== 'object') return null
  const injected = Math.max(0, Math.floor(n(view.injectedTokens)))
  const intent = view.cacheIntent === 'none' || view.cacheIntent === '5m' ? view.cacheIntent : null
  if (!injected && !intent) return null
  return { injected, intent, floor: Math.max(0, Math.floor(n(view.callerTokens))) }
}

/** Anthropic（不相交）形状的 usage → 客户视角 usage。不修改入参。 */
export function customerUsage(usage, view) {
  if (!usage || typeof usage !== 'object') return usage
  const active = activeView(view)
  if (!active) return usage
  const nested = usage.cache_creation && typeof usage.cache_creation === 'object' ? usage.cache_creation : null
  let input = n(usage.input_tokens)
  let read = n(usage.cache_read_input_tokens ?? usage.cache_read_tokens)
  let five = n(usage.cache_creation_5m_tokens ?? nested?.ephemeral_5m_input_tokens)
  let hour = n(usage.cache_creation_1h_tokens ?? nested?.ephemeral_1h_input_tokens)
  // 只有总数没有拆分（或 message_delta 抬高了总数）的部分按 cache_ttl 归档，与计价一致
  const unsplit = n(usage.cache_creation_input_tokens ?? usage.cache_creation_tokens) - five - hour
  if (unsplit > 0) {
    if (usage.cache_ttl === '1h') hour += unsplit
    else five += unsplit
  }
  const promptBefore = input + read + five + hour

  // 注入量是估算值：最多扣到只剩客户自己内容的下限（callerPromptTokenFloor）
  let left = Math.min(active.injected, Math.max(0, promptBefore - active.floor))
  const take = (bucket) => {
    const cut = Math.min(bucket, left)
    left -= cut
    return bucket - cut
  }
  read = take(read)
  hour = take(hour)
  five = take(five)
  input = take(input)

  if (active.intent === 'none') {
    input += read + five + hour
    read = 0
    five = 0
    hour = 0
  } else if (active.intent === '5m') {
    five += hour
    hour = 0
  }

  const out = { ...usage }
  if (has(usage, 'input_tokens') || input > 0) out.input_tokens = input
  if (has(usage, 'cache_read_input_tokens')) out.cache_read_input_tokens = read
  if (has(usage, 'cache_read_tokens')) out.cache_read_tokens = read
  if (has(usage, 'cache_creation_input_tokens')) out.cache_creation_input_tokens = five + hour
  if (has(usage, 'cache_creation_tokens')) out.cache_creation_tokens = five + hour
  if (has(usage, 'cache_creation_5m_tokens')) out.cache_creation_5m_tokens = five
  if (has(usage, 'cache_creation_1h_tokens')) out.cache_creation_1h_tokens = hour
  if (nested) {
    out.cache_creation = { ...nested, ephemeral_5m_input_tokens: five, ephemeral_1h_input_tokens: hour }
  }
  if (active.intent === '5m' && has(usage, 'cache_ttl')) out.cache_ttl = '5m'
  if (has(usage, 'total_tokens')) {
    out.total_tokens = Math.max(0, n(usage.total_tokens) - promptBefore + input + read + five + hour)
  }
  return out
}

export function customerUsageInEvent(event, view) {
  if (!event || typeof event !== 'object' || !activeView(view)) return event
  const out = { ...event }
  if (out.usage) out.usage = customerUsage(out.usage, view)
  if (out.message && typeof out.message === 'object' && out.message.usage) {
    out.message = { ...out.message, usage: customerUsage(out.message.usage, view) }
  }
  return out
}

export function customerUsageInSseLine(line, view) {
  if (line == null || !activeView(view)) return line
  const raw = String(line)
  const m = raw.match(/^(data:\s*)(.*)$/)
  if (!m || !m[2] || m[2] === '[DONE]' || !m[2].includes('usage')) return raw
  try {
    return m[1] + JSON.stringify(customerUsageInEvent(JSON.parse(m[2]), view))
  } catch {
    return raw
  }
}

export function customerUsageOnMessage(body, view) {
  if (!body || typeof body !== 'object' || !body.usage || !activeView(view)) return body
  return { ...body, usage: customerUsage(body.usage, view) }
}
