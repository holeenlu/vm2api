/**
 * 粘贴凭证的统一识别：虚拟机导入（/api/panel/vms/import）与供应商开户草稿导入共用同一套规则。
 * 这里只做识别与归一化；需要联网的换票（sessionKey 换 OAuth、Refresh Token 换 Access Token）
 * 由调用方按各自的执行环境完成（槽位内执行或经代理直连），错误码与响应形状也由调用方决定。
 */
import { pastedAccessTokenToOauth } from './claude-setup-token.mjs'
import { looksLikeConsoleApiKey } from './credential-mode.mjs'
import { isSub2apiAccountExport, sub2apiAccountToOauth } from './sub2api-account.mjs'
import { parseCodexImportPayload } from '../vm/codex-slot.mjs'

const lower = (value) => String(value || '').toLowerCase()

/**
 * Claude 凭证：Console API Key、sessionKey、sub2api 账号导出或 Access Token。
 * 返回 { kind, oauth?, sessionKey?, scope? }；kind 为 invalid_api_key / missing 时调用方按自己的错误码拒绝。
 * `existing` 是已有槽位记录，只用于 sub2api 导出缺邮箱等身份时沿用。
 */
export function classifyClaudePaste(body = {}, existing = {}) {
  const sessionKey = String(body.sessionKey || body.session_key || body.sid || '').trim()
  const accessToken = String(body.access_token || body.token || '').trim()
  const apiKey = String(body.api_key || body.apiKey || '').trim()
  const requested = lower(body.type || body.credential_mode || body.scope)
  const authScheme = body.auth_scheme || body.authScheme || undefined
  const candidate = apiKey || sessionKey || accessToken
  if (looksLikeConsoleApiKey(candidate) || requested === 'apikey' || requested === 'console') {
    if (!looksLikeConsoleApiKey(candidate)) return { kind: 'invalid_api_key' }
    return {
      kind: 'apikey',
      oauth: {
        type: 'apikey',
        mode: 'apikey',
        api_key: candidate,
        access_token: candidate,
        base_url: body.base_url || body.baseUrl || 'https://api.anthropic.com',
        source: 'console-api-key',
        auth_scheme: authScheme,
      },
    }
  }
  if (sessionKey) {
    const inference =
      ['inference', 'setup-token', 'setup_token'].includes(requested) || lower(body.scope) === 'inference'
    return { kind: 'session_key', sessionKey, scope: inference ? 'inference' : 'full', authScheme }
  }
  const exportDoc = body.sub2api || body.account || body
  if (isSub2apiAccountExport(exportDoc))
    return { kind: 'sub2api', oauth: withAuthScheme(sub2apiAccountToOauth(exportDoc, existing), authScheme) }
  if (accessToken)
    return {
      kind: 'access_token',
      oauth: withAuthScheme(
        {
          ...pastedAccessTokenToOauth(accessToken, body),
          email: body.email || null,
          account_uuid: body.account_uuid || null,
          org_uuid: body.org_uuid || null,
        },
        authScheme,
      ),
    }
  return { kind: 'missing' }
}

/** sessionKey 换票结果：仅推理范围时记为 Setup Token，并带上请求指定的认证方式。 */
export function sessionKeyOauth(oauth, paste) {
  const next = withAuthScheme(oauth, paste.authScheme)
  if (paste.scope === 'inference') {
    next.type = 'setup-token'
    next.mode = 'setup-token'
  }
  return next
}

function withAuthScheme(oauth, authScheme) {
  if (authScheme) oauth.auth_scheme = authScheme
  return oauth
}

/**
 * Codex 账号文件 / JSON：解析后若只有 Refresh Token，调用 `refresh(refreshToken)` 换 Access Token。
 * `refresh` 返回 refreshCodexAccessToken 的结果形状；返回非 ok 时原样放在 result 里交回调用方映射错误。
 * 返回 { ok: true, account } | { ok: false, stage: 'parse', code, message } | { ok: false, stage: 'refresh', result }
 */
export async function resolveCodexPaste(body, refresh) {
  const parsed = parseCodexImportPayload(body)
  if (!parsed.ok)
    return {
      ok: false,
      stage: 'parse',
      code: parsed.error || 'invalid_codex_credential',
      message: parsed.message || 'Codex 凭证无效',
    }
  const account = { ...parsed.account }
  if (!account.access_token && account.refresh_token) {
    const result = await refresh(account.refresh_token)
    if (!result?.ok) return { ok: false, stage: 'refresh', result: result || null }
    account.access_token = result.access_token
    account.refresh_token = result.refresh_token || account.refresh_token
    account.id_token = result.id_token || account.id_token
    account.expires_at = result.expires_at || account.expires_at
  }
  return { ok: true, account }
}
