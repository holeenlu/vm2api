import { createHash } from 'node:crypto'
import { SettingsRepo } from '../db/repos/settings-repo.mjs'
import { audit, relayError } from './relay-common.mjs'

export const DEFAULT_BRANDING = Object.freeze({
  name: 'tapmodels',
  tagline: '管理台',
  taglines: Object.freeze({
    'zh-CN': '管理台',
    'zh-TW': '管理台',
    'en-US': 'Console',
    'ja-JP': '管理コンソール',
  }),
  logo_url: '',
  favicon_url: '',
})

export function siteBranding(db) {
  const saved = new SettingsRepo(db).get('site_branding', {})
  const result = Object.fromEntries(
    Object.keys(DEFAULT_BRANDING).map((key) => [key, saved[key] ?? DEFAULT_BRANDING[key]]),
  )
  if (saved.taglines && typeof saved.taglines === 'object' && !Array.isArray(saved.taglines)) {
    result.taglines = { ...DEFAULT_BRANDING.taglines, ...saved.taglines }
  } else if (saved.tagline != null) {
    delete result.taglines
  }
  return result
}

function imageURL(value) {
  if (typeof value !== 'string' || value.length > 360000) throw relayError('invalid_brand_image', '图片需小于 256 KB')
  const v = value.trim()
  if (!v || /^\/(?!\/)[^\s\\]*$/.test(v) || /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(v)) return v
  try {
    const url = new URL(v)
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url.href
  } catch {}
  throw relayError('invalid_brand_image', '请使用 HTTP(S) 图片地址、站内路径或 PNG/JPEG/WebP 图片')
}

const SITE_ICON_PATHS = new Set([
  '/favicon.ico',
  '/favicon.png',
  '/favicon.svg',
  '/images/favicon.svg',
  '/images/favicon_light.svg',
  '/images/favicon.png',
  '/images/favicon_light.png',
  '/images/favicon_32.png',
  '/images/favicon_64.png',
  '/images/favicon_128.png',
  '/images/favicon_512.png',
])

// Browsers also fetch these URLs before the SPA loads and when saving site icons.
export function tryServeSiteIcon(res, pathname, db) {
  if (!SITE_ICON_PATHS.has(pathname) || !['GET', 'HEAD'].includes(res.req?.method)) return false
  const branding = siteBranding(db)
  let source
  try {
    source = imageURL(branding.favicon_url || branding.logo_url || '')
  } catch {
    return false
  }
  if (!source) return false

  const headers = { 'cache-control': 'public, max-age=0, must-revalidate', 'x-content-type-options': 'nosniff' }
  const embedded = source.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+=*)$/)
  if (embedded) {
    const body = Buffer.from(embedded[2], 'base64')
    const etag = `"${createHash('sha256').update(body).digest('hex')}"`
    const matches = String(res.req.headers?.['if-none-match'] || '')
      .split(',')
      .some((tag) => tag.trim().replace(/^W\//, '') === etag || tag.trim() === '*')
    if (matches) {
      res.writeHead(304, { ...headers, etag })
      res.end()
    } else {
      res.writeHead(200, { ...headers, etag, 'content-type': embedded[1], 'content-length': body.length })
      res.end(res.req.method === 'HEAD' ? undefined : body)
    }
    return true
  }

  // Keep URL-based images client-loaded; do not introduce a server-side image fetch.
  // A configured built-in icon must fall through to its static asset, not redirect to itself.
  const origin = new URL(`http://${res.req.headers?.host || 'localhost'}`)
  const target = new URL(source, origin)
  if (target.host === origin.host && SITE_ICON_PATHS.has(target.pathname)) return false
  res.writeHead(302, { ...headers, location: source })
  res.end()
  return true
}

export function saveSiteBranding(db, input, actor) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some((k) => !Object.hasOwn(DEFAULT_BRANDING, k))
  )
    throw relayError('invalid_branding', '品牌设置字段不正确')
  const before = siteBranding(db)
  const next = { ...before }
  for (const key of ['name', 'tagline']) {
    if (!Object.hasOwn(input, key)) continue
    if (typeof input[key] !== 'string' || input[key].trim().length > 80 || /[\x00-\x1f\x7f]/.test(input[key]))
      throw relayError('invalid_branding', '品牌名称和副标题需为 80 字以内的文本')
    next[key] = input[key].trim()
  }
  if (Object.hasOwn(input, 'taglines')) {
    if (!input.taglines || typeof input.taglines !== 'object' || Array.isArray(input.taglines))
      throw relayError('invalid_branding', '多语言副标题格式不正确')
    next.taglines = { ...(before.taglines || {}), ...next.taglines }
    for (const [locale, value] of Object.entries(input.taglines)) {
      if (typeof value !== 'string' || value.trim().length > 80 || /[\x00-\x1f\x7f]/.test(value))
        throw relayError('invalid_branding', '多语言副标题需为 80 字以内的文本')
      next.taglines[locale] = value.trim()
    }
  }
  if (!next.name) throw relayError('invalid_branding', '品牌名称不能为空')
  for (const key of ['logo_url', 'favicon_url']) if (Object.hasOwn(input, key)) next[key] = imageURL(input[key])
  new SettingsRepo(db).set('site_branding', next)
  audit(db, actor, 'site.branding', 'site', { name: before.name }, { name: next.name })
  return next
}
