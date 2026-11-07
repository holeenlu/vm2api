/**
 * 凭据托管（统一控制面重构 P3.5–P3.9，设计第 6 节）：令牌以控制面凭据库为准（vault.mjs）。
 *
 *   - 授权、导入（S1，2026-11-07）：控制面换码或校验后，在保存账号的同一事务里直接写入凭据库
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
   * 返回 { credentials }，与旧明文接口字段一致。
   */
  async function exportSecrets({ accountResourceId, account = {} }) {
    const vault = await getVault()
    const nativeRecord = await vault.get(accountResourceId, 'native')
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
    return { credentials }
  }

  /** 凭据库里某类授权的代次（没有记录或凭据库读不出时为 0）。 */
  async function vaultRevision(accountResourceId, grant) {
    try {
      return (await (await getVault()).meta(accountResourceId, grant))?.revision || 0
    } catch {
      return 0
    }
  }

  /**
   * 删除凭据库里的记录（grant 省略时删除账号的全部授权类别，用于永久删除账号）。
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
