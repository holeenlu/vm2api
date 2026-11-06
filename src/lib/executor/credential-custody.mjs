/**
 * 凭据托管（统一控制面重构 P3.5–P3.9，设计第 6 节）：令牌以控制面凭据库为准（vault.mjs）。
 * 2026-11-06 起固定为控制面托管（Gateway 事实直读 G1）：原 KIN_CREDENTIAL_CUSTODY=worker 模式已移除，环境变量不再读取。
 *
 *   - 收录（credential.issued）：每次从 Worker 导出账号时，原生授权代次或 BPS 授权代次更高就写入凭据库
 *     （授权、导入、重新授权都会提高代次；代次单调，旧副本不会覆盖新令牌）；
 *   - 轮换（credential.rotated）：持有刷新租约的 Worker 报告 rotated 时附带新凭据包与轮换前代次，控制面在释放租约的
 *     同一事务里按代次 CAS 写入（原生为凭据代次，BPS 为 Worker 令牌代次 + 1）；
 *   - Worker 从控制面数据库直读凭据库里的令牌（Gateway 事实直读，设计第 19 节），控制面不再推送投影。
 * 导出账号文件（P3.9）读凭据库，凭据库比 Worker 副本旧时用 Worker 导出的凭据包。
 * 凭据库读写经 DbClient 异步进行（R6 B3），读写凭据库的方法均为 async。
 */
import { openCredentialVault, tokenFingerprint } from './vault.mjs'
import { recordAccountInstallationId } from '../gateway-worker/repos/accounts-repo.mjs'
import { openCredentialBundle, vaultSecretsFromBundle } from './custody.mjs'

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

// Worker 生成的安装身份（UUID v4）
const INSTALLATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// 一次收录或报告允许的最大代次增幅（与租约一致，R3 审查 P2-6）
const MAX_REVISION_STEP = 1000

function isoOrNull(value) {
  const seconds = unixSeconds(value)
  return seconds ? new Date(seconds * 1000).toISOString() : null
}

// 凭据库记录的过期时间；轮换写入不带过期时间时按访问令牌 JWT 的 exp 推导（复核 G2），都没有时省略
function expiryOf(record) {
  if (record?.expires_at) return { expires_at: record.expires_at }
  const [, payload] = String(record?.secrets?.access_token || '').split('.')
  if (!payload) return {}
  try {
    const exp = Number(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))?.exp)
    return Number.isFinite(exp) && exp > 0 ? { expires_at: new Date(exp * 1000).toISOString() } : {}
  } catch {
    return {}
  }
}

export function createCredentialCustody({ db, env = process.env, vault = null, log = console }) {
  const material = () => String(env.KIN_CODEX_GATEWAY_CREDENTIAL_BUNDLE_KEY || '').trim()
  let store = vault
  let opening = null
  // 凭据库惰性打开（R6 B8：async）；打开失败（主密钥缺失等）不缓存，下次调用重试，与原同步构造一致
  const getVault = async () => {
    if (store) return store
    opening ||= openCredentialVault({ db, env }).then(
      (opened) => (store = opened),
      (error) => {
        opening = null
        throw error
      },
    )
    return opening
  }
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
   * 收录 Worker 导出的凭据。exported = Worker 导出接口的 data（{ account, credential_bundle, installation_id }）。
   * 返回 { native, bps }，各为 'stored' / 'current' / 'skipped'。账号还没有安装身份时一并记下（G2）。
   */
  async function capture({
    accountResourceId,
    runtimeAccountId,
    exported,
    sourceInstanceId = null,
    source = 'worker_export',
  }) {
    if (!accountResourceId || !exported?.credential_bundle) return { native: 'skipped', bps: 'skipped' }
    if (INSTALLATION_ID.test(String(exported.installation_id || '')))
      await recordAccountInstallationId(db, accountResourceId, String(exported.installation_id))
    const { native, bps } = vaultSecretsFromBundle(open(runtimeAccountId, exported.credential_bundle))
    const account = exported.account || {}
    const vault = await getVault()
    const out = { native: 'skipped', bps: 'skipped' }
    const nativeRevision = Number(account.credential_revision || 0)
    if (nativeRevision > 0 && (native.access_token || native.refresh_token || native.api_key)) {
      const current = await vault.meta(accountResourceId, 'native')
      if (current && nativeRevision > current.revision + MAX_REVISION_STEP)
        throw Object.assign(new Error(`native revision ${nativeRevision} jumps too far`), { code: 'revision_jump' })
      if (!current || nativeRevision > current.revision) {
        await vault.put({
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
      const current = await vault.meta(accountResourceId, 'bps')
      if (current && bpsRevision > current.revision + MAX_REVISION_STEP)
        throw Object.assign(new Error(`bps revision ${bpsRevision} jumps too far`), { code: 'revision_jump' })
      if (!current || bpsRevision > current.revision) {
        await vault.put({
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
   * 只读演练用：解开 Worker 导出的凭据包（与 capture 同一口径），返回将要收录的原生与 BPS 代次，不写凭据库。
   * 凭据包密钥缺失或不匹配时与 capture 一样抛错（审计 U2：演练零错误才说明 --apply 能成功）。
   */
  function inspect({ runtimeAccountId, exported, currentRevision = () => 0 }) {
    if (!exported?.credential_bundle) return { native: 0, bps: 0 }
    const { native, bps } = vaultSecretsFromBundle(open(runtimeAccountId, exported.credential_bundle))
    const account = exported.account || {}
    const nativeRevision = Number(account.credential_revision || 0)
    const revisions = {
      native:
        nativeRevision > 0 && (native.access_token || native.refresh_token || native.api_key) ? nativeRevision : 0,
      bps: bps ? bpsVaultRevision(account) : 0,
    }
    // 与 capture 同样拒绝代次跳变过大（审计复核 V3）
    for (const grant of ['native', 'bps']) {
      const current = currentRevision(grant)
      if (revisions[grant] && current && revisions[grant] > current + MAX_REVISION_STEP)
        throw Object.assign(new Error(`${grant} revision ${revisions[grant]} jumps too far`), { code: 'revision_jump' })
    }
    return revisions
  }

  /**
   * 刷新租约的持有者报告 rotated：按代次 CAS 写入新凭据（原生为凭据代次，BPS 为令牌代次 + 1）。
   * 由释放租约的同一事务调用（refresh-lease.mjs 的 onRotated），失败即抛错、租约不释放：
   *   - 凭据库已超过轮换前的代次（期间重新授权或导入）时抛 credential_superseded，调用方释放租约并回复 409；
   *   - 凭据包缺失、打不开或缺少 BPS 令牌时抛对应错误码，Worker 重试报告。
   * 调用前先 prepare()：凭据库的首次打开要读库，不能发生在事务内（R6 复审 P2-1）。
   */
  async function recordRotation({
    accountResourceId,
    runtimeAccountId,
    grant,
    credentialBundle,
    revision,
    previousRevision,
    sourceInstanceId,
  }) {
    if (!credentialBundle)
      throw Object.assign(new Error('rotated report carries no credential bundle'), {
        code: 'credential_bundle_missing',
      })
    const { native, bps } = vaultSecretsFromBundle(open(runtimeAccountId, credentialBundle))
    const vault = await getVault()
    if (grant !== 'native' && !bps)
      throw Object.assign(new Error('rotated BPS report carries no BPS credentials'), {
        code: 'bps_credentials_missing',
      })
    const vaultRevision = grant === 'native' ? Number(revision) : Number(revision) + 1
    const expected = grant === 'native' ? Number(previousRevision) : Number(previousRevision) + 1
    const current = await vault.meta(accountResourceId, grant)
    // 凭据库已超过轮换前的代次：期间重新授权或导入过，这次轮换出的令牌作废
    if (current && current.revision > expected)
      throw Object.assign(new Error(`vault revision ${current.revision} supersedes rotation from ${expected}`), {
        code: 'credential_superseded',
        current_revision: current.revision,
      })
    // 凭据库落后于轮换前的代次（此前的报告丢失）时同样以本次轮换为准：按刚读到的代次 CAS（同一事务内）
    await vault.put({
      accountResourceId,
      grant,
      revision: vaultRevision,
      secrets: grant === 'native' ? native : bps,
      ...(current ? { expectedRevision: current.revision } : {}),
      source: 'refresh',
      sourceInstanceId,
    })
    return { ok: true, revision: vaultRevision }
  }

  /**
   * 导出账号文件用的令牌（P3.9）：读凭据库；凭据库比 Worker 副本旧时用 Worker 导出的凭据包。
   * exported 为 Worker 导出接口的 data。返回 { credentials, bps_credentials? }，与旧明文接口字段一致。
   */
  async function exportSecrets({ accountResourceId, runtimeAccountId, exported }) {
    const account = exported?.account || {}
    // 先收录 Worker 当前的副本；凭据库仍比 Worker 旧（收录失败）时用 Worker 的副本（终审 B5）
    try {
      await capture({ accountResourceId, runtimeAccountId, exported, source: 'account_export' })
    } catch {}
    const vault = await getVault()
    const nativeRecord = await vault.get(accountResourceId, 'native')
    const bpsRecord = await vault.get(accountResourceId, 'bps')
    const fromWorker = exported?.credential_bundle
      ? vaultSecretsFromBundle(open(runtimeAccountId, exported.credential_bundle) || {})
      : { native: {}, bps: null }
    const nativeCurrent = nativeRecord && nativeRecord.revision >= Number(account.credential_revision || 0)
    const native = nativeCurrent ? nativeRecord.secrets : fromWorker.native
    const nativeExpiry = (nativeCurrent && unixSeconds(nativeRecord?.expires_at)) || unixSeconds(account.expires_at)
    const bpsCurrent = bpsRecord && bpsRecord.revision >= bpsVaultRevision(account)
    // Worker 副本不带 BPS 状态时沿用凭据库（撤销 BPS 时凭据库记录已一并删除）
    const bps = account.bps ? (bpsCurrent ? bpsRecord.secrets : fromWorker.bps) : bpsRecord?.secrets || null
    const bpsExpiry = (bpsCurrent && unixSeconds(bpsRecord?.expires_at)) || unixSeconds(account.bps?.expires_at)
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

  /** 凭据库里某类授权的代次（没有记录或凭据库读不出时为 0）。BPS 为令牌代次 + 1。 */
  async function vaultRevision(accountResourceId, grant) {
    try {
      return (await (await getVault()).meta(accountResourceId, grant))?.revision || 0
    } catch {
      return 0
    }
  }

  /**
   * 撤销某类授权后删除凭据库里的记录（例如撤销 BPS 授权）：否则重新授权后代次从头计，旧记录会被当成更新而投影出去。
   */
  async function forget(accountResourceId, grant) {
    return (await getVault()).remove(accountResourceId, grant)
  }

  /**
   * 在事务前打开凭据库（R6 复审 P2-1）：打开本身要读库，若首次打开发生在事务内（forget），它排在该事务之后，
   * 事务又在等它，最终被跨事件循环守卫回滚。打开失败在这里忽略，事务内的调用照常报错。
   */
  async function prepare() {
    if (store) return
    await getVault().catch(() => {})
  }

  return {
    capture,
    inspect,
    recordRotation,
    exportSecrets,
    forget,
    prepare,
    vaultRevision,
    vault: getVault,
    tokenFingerprint,
  }
}
