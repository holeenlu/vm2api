/**
 * 单一 SSE 事件解析与带背压的写出（审计阶段 2 W15）。
 *
 * 解析：Codex（Responses）上游的每条 `data:` 行只 JSON.parse 一次，结果随行一起交给各个消费方（终态校验、模型与续接归属、
 * 档位、用量、生图用量、协议转换、事件命名）；此前 VM 路径同一行最多解析 6–7 次。
 *
 * 背压：写给客户端的 `res.write` 返回 false（内核缓冲已满）时等 `drain` 再继续读上游，最多等 DRAIN_WAIT_MS；
 * 上限避免一个读得很慢的客户端让上游空闲超时（idle timeout）误判而中断整个流。客户端断开时立即返回。
 */

/** 一条 SSE 行的解析结果：{ skip } 非 data 行或无法解析；{ done } 空 data 或 [DONE]；{ event } 解析出的对象。 */
export function parseSseLine(line) {
  const trimmed = String(line || '').trim()
  if (!trimmed.startsWith('data:')) return { skip: true }
  const data = trimmed.slice(5).trim()
  if (!data || data === '[DONE]') return { done: true }
  try {
    const event = JSON.parse(data)
    return event && typeof event === 'object' ? { event } : { skip: true }
  } catch {
    return { skip: true }
  }
}

/** data 行解析出的事件对象；不是 data 行、结束标记或无法解析时为 null。 */
export function sseDataEvent(line) {
  return parseSseLine(line).event || null
}

/** 消费方可以拿到调用方已解析的事件：传入的是对象就直接用，否则解析这一行。 */
export function sseEventOf(line, event) {
  if (event && typeof event === 'object') return { event }
  return parseSseLine(line)
}

export const DRAIN_WAIT_MS = 10_000

/**
 * 写一段数据；写缓冲已满时等待 drain（最多 maxWaitMs），客户端关闭或已结束时立即返回。
 * 返回 res.write 的原始结果。
 */
export async function writeWithBackpressure(res, chunk, { maxWaitMs = DRAIN_WAIT_MS } = {}) {
  const ok = res.write(chunk)
  if (ok !== false || res.writableEnded || res.destroyed || typeof res.once !== 'function') return ok
  await new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      res.off?.('drain', done)
      res.off?.('close', done)
      resolve()
    }
    const timer = setTimeout(done, maxWaitMs)
    timer.unref?.()
    res.once('drain', done)
    res.once('close', done)
  })
  return ok
}
