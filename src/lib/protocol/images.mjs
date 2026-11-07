import dns from 'node:dns/promises'
import net from 'node:net'
/**
 * OpenAI image_url content parts → Claude image content blocks
 */

export function openaiImagePartToClaude(part) {
  // OpenAI: { type: 'image_url', image_url: { url: 'data:image/png;base64,...' | 'https://...' } }
  if (!part || part.type !== 'image_url') return null
  const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url
  if (!url) return null

  if (url.startsWith('data:')) {
    const m = url.match(/^data:([^;]+);base64,(.+)$/s)
    if (!m) return null
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: m[1] || 'image/png',
        data: m[2],
      },
    }
  }

  // remote URL — Claude supports type:url on some endpoints
  return {
    type: 'image',
    source: {
      type: 'url',
      url,
    },
  }
}

/** Convert OpenAI message content (string | array) to Claude content blocks. */
export function openaiContentToClaudeContent(content) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  if (!Array.isArray(content)) {
    const text = String(content ?? '')
    return text ? [{ type: 'text', text }] : []
  }

  const blocks = []
  for (const p of content) {
    if (typeof p === 'string') {
      if (p) blocks.push({ type: 'text', text: p })
      continue
    }
    if (p?.type === 'text' || p?.type === 'input_text') {
      const block = { type: 'text', text: p.text || '' }
      if (p.cache_control) block.cache_control = p.cache_control
      blocks.push(block)
      continue
    }
    if (p?.type === 'image_url') {
      const img = openaiImagePartToClaude(p)
      if (img) blocks.push(p.cache_control ? { ...img, cache_control: p.cache_control } : img)
      continue
    }
  }

  return blocks
}

/**
 * Native Messages callers still send OpenAI-shaped `image_url` parts, which
 * Anthropic rejects with `Input tag 'image_url' … does not match any of the
 * expected tags`. Only `convert.mjs` used to fix that, so the /v1/messages hop
 * passed them straight through.
 *
 * Parts carrying no usable url stay untouched: the upstream 400 should keep
 * naming the real defect instead of silently dropping the caller's image.
 */
export function normalizeImageContentBlocks(content) {
  if (!Array.isArray(content)) return content
  let changed = false
  const blocks = content.map((block) => {
    if (!block || typeof block !== 'object') return block
    if (block.type === 'tool_result' && Array.isArray(block.content)) {
      const nested = normalizeImageContentBlocks(block.content)
      if (nested === block.content) return block
      changed = true
      return { ...block, content: nested }
    }
    if (block.type !== 'image_url') return block
    const image = openaiImagePartToClaude(block)
    if (!image) return block
    changed = true
    return block.cache_control ? { ...image, cache_control: block.cache_control } : image
  })
  return changed ? blocks : content
}

const IMAGE_FETCH_MS = 20_000
const IMAGE_FETCH_MAX = 8 * 1024 * 1024

function mediaTypeFrom(contentType, url) {
  const raw = String(contentType || '')
    .split(';')[0]
    .trim()
    .toLowerCase()
  if (raw.startsWith('image/')) return raw
  const ext = String(url || '')
    .split('?')[0]
    .split('.')
    .pop()
    ?.toLowerCase()
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'png') return 'image/png'
  return 'image/png'
}

// 远程图片由控制面代客户端抓取：只允许公网地址，逐跳校验重定向，流式限长（审计 P1-S1，SSRF）。
// DNS 解析与实际连接之间仍有重绑定窗口，彻底消除需要按解析结果固定连接地址（阶段 1）。
const IMAGE_FETCH_MAX_REDIRECTS = 3

function ipv4Blocked(ip) {
  const p = ip.split('.').map(Number)
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b] = p
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && p[2] === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  )
}

/** 回环、私网、链路本地、CGNAT、组播、保留与元数据地址一律不抓。 */
export function isBlockedImageAddress(address) {
  const ip = String(address || '').toLowerCase()
  if (!net.isIP(ip)) return true
  if (net.isIPv4(ip)) return ipv4Blocked(ip)
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return ipv4Blocked(mapped[1])
  return (
    ip === '::' ||
    ip === '::1' ||
    ip.startsWith('fe8') ||
    ip.startsWith('fe9') ||
    ip.startsWith('fea') ||
    ip.startsWith('feb') ||
    ip.startsWith('fc') ||
    ip.startsWith('fd') ||
    ip.startsWith('ff') ||
    ip.startsWith('64:ff9b:') ||
    ip.startsWith('2001:db8:')
  )
}

async function assertPublicImageUrl(raw, lookup) {
  let url
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (url.username || url.password) return null
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const addresses = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true })
  if (!addresses?.length || addresses.some((entry) => isBlockedImageAddress(entry?.address))) return null
  return url
}

async function readLimited(res, limit) {
  const declared = Number(res.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > limit) return null
  const reader = res.body?.getReader?.()
  if (!reader) {
    const buf = Buffer.from(await res.arrayBuffer())
    return buf.length > limit ? null : buf
  }
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

async function fetchImageAsBase64(url, fetchImpl, { lookup = dns.lookup, signal } = {}) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), IMAGE_FETCH_MS)
  const onAbort = () => ac.abort()
  signal?.addEventListener?.('abort', onAbort, { once: true })
  try {
    let next = url
    for (let hop = 0; hop <= IMAGE_FETCH_MAX_REDIRECTS; hop++) {
      const target = await assertPublicImageUrl(next, lookup)
      if (!target) return null
      const res = await fetchImpl(target.href, { signal: ac.signal, redirect: 'manual' })
      const status = Number(res.status) || 0
      if (status >= 300 && status < 400) {
        const location = res.headers?.get?.('location')
        if (!location) return null
        next = new URL(location, target).href
        continue
      }
      if (!res.ok) return null
      const buf = await readLimited(res, IMAGE_FETCH_MAX)
      if (!buf?.length) return null
      return {
        type: 'base64',
        media_type: mediaTypeFrom(res.headers.get('content-type'), target.href),
        data: buf.toString('base64'),
      }
    }
    return null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
  }
}

async function materializeBlock(block, fetchImpl, options) {
  if (!block || typeof block !== 'object') return block
  if (block.type === 'tool_result' && Array.isArray(block.content)) {
    const nested = []
    for (const child of block.content) nested.push(await materializeBlock(child, fetchImpl, options))
    return { ...block, content: nested }
  }
  const url =
    block.type === 'image' && block.source?.type === 'url'
      ? String(block.source.url || '')
      : block.type === 'image_url'
        ? typeof block.image_url === 'string'
          ? block.image_url
          : String(block.image_url?.url || '')
        : ''
  if (!/^https?:\/\//i.test(url)) return block
  const source = await fetchImageAsBase64(url, fetchImpl, options)
  if (!source) return block
  const image = { type: 'image', source }
  return block.cache_control ? { ...image, cache_control: block.cache_control } : image
}

/** Wrap CLI / SDK often reject `image.source.type=url`. Fetch to base64; leave URL if fetch fails. */
export async function materializeRemoteImageSources(body, { fetchImpl = fetch, lookup, signal } = {}) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) return body
  let changed = false
  const messages = []
  for (const msg of body.messages) {
    if (!msg || typeof msg !== 'object' || !Array.isArray(msg.content)) {
      messages.push(msg)
      continue
    }
    const content = []
    for (const block of msg.content) {
      const next = await materializeBlock(block, fetchImpl, { lookup, signal })
      if (next !== block) changed = true
      content.push(next)
    }
    messages.push({ ...msg, content })
  }
  return changed ? { ...body, messages } : body
}
