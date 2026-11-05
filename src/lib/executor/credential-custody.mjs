/**
 * 凭据托管（统一控制面重构 P3.5–P3.9，设计第 6 节）。开关 KIN_CREDENTIAL_CUSTODY=worker|control（默认 worker）。
 *
 *   - worker（默认）：令牌以 Worker 为准，投影沿用实例间共享密钥加密的 credential_bundle，与过去相同；
 *   - control：令牌以控制面凭据库为准（vault.mjs）：
 *       · 收录（credential.issued）：每次从 Worker 导出账号时，原生授权代次或 BPS 授权代次更高就写入凭据库
 *         （授权、导入、重新授权都会提高代次；代次单调，旧副本不会覆盖新令牌）；
 *       · 轮换（credential.rotated）：持有刷新租约的 Worker 报告 rotated 时附带新凭据包，控制面按代次（原生）
 *         或轮换前令牌指纹（BPS）CAS 写入；
 *       · 投影：令牌取自凭据库，按目标实例托管公钥封装成 custody_bundle；目标实例没有公钥（旧版 Worker）或
 *         凭据库还没有该账号时，回退到 credential_bundle 并告警（过渡期）。
 * 导出账号文件（P3.9）两种模式都不再调用 Worker 的明文接口：control 读凭据库，worker 解开导出的凭据包。
 */
import { createCredentialVault, loadKeyring, masterKeyFile, tokenFingerprint, vaultHasRecords } from './vault.mjs'
import {
  bundleFromVaultSecrets,
  openCredentialBundle,
  sealCustodyBundle,
  validCustodyPublicKey,
  vaultSecretsFromBundle,
} from './custody.mjs'

export const CUSTODY_MODES = Object.freeze(['worker', 'control'])

export function credentialCustodyMode(env = process.env) {
  return String(env.KIN_CREDENTIAL_CUSTODY || '')
    .trim()
    .toLowerCase() === 'control'
    ? 'control'
    : 'worker'
}

function unixSeconds(value) {
  if (value == null || value === '') return null
  if (typeof value === 'number') return value > 0 ? value : null
  const ms = Date.parse(String(value))
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : null
}

// BPS 授权所属的 ChatGPT 账号：账号自身字段优先，否则取 BPS 访问令牌声明（与 Worker bpsChatGPTAccountID 一致）
function bpsAccountId(account, accessToken) {
  if (account.chatgpt_account_id) return account.chatgpt_account_id
  try {
    const claims = JSON.parse(Buffer.from(String(accessToken).split('.')[1] || '', 'base64url').toString('utf8'))
    return String(claims?.['https://api.openai.com/auth']?.chatgpt_account_id || '')
  } catch {
    return ''
  }
}

// 凭据库里 BPS 的代次：Worker 令牌代次 + 1（旧版 Worker 没有令牌代次时为 1）
export function bpsVaultRevision(account = {}) {
  if (!account?.bps || !(Number(account.bps.revision || 0) > 0)) return 0
  return Number(account.bps.token_generation || 0) + 1
}

// 一次收录或报告允许的最大代次增幅（与租约一致，R3 审查 P2-6）
const MAX_REVISION_STEP = 1000

function isoOrNull(value) {
  const seconds = unixSeconds(value)
  return seconds ? new Date(seconds * 1000).toISOString() : null
}

export function createCredentialCustody({ db, env = process.env, vault = null, log = console }) {
  const mode = () => credentialCustodyMode(env)
  const material = () => String(env.KIN_CODEX_GATEWAY_CREDENTIAL_BUNDLE_KEY || '').trim()
  let store = vault
  const getVault = () =>
    (store ||= createCredentialVault({
      db,
      keyring: loadKeyring({ file: masterKeyFile(env, db), create: !vaultHasRecords(db) }),
    }))
  const warned = new Set()
  const warnOnce = (key, message) => {
    if (warned.has(key)) return
    warned.add(key)
    log.warn?.(`credential custody: ${message}`)
  }

  function open(runtimeAccountId, encoded) {
    if (!encoded) return null
    if (!material())
      throw Object.assign(new Error('KIN_CODEX_GATEWAY_CREDENTIAL_BUNDLE_KEY is not configured'), {
        code: 'bundle_key_missing',
      })
    return openCredentialBundle(material(), runtimeAccountId, encoded)
  }

  /**
   * 收录 Worker 导出的凭据（control 模式）。exported = Worker 导出接口的 data（{ account, credential_bundle }）。
   * 返回 { native, bps }，各为 'stored' / 'current' / 'skipped'。
   */
  function capture({
    accountResourceId,
    runtimeAccountId,
    exported,
    sourceInstanceId = null,
    source = 'worker_export',
  }) {
    if (mode() !== 'control' || !accountResourceId || !exported?.credential_bundle)
      return { native: 'skipped', bps: 'skipped' }
    const { native, bps } = vaultSecretsFromBundle(open(runtimeAccountId, exported.credential_bundle))
    const account = exported.account || {}
    const vault = getVault()
    const out = { native: 'skipped', bps: 'skipped' }
    const nativeRevision = Number(account.credential_revision || 0)
    if (nativeRevision > 0 && (native.access_token || native.refresh_token || native.api_key)) {
      const current = vault.meta(accountResourceId, 'native')
      if (current && nativeRevision > current.revision + MAX_REVISION_STEP)
        throw Object.assign(new Error(`native revision ${nativeRevision} jumps too far`), { code: 'revision_jump' })
      if (!current || nativeRevision > current.revision) {
        vault.put({
          accountResourceId,
          grant: 'native',
          revision: nativeRevision,
          secrets: native,
          expiresAt: isoOrNull(account.expires_at),
          source,
          sourceInstanceId,
        })
        out.native = 'stored'
      } else out.native = 'current'
    }
    // BPS 令牌代次（每次授权、导入、刷新递增）：凭据库代次 = 令牌代次 + 1（旧版 Worker 没有该字段时为 1）
    const bpsRevision = bpsVaultRevision(account)
    if (bps && bpsRevision > 0) {
      const current = vault.meta(accountResourceId, 'bps')
      if (current && bpsRevision > current.revision + MAX_REVISION_STEP)
        throw Object.assign(new Error(`bps revision ${bpsRevision} jumps too far`), { code: 'revision_jump' })
      if (!current || bpsRevision > current.revision) {
        vault.put({
          accountResourceId,
          grant: 'bps',
          revision: bpsRevision,
          secrets: bps,
          expiresAt: isoOrNull(account.bps?.expires_at),
          source,
          sourceInstanceId,
        })
        out.bps = 'stored'
      } else out.bps = 'current'
    }
    return out
  }

  /**
   * 刷新租约的持有者报告 rotated（control 模式）：按代次 CAS 写入新凭据（原生为凭据代次，BPS 为令牌代次 + 1）。
   * 返回 { ok, code? }；失败只告警，不影响租约释放：报告丢失或写入失败时，下一次从持有者导出账号即按更高代次收录。
   */
  function recordRotation({
    accountResourceId,
    runtimeAccountId,
    grant,
    credentialBundle,
    revision,
    previousRevision,
    sourceInstanceId,
  }) {
    if (mode() !== 'control') return { ok: true, skipped: true }
    try {
      const { native, bps } = vaultSecretsFromBundle(open(runtimeAccountId, credentialBundle))
      const vault = getVault()
      if (grant === 'native') {
        const current = vault.meta(accountResourceId, 'native')
        vault.put({
          accountResourceId,
          grant: 'native',
          revision: Number(revision),
          secrets: native,
          // 凭据库还没有这个账号时（迁移前）直接收录
          ...(current ? { expectedRevision: Number(previousRevision) } : {}),
          source: 'refresh',
          sourceInstanceId,
        })
      } else {
        if (!bps) return { ok: false, code: 'bps_credentials_missing' }
        const current = vault.meta(accountResourceId, 'bps')
        vault.put({
          accountResourceId,
          grant: 'bps',
          revision: Number(revision) + 1,
          secrets: bps,
          ...(current ? { expectedRevision: Number(previousRevision) + 1 } : {}),
          source: 'refresh',
          sourceInstanceId,
        })
      }
      return { ok: true }
    } catch (error) {
      log.warn?.(
        `credential custody: rotation of ${accountResourceId}/${grant} not recorded: ${error.code || ''} ${error.message}`,
      )
      return { ok: false, code: error.code || 'rotation_not_recorded' }
    }
  }

  /**
   * 投影给目标实例的凭据字段（导入请求的附加字段）：worker 模式原样转交 credential_bundle；
   * control 模式先收录导出结果，再按目标实例公钥封装凭据库里的令牌，并把导入的代次改成凭据库的代次。
   * 凭据库比来源副本旧（收录失败）或缺少来源有的 BPS 授权时，回退到来源副本，绝不下发“旧令牌 + 新代次”（R3 审查 P1-1）。
   * 来源没有 BPS 授权（已撤销）时不带凭据库里的 BPS 令牌。
   */
  function projectionFields({ instance, runtimeAccountId, accountResourceId, exported, sourceInstanceId = null }) {
    const fallback = exported?.credential_bundle ? { credential_bundle: exported.credential_bundle } : {}
    if (mode() !== 'control' || !accountResourceId) return fallback
    try {
      capture({ accountResourceId, runtimeAccountId, exported, sourceInstanceId })
    } catch (error) {
      warnOnce(
        `capture:${accountResourceId}`,
        `capture of ${accountResourceId} failed: ${error.code || ''} ${error.message}`,
      )
    }
    // 旧版 Worker（能力描述里没有 custody）解不开托管封装：回退到共享凭据包（R3 审查 P2-1）
    // 托管公钥待管理员确认（上报的公钥与首次登记的不同）时同样回退（R3 审查 P1-5）
    if (
      !validCustodyPublicKey(instance?.custody_public_key) ||
      instance?.capabilities?.custody !== true ||
      instance?.custody_key_pending
    ) {
      warnOnce(
        `key:${instance?.id}`,
        `instance ${instance?.id} cannot open custody bundles; projecting the shared bundle`,
      )
      return fallback
    }
    const account = exported?.account || {}
    // 凭据库读不出（主密钥缺失、记录被篡改）：拒绝本次投影（该实例上的账号记为 drifted），不退回明文来源；
    // 告警一次，便于运维发现（终审 B8）
    let vault
    let native
    try {
      vault = getVault()
      native = vault.get(accountResourceId, 'native')
    } catch (error) {
      warnOnce(
        `vault:${accountResourceId}`,
        `${accountResourceId} vault copy cannot be read (${error?.code || error?.message}); projection refused`,
      )
      throw error
    }
    const sourceRevision = Number(account.credential_revision || 0)
    if (!native || native.revision < sourceRevision) {
      warnOnce(
        `stale:${accountResourceId}`,
        `${accountResourceId} vault copy is missing or older than the Worker copy; projecting the Worker copy`,
      )
      return fallback
    }
    let bps = null
    if (account.bps && Number(account.bps.revision || 0) > 0) {
      bps = vault.get(accountResourceId, 'bps')
      if (!bps || bps.revision < bpsVaultRevision(account)) {
        warnOnce(
          `stale-bps:${accountResourceId}`,
          `${accountResourceId} BPS vault copy is missing or older than the Worker copy; projecting the Worker copy`,
        )
        return fallback
      }
    }
    const revisions = { credentialRevision: native.revision, bpsGeneration: bps ? bps.revision - 1 : 0 }
    // 代理地址以来源实例当前的凭据包为准（凭据库不保存代理，旧记录里的值也被覆盖，终审 B4）
    let proxyUrl = ''
    try {
      proxyUrl = open(runtimeAccountId, exported?.credential_bundle)?.proxy_url || ''
    } catch {}
    return {
      custody_bundle: sealCustodyBundle(
        instance.custody_public_key,
        instance.id,
        runtimeAccountId,
        { ...bundleFromVaultSecrets(native.secrets, bps?.secrets || null), proxy_url: proxyUrl },
        revisions,
      ),
      credential_revision: native.revision,
      ...(bps ? { bps: { ...account.bps, token_generation: revisions.bpsGeneration } } : {}),
    }
  }

  /**
   * 导出账号文件用的令牌（P3.9）：control 模式读凭据库；worker 模式解开 Worker 导出的凭据包。
   * exported 为 worker 模式下 Worker 导出接口的 data。返回 { credentials, bps_credentials? }，与旧明文接口字段一致。
   */
  function exportSecrets({ accountResourceId, runtimeAccountId, exported }) {
    const account = exported?.account || {}
    let native
    let bps
    let nativeExpiry = unixSeconds(account.expires_at)
    let bpsExpiry = unixSeconds(account.bps?.expires_at)
    if (mode() === 'control') {
      // 先收录 Worker 当前的副本；凭据库仍比 Worker 旧（收录失败、刚从 worker 模式切回）时用 Worker 的副本（终审 B5）
      try {
        capture({ accountResourceId, runtimeAccountId, exported, source: 'account_export' })
      } catch {}
      const vault = getVault()
      const nativeRecord = vault.get(accountResourceId, 'native')
      const bpsRecord = vault.get(accountResourceId, 'bps')
      const fromWorker = exported?.credential_bundle
        ? vaultSecretsFromBundle(open(runtimeAccountId, exported.credential_bundle) || {})
        : { native: {}, bps: null }
      const nativeCurrent = nativeRecord && nativeRecord.revision >= Number(account.credential_revision || 0)
      native = nativeCurrent ? nativeRecord.secrets : fromWorker.native
      nativeExpiry = (nativeCurrent && unixSeconds(nativeRecord?.expires_at)) || nativeExpiry
      const bpsCurrent = bpsRecord && bpsRecord.revision >= bpsVaultRevision(account)
      // Worker 副本不带 BPS 状态时沿用凭据库（撤销 BPS 时凭据库记录已一并删除）
      bps = account.bps ? (bpsCurrent ? bpsRecord.secrets : fromWorker.bps) : bpsRecord?.secrets || null
      bpsExpiry = (bpsCurrent && unixSeconds(bpsRecord?.expires_at)) || bpsExpiry
    } else {
      ;({ native, bps } = vaultSecretsFromBundle(open(runtimeAccountId, exported?.credential_bundle) || {}))
    }
    const credentials = {
      access_token: native.access_token || '',
      refresh_token: native.refresh_token || '',
      id_token: native.id_token || '',
      chatgpt_account_id: account.chatgpt_account_id || '',
      email: account.email || '',
      ...(nativeExpiry ? { expires_at: nativeExpiry } : {}),
    }
    const out = { credentials }
    if (bps?.access_token)
      out.bps_credentials = {
        access_token: bps.access_token,
        refresh_token: bps.refresh_token || '',
        id_token: bps.id_token || '',
        chatgpt_account_id: bpsAccountId(account, bps.access_token),
        ...(bpsExpiry ? { expires_at: bpsExpiry } : {}),
      }
    return out
  }

  /** 凭据库里某类授权的代次（没有记录、或 worker 托管且凭据库为空时为 0）。BPS 为令牌代次 + 1。 */
  function vaultRevision(accountResourceId, grant) {
    if (mode() !== 'control' && !vaultHasRecords(db)) return 0
    try {
      return getVault().meta(accountResourceId, grant)?.revision || 0
    } catch {
      return 0
    }
  }

  /**
   * 撤销某类授权后删除凭据库里的记录（例如撤销 BPS 授权）：否则重新授权后代次从头计，旧记录会被当成更新而投影出去。
   * 凭据库为空且不是 control 模式时不打开凭据库。
   */
  function forget(accountResourceId, grant) {
    if (mode() !== 'control' && !vaultHasRecords(db)) return 0
    return getVault().remove(accountResourceId, grant)
  }

  return {
    mode,
    capture,
    recordRotation,
    projectionFields,
    exportSecrets,
    forget,
    vaultRevision,
    vault: getVault,
    tokenFingerprint,
  }
}
