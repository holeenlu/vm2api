import { SettingsRepo } from '../db/repos/settings-repo.mjs'
import { audit, relayError } from './relay-common.mjs'

export const DEFAULT_BRANDING = Object.freeze({ name: 'tapmodels', tagline: '管理台', logo_url: '', favicon_url: '' })

export function siteBranding(db) {
  const saved = new SettingsRepo(db).get('site_branding', {})
  return Object.fromEntries(Object.keys(DEFAULT_BRANDING).map((key) => [key, saved[key] ?? DEFAULT_BRANDING[key]]))
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
  if (!next.name) throw relayError('invalid_branding', '品牌名称不能为空')
  for (const key of ['logo_url', 'favicon_url']) if (Object.hasOwn(input, key)) next[key] = imageURL(input[key])
  new SettingsRepo(db).set('site_branding', next)
  audit(db, actor, 'site.branding', 'site', { name: before.name }, { name: next.name })
  return next
}
