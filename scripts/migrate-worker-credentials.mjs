#!/usr/bin/env node
/**
 * 把 Worker 上的现有令牌收录进控制面凭据库（统一控制面重构 P3.8，设计第 6 节）。凭据固定由控制面托管（G1）后，
 * 从旧版（worker 托管）升级的部署在升级前后各运行一次，确认凭据库不落后于 Worker；主密钥重置后也用它重新收录。
 * 控制面运行时在授权完成、导入与刷新后自动收录。
 *
 *   node scripts/migrate-worker-credentials.mjs --data-dir data            # 只读演练：列出每个账号会收录 / 已是最新 / 失败
 *   node scripts/migrate-worker-credentials.mjs --data-dir data --apply    # 写入凭据库，并写一条审计记录
 *
 * 每个账号取凭据代次最高、在线的 Worker 绑定导出（凭据包由 KIN_CODEX_GATEWAY_CREDENTIAL_BUNDLE_KEY 解开），
 * 原生授权与 BPS 授权分别按代次单调写入：凭据库已有相同或更高代次时不覆盖。需要与控制面相同的
 * KIN_CODEX_GATEWAY_INTERNAL_TOKEN、KIN_CODEX_GATEWAY_CREDENTIAL_BUNDLE_KEY 与主密钥文件；可在控制面在线时运行。
 * 迁移不删除 Worker 上的令牌（它们是 Worker 的本地缓存）。
 *
 * 两把密钥未通过环境变量给出时，从控制面已保存的 data/runtime-secrets.json（或 .env）只读取得，不生成新密钥。
 * 脚本不执行数据库迁移：库结构落后于本版本代码时直接报错，先升级并启动控制面；演练以只读方式打开数据库，
 * 并解开每个账号的凭据包，演练零错误才说明 --apply 能成功（审计 U2、U3）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { loadRuntimeSecretsReadOnly } from '../src/lib/core/runtime-secrets.mjs'
import { openScriptDatabase } from '../src/lib/executor/repos/script-db-repo.mjs'
import { GatewayWorkerRepo } from '../src/lib/gateway-worker/gateway-repo.mjs'
import { GatewayWorkerService } from '../src/lib/gateway-worker/gateway-execution.mjs'
import { createCredentialCustody } from '../src/lib/executor/credential-custody.mjs'
import { masterKeyFile, vaultHasRecords } from '../src/lib/executor/vault.mjs'
import { audit } from '../src/lib/admin/relay-common.mjs'
import { warmCodexSettings } from '../src/lib/executor/settings-store.mjs'

const ONLINE = new Set(['healthy', 'degraded'])

/** 演练或执行迁移；返回 { apply, items, summary }。client 可注入（测试）。 */
export async function migrateWorkerCredentials({ db, env = process.env, apply = false, client = null, log = console }) {
  const repo = new GatewayWorkerRepo(db)
  // 实例密钥（中期技术债 M2）：已签发的 Worker 只接受实例密钥签名，按同一环境（数据库字段密钥或内部令牌）解开
  const service = new GatewayWorkerService({ repo, secret: env.KIN_CODEX_GATEWAY_INTERNAL_TOKEN || '', env })
  const workers = client || service.client
  const custody = createCredentialCustody({ db, env, log })
  // 只读演练不创建主密钥文件（终审 B7）：还没有主密钥文件、库里也没有记录时按空凭据库比较
  const vault =
    apply || fs.existsSync(masterKeyFile(env, db)) || (await vaultHasRecords(db))
      ? await custody.vault()
      : { meta: () => null }
  const items = []
  for (const account of await repo.listGatewayAccountRows()) {
    if (account.status === 'archived') continue
    const bindings = []
    for (const binding of await repo.listAccountBindings(account.id))
      if (ONLINE.has((await repo.getInstance(binding.gateway_instance_id))?.health_state)) bindings.push(binding)
    bindings.sort((a, b) => Number(b.credential_revision || 0) - Number(a.credential_revision || 0))
    const item = { account_resource_id: account.id, native: 'skipped', bps: 'skipped' }
    items.push(item)
    if (!bindings.length) {
      item.error = 'no_online_binding'
      continue
    }
    let exported = null
    const failures = []
    for (const binding of bindings) {
      const result = await workers
        .exportAccount(binding.gateway_instance_id, binding.runtime_account_id)
        .catch((error) => ({ ok: false, status: 0, data: { error: { code: error?.code || error?.message } } }))
      if (result?.ok) {
        exported = { binding, data: result.data }
        break
      }
      // 保留每个实例的失败原因（HTTP 状态与错误码），不再只报 export_failed
      failures.push({
        instance_id: binding.gateway_instance_id,
        status: Number(result?.status || 0),
        code: String(result?.data?.error?.code || result?.data?.error?.type || 'unknown').slice(0, 80),
      })
    }
    if (!exported) {
      item.error = 'export_failed'
      item.export_failures = failures
      continue
    }
    item.source_instance_id = exported.binding.gateway_instance_id
    try {
      if (apply) {
        Object.assign(
          item,
          await custody.capture({
            accountResourceId: account.id,
            runtimeAccountId: exported.binding.runtime_account_id,
            exported: exported.data,
            sourceInstanceId: exported.binding.gateway_instance_id,
            source: 'migration',
          }),
        )
      } else {
        // 演练也解开凭据包，并按 capture 的口径比较代次（BPS 为令牌代次 + 1）
        const current = {
          native: (await vault.meta(account.id, 'native'))?.revision || 0,
          bps: (await vault.meta(account.id, 'bps'))?.revision || 0,
        }
        const revisions = custody.inspect({
          runtimeAccountId: exported.binding.runtime_account_id,
          exported: exported.data,
          currentRevision: (grant) => current[grant],
        })
        if (revisions.native) item.native = revisions.native > current.native ? 'would_store' : 'current'
        if (revisions.bps) item.bps = revisions.bps > current.bps ? 'would_store' : 'current'
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
    await audit(
      db,
      'system:credential-migration',
      'gateway.credentials.migrated',
      'executor_credentials',
      null,
      summary,
    )
  const keyFile = masterKeyFile(env, db)
  return { apply, master_key_file: keyFile, master_key_file_exists: fs.existsSync(keyFile), items, summary }
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
  const db = openScriptDatabase({ dataDir, readOnly: !apply })
  try {
    // 工具进程同样先预热 Codex 设置快照（R6 B8 删除了冷启动同步读）
    await warmCodexSettings(db)
    const report = await migrateWorkerCredentials({ db, env, apply })
    console.log(JSON.stringify(report, null, 2))
    process.exitCode = report.summary.errors ? 1 : 0
  } finally {
    db.close()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main(process.argv.slice(2))
