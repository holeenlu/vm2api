#!/usr/bin/env node
/**
 * 把 Worker 上的现有令牌收录进控制面凭据库（统一控制面重构 P3.8，设计第 6 节），供切换 KIN_CREDENTIAL_CUSTODY=control 前使用。
 *
 *   node scripts/migrate-worker-credentials.mjs --data-dir data            # 只读演练：列出每个账号会收录 / 已是最新 / 失败
 *   node scripts/migrate-worker-credentials.mjs --data-dir data --apply    # 写入凭据库，并写一条审计记录
 *
 * 每个账号取凭据代次最高、在线的 Worker 绑定导出（凭据包由 KIN_CODEX_GATEWAY_CREDENTIAL_BUNDLE_KEY 解开），
 * 原生授权与 BPS 授权分别按代次单调写入：凭据库已有相同或更高代次时不覆盖。需要与控制面相同的
 * KIN_CODEX_GATEWAY_INTERNAL_TOKEN、KIN_CODEX_GATEWAY_CREDENTIAL_BUNDLE_KEY 与主密钥文件；可在控制面在线时运行。
 * 迁移不删除 Worker 上的令牌（它们在 control 模式下作为投影缓存）。
 */
import path from 'node:path'
import { createDatabase } from '../src/lib/db/database.mjs'
import { GatewayWorkerRepo } from '../src/lib/gateway-worker/gateway-repo.mjs'
import { GatewayWorkerService } from '../src/lib/gateway-worker/gateway-execution.mjs'
import { createCredentialCustody } from '../src/lib/executor/credential-custody.mjs'
import { audit } from '../src/lib/admin/relay-common.mjs'

const ONLINE = new Set(['healthy', 'degraded'])

/** 演练或执行迁移；返回 { apply, items, summary }。client 可注入（测试）。 */
export async function migrateWorkerCredentials({ db, env = process.env, apply = false, client = null, log = console }) {
  const repo = new GatewayWorkerRepo(db)
  const service = new GatewayWorkerService({ repo, secret: env.KIN_CODEX_GATEWAY_INTERNAL_TOKEN || '' })
  const workers = client || service.client
  const custody = createCredentialCustody({ db, env: { ...env, KIN_CREDENTIAL_CUSTODY: 'control' }, log })
  const vault = custody.vault()
  const items = []
  for (const account of repo.listProjectableAccounts()) {
    if (account.status === 'archived') continue
    const bindings = repo
      .listAccountBindings(account.id)
      .filter((binding) => ONLINE.has(repo.getInstance(binding.gateway_instance_id)?.health_state))
      .sort((a, b) => Number(b.credential_revision || 0) - Number(a.credential_revision || 0))
    const item = { account_resource_id: account.id, native: 'skipped', bps: 'skipped' }
    items.push(item)
    if (!bindings.length) {
      item.error = 'no_online_binding'
      continue
    }
    let exported = null
    for (const binding of bindings) {
      const result = await workers
        .exportAccount(binding.gateway_instance_id, binding.runtime_account_id)
        .catch(() => null)
      if (result?.ok) {
        exported = { binding, data: result.data }
        break
      }
    }
    if (!exported) {
      item.error = 'export_failed'
      continue
    }
    item.source_instance_id = exported.binding.gateway_instance_id
    const nativeRevision = Number(exported.data?.account?.credential_revision || 0)
    const bpsRevision = Number(exported.data?.account?.bps?.revision || 0)
    try {
      if (apply) {
        Object.assign(
          item,
          custody.capture({
            accountResourceId: account.id,
            runtimeAccountId: exported.binding.runtime_account_id,
            exported: exported.data,
            sourceInstanceId: exported.binding.gateway_instance_id,
            source: 'migration',
          }),
        )
      } else {
        const current = (grant) => vault.meta(account.id, grant)?.revision || 0
        if (nativeRevision) item.native = nativeRevision > current('native') ? 'would_store' : 'current'
        if (bpsRevision) item.bps = bpsRevision > current('bps') ? 'would_store' : 'current'
      }
    } catch (error) {
      item.error = error.code || error.message
    }
  }
  const summary = {}
  for (const item of items) {
    for (const grant of ['native', 'bps'])
      summary[`${grant}_${item[grant]}`] = (summary[`${grant}_${item[grant]}`] || 0) + 1
    if (item.error) summary.errors = (summary.errors || 0) + 1
  }
  if (apply)
    audit(db, 'system:credential-migration', 'gateway.credentials.migrated', 'executor_credentials', null, summary)
  return { apply, items, summary }
}

async function main(argv) {
  const value = (flag) => {
    const index = argv.indexOf(flag)
    return index >= 0 ? argv[index + 1] : null
  }
  const dataDir = path.resolve(value('--data-dir') || process.env.KIN_DATA_DIR || 'data')
  const db = createDatabase({ dataDir })
  try {
    const env = { ...process.env, KIN_DATA_DIR: dataDir }
    const report = await migrateWorkerCredentials({ db, env, apply: argv.includes('--apply') })
    console.log(JSON.stringify(report, null, 2))
    process.exitCode = report.summary.errors ? 1 : 0
  } finally {
    db.close()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main(process.argv.slice(2))
