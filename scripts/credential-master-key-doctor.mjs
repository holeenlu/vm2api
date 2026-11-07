#!/usr/bin/env node
/**
 * 凭据库主密钥诊断与重置（最终审计 U7）。
 *
 *   node scripts/credential-master-key-doctor.mjs --data-dir data                    # 只读诊断
 *   node scripts/credential-master-key-doctor.mjs --data-dir data --reset            # 预览重置：列出将删除的记录，不改动
 *   node scripts/credential-master-key-doctor.mjs --data-dir data --reset --confirm  # 主密钥确定丢失时重置
 *
 * 诊断（只读打开数据库，不改主密钥文件权限、不生成密钥）：主密钥文件是否存在、可读、格式是否合法；
 * 凭据库每条记录由哪个主密钥 ID 包裹、用现有主密钥能否解开；解不开的记录能否用退役归档
 * （credential-master-keys.retired/，见 rotate-credential-master-key.mjs --retire）里的密钥解开。
 * 解密只在内存里验证，报告不含任何密钥、令牌或令牌指纹。
 *
 * 重置只在主密钥确定丢失、且运维明确要求时执行（--reset --confirm），先停控制面：
 *   1. 把数据库快照（VACUUM INTO）与主密钥文件备份到 <data-dir>/backups/credential-master-key-reset-<时间>/（目录 0700、文件 0600）；
 *   2. 在一个事务里删除凭据库中用现有主密钥与归档都解不开的记录，并写一条审计；
 *   3. 主密钥文件缺失或格式不合法时生成新主密钥文件；文件本身合法（只是记录引用的旧主密钥丢了）时保留现有文件。
 * 有记录能用归档密钥解开时拒绝重置：先把归档里的密钥加回主密钥文件（见运维文档第 10 节）。主密钥文件存在但读不出
 * （权限等）时也拒绝，先修复读取。重置后凭据库里被删的账号由 Worker 下一次刷新写回（可在账号上手动刷新）；Worker 上也没有的账号逐个重新授权。
 *
 * 主密钥文件默认按控制面口径（KIN_CREDENTIAL_MASTER_KEY_FILE，否则数据库同目录 credential-master-keys.json），可用 --key-file 指定。
 * 脚本不执行数据库迁移：库结构落后于本版本代码时报 schema_outdated。
 */
import fs from 'node:fs'
import path from 'node:path'
import { vacuumInto } from '../src/lib/db/database.mjs'
import { dbClient } from '../src/lib/db/db-client.mjs'
import { audit } from '../src/lib/admin/relay-common.mjs'
import { openScriptDatabase } from '../src/lib/executor/repos/script-db-repo.mjs'
import {
  createCredentialVault,
  loadKeyring,
  masterKeyFile,
  readRetiredKeys,
  retiredKeyArchiveDir,
  validKeyring,
} from '../src/lib/executor/vault.mjs'

const stampOf = (now) => new Date(now).toISOString().replace(/[:.]/g, '-')

/** 只读检查主密钥文件：返回 { report, keyring }（keyring 为 null 表示不可用）。不修改文件权限。 */
function inspectKeyFile(file) {
  const report = { path: file, exists: false, readable: false, valid: false }
  let raw
  try {
    const stat = fs.statSync(file)
    report.exists = true
    report.mode = `0${(stat.mode & 0o777).toString(8)}`
    raw = fs.readFileSync(file, 'utf8')
    report.readable = true
  } catch (error) {
    if (report.exists) report.error = error.code || 'unreadable'
    return { report, keyring: null }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    report.error = 'invalid_json'
    return { report, keyring: null }
  }
  if (!validKeyring(parsed)) {
    report.error = 'invalid_format'
    return { report, keyring: null }
  }
  report.valid = true
  report.active = parsed.active
  report.key_ids = Object.keys(parsed.keys)
  if (report.mode !== '0600') report.warning = 'master key file should be 0600'
  const keys = new Map(Object.entries(parsed.keys).map(([id, key]) => [id, Buffer.from(key, 'base64')]))
  return { report, keyring: { file, active: parsed.active, keys } }
}

// 用给定主密钥尝试解开一条记录；只返回结果代码，明文立即丢弃
async function tryOpen(db, keyring, meta) {
  if (!keyring?.keys.has(meta.master_key_id)) return 'master_key_missing'
  try {
    await createCredentialVault({ db, keyring }).get(meta.account_resource_id, meta.grant)
    return 'ok'
  } catch (error) {
    return error?.code || 'unreadable'
  }
}

/**
 * 只读诊断。返回 { status, master_key_file, archive, records, summary }：
 * status 为 ok（全部可解开）/ no_records / recoverable_from_archive（有记录只能用归档密钥解开）/
 * key_file_unreadable（文件存在但读不出）/ master_key_file_missing（有记录、但这个路径上没有主密钥文件：多半是路径不对，重置需 --key-file 明确指定）/ master_key_lost（有记录用现有密钥与归档都解不开）。
 */
export async function diagnoseMasterKey({ db, file }) {
  const { report: keyFile, keyring } = inspectKeyFile(file)
  const retired = readRetiredKeys(file)
  const archiveDir = retiredKeyArchiveDir(file)
  const archive = {
    dir: archiveDir,
    exists: fs.existsSync(archiveDir),
    files: [...new Set(retired.map((item) => item.archive))].map((archiveFile) => ({
      file: archiveFile,
      key_ids: retired.filter((item) => item.archive === archiveFile).map((item) => item.id),
    })),
  }
  // 列记录只读元数据（不解密）；keyring 只用于构造仓储访问，list 不碰密钥
  const metas = await createCredentialVault({ db, keyring: keyring || { active: '', keys: new Map() } }).list()
  const records = []
  for (const meta of metas) {
    const record = {
      account_resource_id: meta.account_resource_id,
      grant: meta.grant,
      revision: meta.revision,
      master_key_id: meta.master_key_id,
      status: await tryOpen(db, keyring, meta),
    }
    if (record.status !== 'ok') {
      for (const item of retired.filter((entry) => entry.id === meta.master_key_id)) {
        const archived = { file, active: item.id, keys: new Map([[item.id, item.key]]) }
        if ((await tryOpen(db, archived, meta)) === 'ok') {
          record.recoverable_from = item.archive
          break
        }
      }
    }
    records.push(record)
  }
  const byKey = {}
  for (const record of records) byKey[record.master_key_id] = (byKey[record.master_key_id] || 0) + 1
  const unreadable = records.filter((record) => record.status !== 'ok')
  const recoverable = unreadable.filter((record) => record.recoverable_from)
  const summary = {
    records: records.length,
    by_master_key: byKey,
    readable: records.length - unreadable.length,
    unreadable: unreadable.length,
    recoverable_from_archive: recoverable.length,
    missing_master_keys: [
      ...new Set(unreadable.filter((record) => record.status === 'master_key_missing').map((r) => r.master_key_id)),
    ].sort(),
  }
  const status = !records.length
    ? keyFile.exists && !keyFile.valid
      ? keyFile.readable
        ? 'master_key_lost'
        : 'key_file_unreadable'
      : 'no_records'
    : !unreadable.length
      ? 'ok'
      : keyFile.exists && !keyFile.readable
        ? 'key_file_unreadable'
        : recoverable.length
          ? 'recoverable_from_archive'
          : !keyFile.exists
            ? // 文件根本不在这个路径：多半是路径不对（控制面用 KIN_CREDENTIAL_MASTER_KEY_FILE 自定义了位置），
              // 不能直接判为丢失（M5 复审 P1-2）
              'master_key_file_missing'
            : 'master_key_lost'
  return { status, master_key_file: keyFile, archive, records, summary }
}

const NEXT_STEPS = [
  'restart the control plane',
  'refresh the affected Gateway accounts (the Worker writes its tokens back to the vault on refresh)',
  'reauthorize the accounts that no Worker holds any more',
]

/**
 * 重置。confirm 为假时只预览（不改动）。返回 { reset, refused?, deleted, new_master_key, backup_dir, next_steps }。
 * dataDir 用于备份位置（<dataDir>/backups/credential-master-key-reset-<时间>/）。
 */
export async function resetMasterKey({
  db,
  file,
  dataDir,
  confirm = false,
  keyFileExplicit = false,
  now = Date.now(),
}) {
  let diagnosis = await diagnoseMasterKey({ db, file })
  if (diagnosis.status === 'master_key_file_missing') {
    // 只有运维用 --key-file 明确指出了主密钥文件的位置、确认它确实不在了，才按丢失处理
    if (!keyFileExplicit)
      return {
        reset: false,
        refused: 'key_file_missing_unconfirmed',
        hint: 'no master key file at this path; if the control plane sets KIN_CREDENTIAL_MASTER_KEY_FILE, run with the same value or pass --key-file <the real path>. Reset only after confirming the key file is really gone, passing --key-file explicitly',
        master_key_file: diagnosis.master_key_file,
        status: diagnosis.status,
      }
    diagnosis = { ...diagnosis, status: 'master_key_lost' }
  }
  const doomed = diagnosis.records.filter((record) => record.status !== 'ok')
  const base = {
    status: diagnosis.status,
    records: doomed.map(({ account_resource_id, grant }) => ({ account_resource_id, grant })),
  }
  if (diagnosis.status === 'recoverable_from_archive')
    return {
      reset: false,
      refused: 'recoverable_from_archive',
      hint: 'add the archived master keys back into the master key file instead of resetting',
      archives: [...new Set(doomed.map((record) => record.recoverable_from).filter(Boolean))],
      ...base,
    }
  if (diagnosis.status === 'key_file_unreadable')
    return { reset: false, refused: 'key_file_unreadable', hint: 'fix the master key file permissions first', ...base }
  if (diagnosis.status !== 'master_key_lost') return { reset: false, refused: 'nothing_to_reset', ...base }
  const newMasterKey = !diagnosis.master_key_file.valid
  if (!confirm)
    return { reset: false, preview: true, would_delete: doomed.length, new_master_key: newMasterKey, ...base }

  // 1. 备份数据库快照与主密钥文件
  const backupDir = path.join(dataDir, 'backups', `credential-master-key-reset-${stampOf(now)}`)
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 })
  fs.chmodSync(backupDir, 0o700)
  vacuumInto(db, path.join(backupDir, path.basename(db.location() || 'kin.db')))
  if (diagnosis.master_key_file.exists) {
    const copy = path.join(backupDir, path.basename(file))
    fs.copyFileSync(file, copy)
    fs.chmodSync(copy, 0o600)
  }
  // 2. 删除解不开的记录（只删诊断时看到的那一代：期间被改写的记录保留）并写审计，同一个事务
  const vault = createCredentialVault({ db, keyring: { active: '', keys: new Map() } })
  let deleted = 0
  await dbClient(db).tx(async () => {
    for (const record of doomed) {
      const current = await vault.meta(record.account_resource_id, record.grant)
      if (current?.revision !== record.revision || current?.master_key_id !== record.master_key_id) continue
      deleted += await vault.remove(record.account_resource_id, record.grant)
    }
    await audit(
      db,
      'system:credential-master-key-doctor',
      'gateway.credentials.master_key_reset',
      'executor_credentials',
      null,
      {
        deleted,
        records: base.records,
        missing_master_keys: diagnosis.summary.missing_master_keys,
        new_master_key: newMasterKey,
        backup_dir: backupDir,
      },
    )
  })
  // 3. 主密钥文件缺失或格式不合法时换一把新的（原文件已备份）
  let active = diagnosis.master_key_file.active || null
  if (newMasterKey) {
    if (diagnosis.master_key_file.exists) fs.rmSync(file, { force: true })
    const created = loadKeyring({ file, create: true })
    active = created.active
  }
  return {
    reset: true,
    deleted,
    new_master_key: newMasterKey,
    active_master_key: active,
    backup_dir: backupDir,
    next_steps: NEXT_STEPS,
    ...base,
  }
}

async function main(argv) {
  const value = (flag) => {
    const index = argv.indexOf(flag)
    return index >= 0 ? argv[index + 1] : null
  }
  if (argv.includes('--confirm') && !argv.includes('--reset')) {
    console.error('usage: credential-master-key-doctor.mjs --data-dir <dir> [--key-file <file>] [--reset [--confirm]]')
    process.exitCode = 2
    return
  }
  const dataDir = path.resolve(value('--data-dir') || process.env.KIN_DATA_DIR || 'data')
  const reset = argv.includes('--reset')
  const confirm = argv.includes('--confirm')
  const db = openScriptDatabase({ dataDir, readOnly: !(reset && confirm) })
  try {
    const env = { ...process.env, KIN_DATA_DIR: dataDir }
    const explicit = value('--key-file')
    const file = path.resolve(explicit || masterKeyFile(env, db))
    // 报告主密钥文件路径的来源，方便发现“脚本看的路径与控制面不一致”
    const keyFileSource = explicit ? 'flag' : env.KIN_CREDENTIAL_MASTER_KEY_FILE ? 'env' : 'default'
    const result = reset
      ? await resetMasterKey({ db, file, dataDir, confirm, keyFileExplicit: !!explicit })
      : await diagnoseMasterKey({ db, file })
    result.master_key_file_source = keyFileSource
    console.log(JSON.stringify(result, null, 2))
    process.exitCode = reset
      ? result.reset || result.preview
        ? 0
        : 1
      : ['ok', 'no_records'].includes(result.status)
        ? 0
        : 1
  } finally {
    db.close()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main(process.argv.slice(2))
