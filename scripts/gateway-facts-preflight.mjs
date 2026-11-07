#!/usr/bin/env node
/**
 * Gateway 事实直读的只读检查（设计第 19 节）：确认库里的账号事实完整、可读，Worker 能据此调度。
 *
 *   node scripts/gateway-facts-preflight.mjs --data-dir data
 *
 * 检查项（未归档、未删除的 Gateway 账号）：
 *   - 凭据：凭据库有原生授权，能用主密钥解开，且原生代次不低于绑定记录的代次；
 *   - 运行账号 ID（迁移 124 回填）与安装身份；
 *   - secret_json 能解开且带出站代理。
 * 凭据由控制面直接写入（S1，2026-11-07），不再从 Worker 收录；缺凭据或安装身份的账号需重新授权。
 * 有任何问题时退出码为 1。只读打开数据库，不写入。
 */
import fs from 'node:fs'
import path from 'node:path'
import { loadRuntimeSecretsReadOnly } from '../src/lib/core/runtime-secrets.mjs'
import { dbClient } from '../src/lib/db/db-client.mjs'
import { maybeDecrypt } from '../src/lib/db/secure.mjs'
import { openScriptDatabase } from '../src/lib/executor/repos/script-db-repo.mjs'
import { createCredentialCustody } from '../src/lib/executor/credential-custody.mjs'
import { masterKeyFile, vaultHasRecords } from '../src/lib/executor/vault.mjs'
import { warmCodexSettings } from '../src/lib/executor/settings-store.mjs'

const parse = (value, fallback) => {
  try {
    return value == null ? fallback : JSON.parse(value)
  } catch {
    return fallback
  }
}

/** 只读检查；返回 { items, summary }。 */
export async function gatewayFactsPreflight({ db, env = process.env, log = console }) {
  const c = dbClient(db)
  const custody = createCredentialCustody({ db, env, log })
  // 不创建主密钥文件：还没有主密钥文件、库里也没有记录时按空凭据库检查
  const vault = fs.existsSync(masterKeyFile(env, db)) || (await vaultHasRecords(db)) ? await custody.vault() : null
  const rows = await c.many(
    "SELECT * FROM gateway_account_facts_v1 WHERE deleted_at IS NULL AND status<>'archived' ORDER BY account_resource_id",
  )
  const items = []
  for (const row of rows) {
    const id = row.account_resource_id
    const item = { account_resource_id: id, issues: [] }
    items.push(item)
    if (!row.runtime_account_id) item.issues.push('runtime_account_id_missing')
    if (!row.installation_id) item.issues.push('installation_id_missing')
    const bindingRevision = Number(
      (
        await c.one(
          'SELECT MAX(credential_revision) AS r FROM gateway_worker_account_bindings WHERE account_resource_id=?',
          id,
        )
      )?.r || 0,
    )
    if (!row.native_revision) item.issues.push('native_credential_missing')
    else {
      try {
        if (!(await vault?.get(id, 'native'))) item.issues.push('native_credential_unreadable')
      } catch (error) {
        item.issues.push(`native_credential_unreadable:${error.code || 'error'}`)
      }
      if (Number(row.native_revision) < bindingRevision) item.issues.push('native_credential_behind')
    }
    try {
      if (!parse(maybeDecrypt(row.secret_json), {})?.proxy_url) item.issues.push('proxy_missing')
    } catch {
      item.issues.push('secret_unreadable')
    }
  }
  const summary = { accounts: items.length, with_issues: 0 }
  for (const item of items) {
    if (item.issues.length) summary.with_issues++
    for (const issue of item.issues) {
      const key = issue.split(':')[0]
      summary[key] = (summary[key] || 0) + 1
    }
  }
  return { items, summary }
}

async function main(argv) {
  const value = (flag) => {
    const index = argv.indexOf(flag)
    return index >= 0 ? argv[index + 1] : null
  }
  const dataDir = path.resolve(value('--data-dir') || process.env.KIN_DATA_DIR || 'data')
  const env = { ...process.env, KIN_DATA_DIR: dataDir }
  loadRuntimeSecretsReadOnly({ env })
  for (const name of ['TAPMODELS_DB_SECRET', 'KIN_DB_SECRET']) if (env[name]) process.env[name] = env[name]
  const db = openScriptDatabase({ dataDir, readOnly: true })
  try {
    await warmCodexSettings(db)
    const report = await gatewayFactsPreflight({ db, env })
    console.log(JSON.stringify(report, null, 2))
    process.exitCode = report.summary.with_issues ? 1 : 0
  } finally {
    db.close()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main(process.argv.slice(2))
