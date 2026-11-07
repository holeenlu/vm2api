#!/usr/bin/env node
/**
 * Claude 槽凭据副本诊断与导出（审计 P1-C9）。
 *
 *   node scripts/claude-slot-credential-restore.mjs <vmId>                     只读：比对凭据库副本与槽内当前凭据的代次
 *   node scripts/claude-slot-credential-restore.mjs <vmId> --export <file>     把副本解密导出为 credentials.json 格式（0600）
 *
 * 不直接改槽内文件：导出后在面板「虚拟机 → 凭据 → 导入」导入（远端节点会同步推送），或由运维核对后自行放回。
 * 需要与数据库同一套主密钥文件（KIN_CREDENTIAL_MASTER_KEY_FILE 或库旁 credential-master-keys.json）。
 * 选项：--data-dir <dir>（默认 ./data）、--project <dir>（默认当前目录，用于找 vms/<vmId>/cli-home）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { openScriptDatabase } from '../src/lib/executor/repos/script-db-repo.mjs'
import { readClaudeSlotVaultCopy } from '../src/lib/oauth/claude-slot-vault.mjs'

function parseArgs(argv) {
  const out = { vmId: '', exportFile: '', dataDir: '', project: process.cwd() }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--export') out.exportFile = argv[++i] || ''
    else if (arg === '--data-dir') out.dataDir = argv[++i] || ''
    else if (arg === '--project') out.project = argv[++i] || out.project
    else if (!out.vmId && !arg.startsWith('--')) out.vmId = arg
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(out.vmId))
    throw new Error('usage: claude-slot-credential-restore.mjs <vmId> [--export <file>]')
  return out
}

function slotGeneration(project, vmId) {
  const file = path.join(project, 'vms', vmId, 'cli-home', '.claude', 'credentials.json')
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
    return { file, generation: Number(doc.kinGeneration || doc.claudeAiOauth?.kinGeneration) || null }
  } catch (error) {
    return { file, generation: null, error: error.code || 'unreadable' }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const db = openScriptDatabase({ dataDir: args.dataDir || undefined, readOnly: true })
  try {
    const copy = await readClaudeSlotVaultCopy(args.vmId, { db })
    const slot = slotGeneration(args.project, args.vmId)
    const report = {
      vm_id: args.vmId,
      vault_copy: copy ? { revision: copy.revision, updated_at: copy.updated_at } : null,
      slot_file: { path: slot.file, generation: slot.generation, error: slot.error || null },
      slot_is_newer_or_equal: !!copy && slot.generation != null && slot.generation >= copy.revision,
    }
    if (args.exportFile) {
      if (!copy?.document) throw new Error(`no vault copy for ${args.vmId}`)
      const fd = fs.openSync(args.exportFile, 'wx', 0o600)
      try {
        fs.writeSync(fd, `${JSON.stringify(copy.document, null, 2)}\n`)
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      report.exported_to = path.resolve(args.exportFile)
    }
    // 报告不含令牌
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } finally {
    db.close()
  }
}

main().catch((error) => {
  process.stderr.write(`${error.code ? `${error.code}: ` : ''}${error.message}\n`)
  process.exit(1)
})
