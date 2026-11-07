/**
 * Claude 槽凭据的加密副本（审计 P1-C9）。
 *
 * Claude 订阅账号的刷新令牌只有一份：槽内 `cli-home/.claude/credentials.json`。面板备份与每日备份都不含它，
 * 槽目录损坏或误删后只能请账号主人重新授权。这里在每次换票成功与导入之后，把整份凭据文档按凭据库的信封加密
 * 写入 `executor_credentials`（账号键 `claude-slot:<vmId>`，授权类别 `claude_slot`，代次 = `kinGeneration`），
 * 随数据库备份；恢复需要同一主密钥文件（主密钥与数据库分开备份，见 vault.mjs）。
 *
 * 只做副本：调度与推理不读它，不会自动覆盖槽内文件；从副本恢复用 `scripts/claude-slot-credential-restore.mjs`。
 * 写副本失败只告警，不影响换票与导入。
 */
import fs from 'node:fs'
import { getDb } from '../db/database.mjs'
import { openCredentialVault } from '../executor/vault.mjs'
import { slotWorkerCredentialPath } from './oauth-credentials.mjs'

export const CLAUDE_SLOT_GRANT = 'claude_slot'

export function claudeSlotVaultId(vmId) {
  return `claude-slot:${String(vmId || '').trim()}`
}

function readDocument(homeDir) {
  const file = slotWorkerCredentialPath(homeDir)
  if (!file || !fs.existsSync(file)) return null
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/** 把槽内当前凭据写入凭据库副本；代次不比已有副本新时跳过。返回写入结果或 null。 */
export async function mirrorClaudeSlotCredential(vmId, homeDir, { db = null, log = console } = {}) {
  if (!vmId || !homeDir || process.env.KIN_CRS_MOCK === '1') return null
  let database = db
  try {
    database ||= getDb()
  } catch {
    return null
  }
  if (!database) return null
  try {
    const document = readDocument(homeDir)
    if (!document || typeof document !== 'object') return null
    const oauth = document.claudeAiOauth && typeof document.claudeAiOauth === 'object' ? document.claudeAiOauth : null
    const apiKey = document.anthropicApiKey?.apiKey || ''
    if (!oauth?.accessToken && !oauth?.refreshToken && !apiKey) return null
    const revision = Number(document.kinGeneration || oauth?.kinGeneration)
    if (!Number.isSafeInteger(revision) || revision < 1) return null
    const vault = await openCredentialVault({ db: database })
    const expiresAt = Number(oauth?.expiresAt) > 0 ? new Date(Number(oauth.expiresAt)).toISOString() : null
    return await vault.put({
      accountResourceId: claudeSlotVaultId(vmId),
      grant: CLAUDE_SLOT_GRANT,
      revision,
      secrets: { refresh_token: oauth?.refreshToken || '', document },
      expiresAt,
      source: 'claude_slot_mirror',
    })
  } catch (error) {
    if (error?.code === 'stale_revision') return null
    log?.warn?.(`[claude-slot-vault] ${vmId}: mirror failed: ${error?.code || error?.message || error}`)
    return null
  }
}

/** 读取副本（解密后的整份凭据文档）；没有副本返回 null。 */
export async function readClaudeSlotVaultCopy(vmId, { db = null } = {}) {
  const vault = await openCredentialVault({ db: db || getDb() })
  const record = await vault.get(claudeSlotVaultId(vmId), CLAUDE_SLOT_GRANT)
  if (!record) return null
  return { revision: record.revision, updated_at: record.updated_at, document: record.secrets?.document || null }
}
