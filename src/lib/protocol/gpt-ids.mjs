/** GPT chat ids. No I/O. */

export const SKIP_GPT =
  /^(whisper|tts-|dall-e|chatgpt-image|gpt-image|text-embedding|text-moderation|omni-moderation|davinci|babbage|curie)/i

export const GPT_ID_PREFIX = /^gpt/i

/** Deployment policy: Astra and Sol use a 500k default window, independent of sync. */
export function gptContextWindowOverride(id) {
  const slug =
    String(id || '')
      .trim()
      .split('/')
      .filter(Boolean)
      .pop() || ''
  return /^gpt-\d+(?:\.\d+)?-(?:astra|sol)(?:-|$)/i.test(slug) ? 500000 : undefined
}

export function isGptSeriesId(id) {
  const s = String(id || '').trim()
  return GPT_ID_PREFIX.test(s) && !SKIP_GPT.test(s)
}

/** ChatGPT 网页目录里的 wm / luna-wm 变体，Codex 账号请求会 400。gpt-6-luna 是正式模型。 */
export function isSyncableGptCatalogId(id) {
  const slug = String(id || '').trim()
  if (!isGptSeriesId(slug)) return false
  if (/luna-wm/i.test(slug) || /(?:^|[-_])wm(?:[-_]|$)/i.test(slug)) return false
  return true
}
