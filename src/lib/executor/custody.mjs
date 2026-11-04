/**
 * 凭据封装（统一控制面重构 P3.5–P3.6，设计第 6 节），与 Worker 的 custody.go、server.go 凭据包逐字节一致。
 *
 *   - custody_bundle：控制面按实例托管公钥（X25519，注册与心跳提交）封装凭据，只有该实例能解开。
 *     临时 X25519 密钥协商 → HKDF-SHA256（salt = 临时公钥‖收件公钥，info = kin-custody-v1）→ AES-256-GCM，
 *     附加认证数据 `custody:v1|<实例>|<运行账号>|<凭据代次>|<BPS 令牌代次>`。格式 `v1.<临时公钥 b64url>.<nonce‖密文‖标签 b64url>`。
 *   - credential_bundle：实例间共享密钥（KIN_CODEX_GATEWAY_CREDENTIAL_BUNDLE_KEY 的 SHA-256）加密的凭据包，
 *     Worker 导出账号与报告刷新结果时使用；控制面解开后写入凭据库。附加认证数据为运行账号 ID。
 */
import crypto from 'node:crypto'

const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')
const HKDF_INFO = 'kin-custody-v1'

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

export function validCustodyPublicKey(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
}

function publicKeyObject(raw) {
  return crypto.createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' })
}

function rawPublicKey(keyObject) {
  return keyObject.export({ format: 'der', type: 'spki' }).subarray(X25519_SPKI_PREFIX.length)
}

// Go encoding/json 输出：去掉空字段（omitempty），键按结构体字段顺序
function bundleJson(bundle) {
  const out = {}
  for (const field of BUNDLE_FIELDS) if (bundle?.[field]) out[field] = String(bundle[field])
  return JSON.stringify(out)
}

function custodyKey(shared, ephemeral, recipient) {
  return Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.concat([ephemeral, recipient]), HKDF_INFO, 32))
}

// 附加认证数据绑定实例、运行账号与两种代次：元数据代次被改或与令牌不符时 Worker 解不开（R3 审查 P2-2）
function custodyAad(instanceId, accountId, { credentialRevision = 0, bpsGeneration = 0 } = {}) {
  return Buffer.from(
    `custody:v1|${instanceId}|${accountId}|${Number(credentialRevision) || 0}|${Number(bpsGeneration) || 0}`,
  )
}

/** 按实例公钥封装凭据；revisions = { credentialRevision, bpsGeneration } 与导入元数据一致。 */
export function sealCustodyBundle(publicKey, instanceId, accountId, bundle, revisions = {}) {
  if (!validCustodyPublicKey(publicKey)) throw new Error('invalid custody public key')
  const recipient = Buffer.from(publicKey, 'base64url')
  const ephemeral = crypto.generateKeyPairSync('x25519')
  const ephemeralRaw = rawPublicKey(ephemeral.publicKey)
  const shared = crypto.diffieHellman({ privateKey: ephemeral.privateKey, publicKey: publicKeyObject(recipient) })
  const key = custodyKey(shared, ephemeralRaw, recipient)
  const nonce = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(custodyAad(instanceId, accountId, revisions))
  const body = Buffer.concat([cipher.update(bundleJson(bundle)), cipher.final(), cipher.getAuthTag()])
  return `v1.${ephemeralRaw.toString('base64url')}.${Buffer.concat([nonce, body]).toString('base64url')}`
}

/** 测试用：用实例私钥（原始 32 字节 base64url）解开 custody_bundle。 */
export function openCustodyBundle(privateKey, instanceId, accountId, encoded, revisions = {}) {
  const [version, ephemeralText, sealedText] = String(encoded || '').split('.')
  if (version !== 'v1' || !ephemeralText || !sealedText) throw new Error('custody bundle is invalid')
  const privateObject = crypto.createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), Buffer.from(privateKey, 'base64url')]),
    format: 'der',
    type: 'pkcs8',
  })
  const ephemeral = Buffer.from(ephemeralText, 'base64url')
  const recipient = rawPublicKey(crypto.createPublicKey(privateObject))
  const shared = crypto.diffieHellman({ privateKey: privateObject, publicKey: publicKeyObject(ephemeral) })
  const sealed = Buffer.from(sealedText, 'base64url')
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    custodyKey(shared, ephemeral, recipient),
    sealed.subarray(0, 12),
  )
  decipher.setAAD(custodyAad(instanceId, accountId, revisions))
  decipher.setAuthTag(sealed.subarray(sealed.length - 16))
  return JSON.parse(
    Buffer.concat([decipher.update(sealed.subarray(12, sealed.length - 16)), decipher.final()]).toString('utf8'),
  )
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

/** 凭据包 → 凭据库载荷：原生授权与 BPS 授权分开保存。 */
export function vaultSecretsFromBundle(bundle = {}) {
  const native = {}
  for (const field of ['access_token', 'refresh_token', 'id_token', 'api_key', 'proxy_url'])
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

/** 凭据库载荷 → 凭据包。 */
export function bundleFromVaultSecrets(native = {}, bps = null) {
  return {
    ...native,
    ...(bps
      ? { bps_access_token: bps.access_token, bps_refresh_token: bps.refresh_token, bps_id_token: bps.id_token }
      : {}),
  }
}
