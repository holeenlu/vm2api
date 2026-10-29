/** Sub2API-compatible reachability report. No provider credentials or inference requests. */
import fetch from 'node-fetch'
import { createProxyAgent } from './proxy-agent.mjs'

export const QUALITY_TARGETS = Object.freeze([
  { target: 'openai', url: 'https://api.openai.com/v1/models', allowed: [401] },
  { target: 'anthropic', url: 'https://api.anthropic.com/v1/messages', allowed: [400, 401, 404, 405] },
  { target: 'gemini', url: 'https://generativelanguage.googleapis.com/$discovery/rest?version=v1beta', allowed: [200] },
  { target: 'grok', url: 'https://api.x.ai/v1/models', allowed: [401] },
])

export function classifyQualityResponse(target, status, headers, body = '') {
  const challenge =
    headers?.get?.('cf-mitigated') === 'challenge' ||
    (status === 403 && /cf-chl-|challenge-platform|Just a moment|Attention Required.*Cloudflare/i.test(body))
  if (challenge)
    return { status: 'challenge', message: '命中 Cloudflare challenge', cf_ray: headers?.get?.('cf-ray') || null }
  if (target.allowed.includes(status))
    return { status: 'pass', message: `HTTP ${status}${status >= 200 && status < 300 ? '' : '（目标可达）'}` }
  if (status === 429) return { status: 'warn', message: '目标返回 429，可能存在频控' }
  return { status: 'fail', message: `非预期状态码：${status}` }
}

export function summarizeQuality(items) {
  const counts = { passed_count: 0, warn_count: 0, failed_count: 0, challenge_count: 0 }
  for (const item of items)
    counts[
      { pass: 'passed_count', warn: 'warn_count', fail: 'failed_count', challenge: 'challenge_count' }[item.status]
    ]++
  const score =
    items[0]?.status !== 'pass'
      ? 0
      : Math.max(0, 100 - counts.warn_count * 10 - counts.failed_count * 22 - counts.challenge_count * 30)
  return {
    ...counts,
    score,
    grade: score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'F',
  }
}

async function probe(target, proxyUrl, signal, fetchImpl) {
  const begin = Date.now()
  let agent
  let response
  try {
    agent = proxyUrl ? createProxyAgent(String(proxyUrl)) : undefined
    response = await fetchImpl(target.url, {
      method: 'GET',
      agent,
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      redirect: 'manual',
      headers: {
        accept: 'application/json,text/html,*/*',
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
      },
    })
    const chunks = []
    let bytes = 0
    for await (const chunk of response.body || []) {
      const part = Buffer.from(chunk).subarray(0, 8192 - bytes)
      chunks.push(part)
      bytes += part.length
      if (bytes >= 8192) break
    }
    return {
      target: target.target,
      http_status: response.status,
      latency_ms: Date.now() - begin,
      ...classifyQualityResponse(target, response.status, response.headers, Buffer.concat(chunks).toString()),
    }
  } catch (error) {
    signal.throwIfAborted()
    return {
      target: target.target,
      status: 'fail',
      latency_ms: Date.now() - begin,
      message:
        error.name === 'AbortError' || error.name === 'TimeoutError' ? '检测超时' : '连接失败，请检查出口或目标服务',
    }
  } finally {
    response?.body?.destroy?.()
    agent?.destroy?.()
  }
}

export async function checkProxyQuality({
  proxyId,
  proxyUrl,
  geoLookup,
  signal = new AbortController().signal,
  fetchImpl = fetch,
}) {
  const begin = Date.now()
  signal.throwIfAborted()
  const geo = await geoLookup(proxyUrl, { timeoutMs: 8000, signal })
  signal.throwIfAborted()
  const items = [
    {
      target: 'base_connectivity',
      status: geo.ok ? 'pass' : 'fail',
      latency_ms: Date.now() - begin,
      message: geo.ok ? '代理出口连通正常' : '无法通过该出口获取连通性信息',
    },
  ]
  if (geo.ok) items.push(...(await Promise.all(QUALITY_TARGETS.map((t) => probe(t, proxyUrl, signal, fetchImpl)))))
  signal.throwIfAborted()
  return {
    proxy_id: proxyId,
    checked_at: Math.floor(Date.now() / 1000),
    exit_ip: geo.geo?.ip || null,
    country: geo.geo?.country || null,
    country_code: geo.geo?.country_code || null,
    base_latency_ms: items[0].latency_ms,
    items,
    ...summarizeQuality(items),
  }
}
