/**
 * 凭据包（统一控制面重构 P3.6，设计第 6 节），与 Worker server.go 的 credentialBundle 逐字节一致。
 *
 *   - credential_bundle：用共享密钥（KIN_CODEX_GATEWAY_CREDENTIAL_BUNDLE_KEY 的 SHA-256）加密的凭据包，
 *     Worker 导出账号与报告刷新结果时使用；控制面解开后写入凭据库。附加认证数据为运行账号 ID。
 *
 * 按实例公钥（X25519）封装的 custody_bundle 随 Gateway 事实直读 G4 删除：Worker 直读凭据库，控制面不再投影凭据。
 */
import crypto from 'node:crypto'

/** 凭据包字段（Go credentialBundle）。 */
export const BUNDLE_FIELDS = Object.freeze([
  'access_token',
  'refresh_token',
  'id_token',
  'api_key',
  'proxy_url',
  'bps_access_token',
  'bps_refresh_token',
  'bps_id_token',
])

// Go encoding/json 输出：去掉空字段（omitempty），键按结构体字段顺序
function bundleJson(bundle) {
  const out = {}
  for (const field of BUNDLE_FIELDS) if (bundle?.[field]) out[field] = String(bundle[field])
  return JSON.stringify(out)
}

function bundleKey(material) {
  const text = String(material || '').trim()
  if (!text) throw new Error('credential bundle key is not configured')
  return crypto.createHash('sha256').update(text).digest()
}

/** 解开 Worker 的 credential_bundle（共享密钥）。 */
export function openCredentialBundle(material, accountId, encoded) {
  const raw = Buffer.from(String(encoded || '').trim(), 'base64url')
  if (raw.length < 12 + 16) throw new Error('credential bundle is truncated')
  const decipher = crypto.createDecipheriv('aes-256-gcm', bundleKey(material), raw.subarray(0, 12))
  decipher.setAAD(Buffer.from(String(accountId)))
  decipher.setAuthTag(raw.subarray(raw.length - 16))
  return JSON.parse(Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString())
}

/** 生成 Worker 可解开的 credential_bundle（测试与迁移工具用）。 */
export function sealCredentialBundle(material, accountId, bundle) {
  const nonce = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', bundleKey(material), nonce)
  cipher.setAAD(Buffer.from(String(accountId)))
  const body = Buffer.concat([cipher.update(bundleJson(bundle)), cipher.final(), cipher.getAuthTag()])
  return Buffer.concat([nonce, body]).toString('base64url')
}

/**
 * 凭据包 → 凭据库载荷：原生授权与 BPS 授权分开保存。
 * 代理地址不进凭据库：它归账号配置所有，改代理不提升凭据代次，存进来会过时（终审 B4）。
 */
export function vaultSecretsFromBundle(bundle = {}) {
  const native = {}
  for (const field of ['access_token', 'refresh_token', 'id_token', 'api_key'])
    if (bundle[field]) native[field] = String(bundle[field])
  const bps = bundle.bps_access_token
    ? {
        access_token: String(bundle.bps_access_token),
        refresh_token: String(bundle.bps_refresh_token || ''),
        id_token: String(bundle.bps_id_token || ''),
      }
    : null
  return { native, bps }
}
