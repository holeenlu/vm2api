/**
 * 凭据托管（统一控制面重构 P3.5–P3.9，设计第 6 节）：令牌以控制面凭据库为准（vault.mjs）。
 *
 *   - 授权、导入、BPS 授权（S1，2026-11-07）：控制面换码或校验后，在保存账号的同一事务里直接写入凭据库
 *     （account-management.mjs），不再经 Worker 导出收录；
 *   - 刷新（S1b，2026-11-07）：Worker 刷新后直接按代次 CAS 写回凭据库（worker facts_write.go），控制面不经手；
 *   - Worker 从控制面数据库直读凭据库里的令牌（Gateway 事实直读，设计第 19 节）。
 * 导出账号文件（P3.9）只读凭据库。凭据库读写经 DbClient 异步进行（R6 B3）。
 */
import { openCredentialVault, tokenFingerprint } from './vault.mjs'

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

export function createCredentialCustody({ db, env = process.env, vault = null, log = console }) {
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
  /**
   * 导出账号文件用的令牌（P3.9）：只读凭据库。account 为账号配置（邮箱、ChatGPT 账号）。
   * 返回 { credentials, bps_credentials? }，与旧明文接口字段一致。
   */
  async function exportSecrets({ accountResourceId, account = {} }) {
    const vault = await getVault()
    const nativeRecord = await vault.get(accountResourceId, 'native')
    const bpsRecord = await vault.get(accountResourceId, 'bps')
    const native = nativeRecord?.secrets || {}
    const nativeExpiry = unixSeconds(nativeRecord?.expires_at)
    const credentials = {
      access_token: native.access_token || '',
      refresh_token: native.refresh_token || '',
      id_token: native.id_token || '',
      chatgpt_account_id: account.chatgpt_account_id || '',
      email: account.email || '',
      ...(nativeExpiry ? { expires_at: nativeExpiry } : {}),
    }
    const out = { credentials }
    const bps = bpsRecord?.secrets
    if (bps?.access_token) {
      const bpsExpiry = unixSeconds(bpsRecord.expires_at)
      out.bps_credentials = {
        access_token: bps.access_token,
        refresh_token: bps.refresh_token || '',
        id_token: bps.id_token || '',
        chatgpt_account_id: bpsAccountId(account, bps.access_token),
        ...(bpsExpiry ? { expires_at: bpsExpiry } : {}),
      }
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
    exportSecrets,
    forget,
    prepare,
    vaultRevision,
    vault: getVault,
    tokenFingerprint,
  }
}
