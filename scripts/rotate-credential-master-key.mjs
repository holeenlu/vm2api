#!/usr/bin/env node
/**
 * 凭据库主密钥轮换（统一控制面重构 P3.4）。
 *
 *   node scripts/rotate-credential-master-key.mjs --data-dir data --rotate   # 新增主密钥并设为 active，重新包裹全部数据密钥
 *   node scripts/rotate-credential-master-key.mjs --data-dir data --retire   # 从主密钥文件去掉不再被引用的旧主密钥（归档，不删除）
 *   node scripts/rotate-credential-master-key.mjs --data-dir data --status   # 只读：主密钥列表与各密钥引用条数
 *
 * 主密钥文件默认 <data-dir>/credential-master-keys.json，可用 --key-file 或 KIN_CREDENTIAL_MASTER_KEY_FILE 指定。
 * 轮换前自动把主密钥文件备份为同目录 .bak-<时间>；新主密钥先 fsync 落盘，再在一个数据库事务内重新包裹，
 * 失败时数据库不变（下次可直接再跑）。控制面可以在线：读到不认识的主密钥 ID 会重读主密钥文件，
 * 写入前也会检查主密钥文件是否变过并改用新的 active 主密钥。--retire 只去掉没有任何记录引用的旧主密钥，
 * 去掉前归档到主密钥文件同目录的 credential-master-keys.retired/<时间>.json（目录 0700、文件 0600，审计 U6）：
 * 轮换前的数据库备份仍由旧主密钥包裹，恢复时从归档加回；不再需要时由运维自行删除归档。
 * 为避开“检查引用”与“去掉密钥”之间的极短窗口，建议轮换后等控制面完成一次写入或重启后再执行 --retire。
 * 必须显式给出 --rotate、--retire 或 --status 之一，不带参数只打印用法（审计 U3）；脚本不执行数据库迁移，
 * 库结构落后于本版本代码时直接报错，--status 以只读方式打开数据库。
 */
import path from 'node:path'
import { openScriptDatabase } from '../src/lib/executor/repos/script-db-repo.mjs'
import {
  addMasterKey,
  backupKeyring,
  createCredentialVault,
  loadKeyring,
  retireMasterKeys,
} from '../src/lib/executor/vault.mjs'

export async function rotateMasterKey({ db, file }) {
  const backup = backupKeyring(file)
  const id = addMasterKey(file)
  const vault = createCredentialVault({ db, keyring: loadKeyring({ file, create: false }) })
  return { active: id, rewrapped: await vault.rewrap(), backup }
}

export async function retireUnusedKeys({ db, file }) {
  const vault = createCredentialVault({ db, keyring: loadKeyring({ file, create: false }) })
  return retireMasterKeys(file, await vault.keysInUse())
}

export function keyStatus({ db, file }) {
  const keyring = loadKeyring({ file, create: false })
  const counts = Object.fromEntries(
    db
      .prepare('SELECT master_key_id,COUNT(*) AS n FROM executor_credentials GROUP BY 1')
      .all()
      .map((row) => [row.master_key_id, Number(row.n)]),
  )
  return { active: keyring.active, keys: [...keyring.keys.keys()].map((id) => ({ id, records: counts[id] || 0 })) }
}

async function main(argv) {
  const value = (flag) => {
    const index = argv.indexOf(flag)
    return index >= 0 ? argv[index + 1] : null
  }
  const dataDir = path.resolve(value('--data-dir') || process.env.KIN_DATA_DIR || 'data')
  const file = path.resolve(
    value('--key-file') ||
      process.env.KIN_CREDENTIAL_MASTER_KEY_FILE ||
      path.join(dataDir, 'credential-master-keys.json'),
  )
  const action = ['--rotate', '--retire', '--status'].filter((flag) => argv.includes(flag))
  if (action.length !== 1) {
    console.error(
      'usage: rotate-credential-master-key.mjs --data-dir <dir> [--key-file <file>] (--rotate | --retire | --status)',
    )
    process.exitCode = 2
    return
  }
  const db = openScriptDatabase({ dataDir, readOnly: action[0] === '--status' })
  try {
    const result =
      action[0] === '--status'
        ? keyStatus({ db, file })
        : action[0] === '--retire'
          ? await retireUnusedKeys({ db, file })
          : await rotateMasterKey({ db, file })
    console.log(JSON.stringify(result, null, 2))
  } finally {
    db.close()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main(process.argv.slice(2))
