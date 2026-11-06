#!/usr/bin/env node
/**
 * Gateway 事实直读的上线前检查（设计第 19 节，G2）：Worker 改为直读 kin.db 之前，确认库里的事实完整、可读，
 * 且与 Worker 当前持有的副本一致。
 *
 *   node scripts/gateway-facts-preflight.mjs --data-dir data            # 只读演练：逐个账号列出问题
 *   node scripts/gateway-facts-preflight.mjs --data-dir data --apply    # 收录凭据与安装身份
 *
 * 检查项（未归档、未删除的 Gateway 账号）：
 *   - 凭据：先运行 migrate-worker-credentials 的同一流程（演练或收录），再确认凭据库有原生授权（有 BPS 授权的账号还有 BPS）、
 *     能用主密钥解开，且原生代次不低于各实例绑定记录的最高代次；
 *   - 运行账号 ID（迁移 124 回填）与安装身份（--apply 时从 Worker 导出收录）；
 *   - secret_json 能解开且带出站代理。
 * 分组只以 group_resources 为准（迁移 128 删除了 config.group_ids），不再检查。
 * 有任何未解决的问题时退出码为 1。需要的密钥与运行方式同 migrate-worker-credentials.mjs。
 */
import fs from 'node:fs'
import path from 'node:path'
import { loadRuntimeSecretsReadOnly } from '../src/lib/core/runtime-secrets.mjs'
import { dbClient } from '../src/lib/db/db-client.mjs'
import { maybeDecrypt } from '../src/lib/db/secure.mjs'
import { openScriptDatabase } from '../src/lib/executor/repos/script-db-repo.mjs'
import { createCredentialCustody } from '../src/lib/executor/credential-custody.mjs'
import { masterKeyFile, vaultHasRecords } from '../src/lib/executor/vault.mjs'
import { audit } from '../src/lib/admin/relay-common.mjs'
import { warmCodexSettings } from '../src/lib/executor/settings-store.mjs'
import { migrateWorkerCredentials } from './migrate-worker-credentials.mjs'

const parse = (value, fallback) => {
  try {
    return value == null ? fallback : JSON.parse(value)
  } catch {
    return fallback
  }
}

/** 演练或执行检查；返回 { apply, credentials, items, summary }。credentials 可注入（测试）。 */
export async function gatewayFactsPreflight({
  db,
  env = process.env,
  apply = false,
  client = null,
  log = console,
  credentials = migrateWorkerCredentials,
}) {
  const credentialReport = await credentials({ db, env, apply, client, log })
  const c = dbClient(db)
  const custody = createCredentialCustody({ db, env, log })
  // 只读演练不创建主密钥文件（与迁移工具一致）：还没有主密钥文件、库里也没有记录时按空凭据库检查
  const vault =
    apply || fs.existsSync(masterKeyFile(env, db)) || (await vaultHasRecords(db)) ? await custody.vault() : null
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
    if (row.bps_grant_revision != null) {
      if (!row.bps_revision) item.issues.push('bps_credential_missing')
      else
        try {
          if (!(await vault?.get(id, 'bps'))) item.issues.push('bps_credential_unreadable')
        } catch (error) {
          item.issues.push(`bps_credential_unreadable:${error.code || 'error'}`)
        }
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
  if (credentialReport.summary?.errors) summary.credential_errors = credentialReport.summary.errors
  if (apply)
    await audit(
      db,
      'system:gateway-facts-preflight',
      'gateway.facts.preflight',
      'gateway_account_facts_v1',
      null,
      summary,
    )
  return { apply, credentials: credentialReport, items, summary }
}

async function main(argv) {
  const value = (flag) => {
    const index = argv.indexOf(flag)
    return index >= 0 ? argv[index + 1] : null
  }
  const dataDir = path.resolve(value('--data-dir') || process.env.KIN_DATA_DIR || 'data')
  const apply = argv.includes('--apply')
  const env = { ...process.env, KIN_DATA_DIR: dataDir }
  loadRuntimeSecretsReadOnly({ env })
  for (const name of ['KIN_CODEX_GATEWAY_INTERNAL_TOKEN', 'KIN_CODEX_GATEWAY_CREDENTIAL_BUNDLE_KEY'])
    if (!env[name]) {
      console.error(
        `${name} is not configured and was not found in ${path.join(dataDir, 'runtime-secrets.json')} or .env`,
      )
      process.exitCode = 2
      return
    }
  for (const name of ['TAPMODELS_DB_SECRET', 'KIN_DB_SECRET']) if (env[name]) process.env[name] = env[name]
  const db = openScriptDatabase({ dataDir, readOnly: !apply })
  try {
    await warmCodexSettings(db)
    const report = await gatewayFactsPreflight({ db, env, apply })
    console.log(JSON.stringify(report, null, 2))
    process.exitCode = report.summary.with_issues || report.summary.credential_errors ? 1 : 0
  } finally {
    db.close()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main(process.argv.slice(2))
