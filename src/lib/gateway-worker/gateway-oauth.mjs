/**
 * Gateway 账号授权（2026-11-07 S1，设计第 19 节）：与上游 VM 槽位同一做法，由控制面带账号出站代理生成授权链接、
 * 换码与刷新，结果由调用方在同一事务里写入凭据库；Worker 不再参与授权，只从库里读凭据。
 *
 * 原生 Codex OAuth 复用上游 codex-models.mjs 的常量、代理 fetch 与 Desktop 授权链接格式（codex-oauth.mjs 的
 * deriveCodexSurfaceStableId）；BPS（Excel 插件）授权的链接、令牌校验与身份比对移植自 Worker bps_auth.go。
 * 令牌端点可用 KIN_CODEX_GATEWAY_OAUTH_TOKEN_URL 覆盖（测试与本地开发用，与原 Worker 同名变量）；覆盖为环回地址时
 * 直连、不经账号代理（本机假令牌服务），其他地址照常经代理。
 */
import crypto from 'node:crypto'
import {
  CODEX_APP_VERSION,
  CODEX_OAUTH_AUTHORIZE_URL,
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_DESKTOP_AUTH_URL,
  CODEX_OAUTH_ORIGINATOR,
  CODEX_OAUTH_REDIRECT_URI,
  CODEX_OAUTH_SCOPE,
  CODEX_OAUTH_TOKEN_URL,
  CODEX_USER_AGENT,
  makeProxyFetch,
} from '../protocol/codex-models.mjs'
import { deriveCodexSurfaceStableId } from '../oauth/codex-oauth.mjs'
import { decodeJwtPayload } from '../oauth/openai-jwt.mjs'

export const GRANT_BPS = 'bps'
const BPS_SCOPE = 'openid offline_access email profile organization.read'
const AUTH_CLAIMS = 'https://api.openai.com/auth'
const PROFILE_CLAIMS = 'https://api.openai.com/profile'
const TOKEN_TIMEOUT_MS = 60_000

export function bpsConfig(env = process.env) {
  return {
    clientId: String(env.KIN_CODEX_GATEWAY_BPS_CLIENT_ID || '').trim() || 'app_fnr0pYvVwwFDocDumLG3H2Bp',
    authorizeUrl:
      String(env.KIN_CODEX_GATEWAY_BPS_AUTHORIZE_URL || '').trim() || 'https://auth.openai.com/api/accounts/authorize',
    redirectUri:
      String(env.KIN_CODEX_GATEWAY_BPS_REDIRECT_URI || '').trim() ||
      'https://bps.openai.com/basispoints/extension/360590d7-f8f9-4d88-bf75-0edfe0a4b9f3/auth/callback',
  }
}

const challengeOf = (verifier) => crypto.createHash('sha256').update(String(verifier)).digest('base64url')

/** 授权链接：原生为 Desktop 外层链接（与上游 VM 槽位相同），BPS 为 Excel 插件的浏览器 PKCE 链接。 */
export function gatewayAuthUrl({ state, codeVerifier, installationId, grant = null, env = process.env }) {
  if (grant === GRANT_BPS) {
    const bps = bpsConfig(env)
    const query = new URLSearchParams({
      client_id: bps.clientId,
      response_type: 'code',
      redirect_uri: bps.redirectUri,
      scope: BPS_SCOPE,
      state,
      code_challenge_method: 'S256',
      code_challenge: challengeOf(codeVerifier),
      audience: 'https://api.openai.com/v1',
      platform: 'PC',
    })
    return `${bps.authorizeUrl}?${query}`
  }
  const inner = new URL(CODEX_OAUTH_AUTHORIZE_URL)
  const stableId = deriveCodexSurfaceStableId(installationId)
  for (const [key, value] of Object.entries({
    response_type: 'code',
    client_id: CODEX_OAUTH_CLIENT_ID,
    redirect_uri: CODEX_OAUTH_REDIRECT_URI,
    scope: CODEX_OAUTH_SCOPE,
    code_challenge: challengeOf(codeVerifier),
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    state,
    originator: CODEX_OAUTH_ORIGINATOR,
    codex_app_version: CODEX_APP_VERSION,
    source_surface_stable_id: stableId,
    codex_origin_stable_id: stableId,
    codex_streamlined_login: 'true',
  }))
    inner.searchParams.set(key, value)
  const outer = new URL(CODEX_OAUTH_DESKTOP_AUTH_URL)
  outer.searchParams.set('authorize_url', inner.toString())
  outer.searchParams.set('codex_streamlined_login', 'true')
  outer.searchParams.set('no_universal_links', '1')
  return outer.toString()
}

/** 回调链接里的 code 与 state：必须是完整 URL，各恰好出现一次（与 Worker parseOAuthCallback 一致）。 */
export function parseGatewayCallback(raw) {
  const value = String(raw || '').trim()
  if (!value || value.length > 16 * 1024) return null
  let url
  try {
    url = new URL(value)
  } catch {
    return null
  }
  const codes = url.searchParams.getAll('code')
  const states = url.searchParams.getAll('state')
  if (codes.length !== 1 || states.length !== 1 || !codes[0].trim() || !states[0].trim()) return null
  return { code: codes[0].trim(), state: states[0].trim() }
}

function oauthError(code, message, status = 502) {
  return Object.assign(new Error(message), { code, status })
}

function tokenFetch(proxyUrl, env, fetchImpl) {
  const override = String(env.KIN_CODEX_GATEWAY_OAUTH_TOKEN_URL || '').trim()
  const loopback = override && ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(override).hostname)
  const send = fetchImpl || makeProxyFetch(loopback ? '' : proxyUrl, TOKEN_TIMEOUT_MS, { maxMs: TOKEN_TIMEOUT_MS })
  return (body) =>
    send(override || CODEX_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': CODEX_USER_AGENT,
      },
      body: String(new URLSearchParams(body)),
    })
}

async function tokenRequest(body, { proxyUrl, env, fetchImpl, rejected }) {
  let res
  try {
    res = await tokenFetch(proxyUrl, env, fetchImpl)(body)
  } catch (error) {
    const aborted = error?.name === 'AbortError' || /aborted/i.test(String(error?.message || error))
    throw oauthError(
      aborted ? 'oauth_timeout' : 'oauth_network_error',
      '经账号代理访问 OpenAI 授权服务失败，请检查代理',
    )
  }
  const status = Number(res?.status) || 0
  let payload = {}
  try {
    payload = await res.json()
  } catch {}
  if (status === 400 || status === 401 || status === 403)
    throw oauthError(rejected, '授权已失效或被拒绝，请重新生成授权链接', 409)
  if (status < 200 || status >= 300) throw oauthError('oauth_exchange_failed', `OpenAI 授权服务返回 ${status}`)
  const accessToken = String(payload?.access_token || '').trim()
  if (!accessToken) throw oauthError('oauth_exchange_empty', 'OpenAI 授权服务没有返回访问令牌')
  const expiresIn = Number(payload?.expires_in)
  return {
    access_token: accessToken,
    refresh_token: String(payload?.refresh_token || body.refresh_token || '').trim(),
    id_token: String(payload?.id_token || '').trim(),
    expires_at:
      Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
  }
}

/** 授权码换令牌（原生或 BPS），经账号出站代理。 */
export async function exchangeGatewayCode({
  code,
  codeVerifier,
  grant = null,
  proxyUrl,
  env = process.env,
  fetchImpl,
}) {
  const bps = grant === GRANT_BPS ? bpsConfig(env) : null
  const tokens = await tokenRequest(
    {
      grant_type: 'authorization_code',
      code,
      client_id: bps?.clientId || CODEX_OAUTH_CLIENT_ID,
      redirect_uri: bps?.redirectUri || CODEX_OAUTH_REDIRECT_URI,
      code_verifier: codeVerifier,
    },
    { proxyUrl, env, fetchImpl, rejected: 'oauth_code_rejected' },
  )
  if (!tokens.refresh_token) throw oauthError('oauth_exchange_empty', 'OpenAI 授权服务没有返回刷新令牌')
  return tokens
}

/** 只有刷新令牌的导入：先换出访问令牌（与上游 VM 槽位的刷新报文一致）。 */
export async function refreshGatewayToken({ refreshToken, proxyUrl, env = process.env, fetchImpl }) {
  return tokenRequest(
    {
      grant_type: 'refresh_token',
      refresh_token: String(refreshToken || '').trim(),
      client_id: CODEX_OAUTH_CLIENT_ID,
      scope: CODEX_OAUTH_SCOPE,
    },
    { proxyUrl, env, fetchImpl, rejected: 'refresh_token_rejected' },
  )
}

const claims = (token) => decodeJwtPayload(token) || {}
const pick = (...values) => {
  for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim()
  return ''
}

/** 令牌里的身份（口径同 Worker exchangeOAuthCode）：邮箱、ChatGPT 工作区、套餐。 */
export function tokenIdentity({ access_token, id_token } = {}) {
  const id = claims(id_token)
  const access = claims(access_token)
  const idAuth = id[AUTH_CLAIMS] || {}
  const accessAuth = access[AUTH_CLAIMS] || {}
  return {
    email: pick(id.email, id.preferred_username, id.user_email, access[PROFILE_CLAIMS]?.email) || null,
    chatgpt_account_id:
      pick(idAuth.chatgpt_account_id, accessAuth.chatgpt_account_id, id.chatgpt_account_id, id.account_id) || null,
    plan: pick(idAuth.chatgpt_plan_type, accessAuth.chatgpt_plan_type, id.plan, id.plan_type) || null,
  }
}

/** 访问令牌 JWT 的过期时间（ISO）；读不出时为 null。 */
export function tokenExpiry(accessToken) {
  const exp = Number(claims(accessToken).exp)
  return Number.isFinite(exp) && exp > 0 ? new Date(exp * 1000).toISOString() : null
}

const audienceIncludes = (aud, client) =>
  aud == null || (typeof aud === 'string' ? aud === client : Array.isArray(aud) && aud.includes(client))

/**
 * BPS 令牌校验（移植 Worker validateBPSTokens，对齐 sub2api）：必须有刷新令牌；访问令牌是签发给 Excel 客户端、
 * 带未过期 exp 与 ChatGPT 工作区的 JWT；id_token 的 aud 含 Excel 客户端，工作区与用户与访问令牌一致；不接受 Free 套餐。
 */
export function validateBpsTokens(tokens, { env = process.env, now = Date.now() } = {}) {
  const fail = (message) => {
    throw oauthError('bps_authorization_invalid', `BPS 授权无效：${message}`, 400)
  }
  const client = bpsConfig(env).clientId
  if (!String(tokens?.refresh_token || '').trim()) fail('缺少 refresh_token')
  const access = decodeJwtPayload(tokens?.access_token)
  if (!access) fail('access_token 不是 JWT')
  if (pick(access.client_id, access.azp) !== client) fail('授权不是签发给 Excel 客户端的')
  if (!(Number(access.exp) > 0) || Number(access.exp) * 1000 <= now) fail('access_token 没有过期时间或已过期')
  const identity = decodeJwtPayload(tokens?.id_token)
  if (!identity) fail('缺少 id_token')
  if (!audienceIncludes(identity.aud, client)) fail('id_token 的受众不含 Excel 客户端')
  const accessAuth = access[AUTH_CLAIMS] || {}
  const idAuth = identity[AUTH_CLAIMS] || {}
  const workspace = pick(accessAuth.chatgpt_account_id)
  if (!workspace) fail('access_token 没有 ChatGPT 工作区')
  if (pick(idAuth.chatgpt_account_id) && pick(idAuth.chatgpt_account_id) !== workspace) fail('id_token 属于其他工作区')
  if (pick(tokens?.chatgpt_account_id) && pick(tokens.chatgpt_account_id) !== workspace)
    fail('chatgpt_account_id 与 access_token 不一致')
  const accessUser = pick(accessAuth.chatgpt_user_id, accessAuth.user_id)
  const idUser = pick(idAuth.chatgpt_user_id, idAuth.user_id)
  if (accessUser && idUser && accessUser !== idUser) fail('id_token 属于其他用户')
  const plan = pick(idAuth.chatgpt_plan_type, accessAuth.chatgpt_plan_type)
  if (plan.toLowerCase() === 'free') fail('需要付费 ChatGPT 套餐')
  return { workspace, user: accessUser || idUser, email: pick(identity.email), plan }
}

/** 账号原生授权的身份：工作区以账号记录为准，用户与邮箱取自原生令牌（移植 Worker nativeIdentity）。 */
export function nativeIdentity(native = {}, config = {}) {
  const access = claims(native.access_token)
  const id = claims(native.id_token)
  const accessAuth = access[AUTH_CLAIMS] || {}
  const idAuth = id[AUTH_CLAIMS] || {}
  return {
    workspace: pick(config.chatgpt_account_id, accessAuth.chatgpt_account_id, idAuth.chatgpt_account_id),
    user: pick(accessAuth.chatgpt_user_id, accessAuth.user_id, idAuth.chatgpt_user_id, idAuth.user_id),
    email: pick(config.email, id.email),
  }
}

/** BPS 授权须与原生授权是同一工作区的同一用户（移植 Worker matchBPSIdentity，对齐 sub2api validateExcelIdentity）。 */
export function matchBpsIdentity(native, bps) {
  const fail = (message) => {
    throw oauthError('bps_identity_mismatch', message, 409)
  }
  if (!native.workspace || native.workspace !== bps.workspace) fail('BPS 授权属于另一个 ChatGPT 账号')
  if (native.user && native.user !== bps.user) fail('BPS 授权属于该工作区的其他用户')
  if (native.email && native.email.toLowerCase() !== String(bps.email || '').toLowerCase())
    fail('BPS 授权的邮箱与该账号不一致')
}
