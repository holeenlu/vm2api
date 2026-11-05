import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { createCredentialVault, loadKeyring } from '../../src/lib/executor/vault.mjs'
import { nextGatewayAccountId } from '../../src/lib/gateway-worker/account-ids.mjs'
import {
  applyRename,
  planRename,
  renameWorkerAccounts,
  verifyRename,
} from '../../scripts/rename-gateway-account-ids.mjs'

const A = 'account_aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const B = 'account_bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
const VM = 'account_cccccccc-3333-4333-8333-cccccccccccc'

async function fixture(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gwid-'))
  const db = createDatabase({ dataDir: dir })
  const keyring = loadKeyring({ file: path.join(dir, 'credential-master-keys.json') })
  try {
    const account = db.prepare(
      'INSERT INTO vendor_resources(id,resource_type,name,status,config_json,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
    )
    account.run(
      A,
      'account',
      'alpha',
      'active',
      '{"execution_kind":"gateway_worker","platform":"openai"}',
      't',
      '2026-01-02T00:00:00Z',
      'x',
    )
    account.run(
      B,
      'account',
      'beta',
      'paused',
      '{"execution_kind":"gateway_worker","platform":"openai"}',
      't',
      '2026-01-01T00:00:00Z',
      'x',
    )
    account.run(
      'gw-01',
      'account',
      'new',
      'active',
      '{"execution_kind":"gateway_worker","platform":"openai"}',
      't',
      '2026-02-01T00:00:00Z',
      'x',
    )
    db.prepare(
      "INSERT INTO gateway_worker_instances(id,name,base_url,created_at,updated_at) VALUES('gw-01','gw-01','http://w','x','x')",
    ).run()
    const binding = db.prepare(
      "INSERT INTO gateway_worker_account_bindings(id,account_resource_id,gateway_instance_id,runtime_account_id,credential_revision,projection_status,created_at,updated_at) VALUES(?,?,'gw-01',?,1,'synced','x','x')",
    )
    for (const id of [A, B, 'gw-01']) binding.run(`binding_${id}_gw-01`, id, `gwacct_${id}`)
    const groupId = Number(db.prepare("INSERT INTO groups(name) VALUES('gwid-test')").run().lastInsertRowid)
    db.prepare(
      "INSERT INTO group_resources(group_id,resource_kind,resource_id) VALUES(?,'gateway_worker_account',?)",
    ).run(groupId, A)
    db.prepare("INSERT INTO resource_group_versions(resource_kind,resource_id) VALUES('gateway_worker_account',?)").run(
      A,
    )
    const usage = db.prepare(
      'INSERT INTO usage_logs(id,created_at,vm_id,account_id,account_resource_id,execution_kind,input_tokens) VALUES(?,?,?,?,?,?,?)',
    )
    usage.run('u1', '2026-03-01T10:00:00Z', `gateway:${A}`, `gwacct_${A}`, A, 'gateway_worker', 10)
    usage.run('u2', '2026-03-01T10:05:00Z', `gateway:${A}`, `gwacct_${A}`, A, 'gateway_worker', 5)
    usage.run('u3', '2026-03-01T10:00:00Z', VM, VM, null, 'vm', 7)
    db.prepare(
      "INSERT INTO codex_response_owners(scope_hash,response_hash,vm_id,identity_hash,runtime_account_id,account_resource_id,expires_at) VALUES('s','r',?,?,?,?,'2099-01-01')",
    ).run(`gateway:${A}`, `gwacct_${A}`, `gwacct_${A}`, A)
    db.prepare(
      "INSERT INTO gateway_worker_oauth_sessions(session_id,account_resource_id,gateway_instance_id,state_hash,status,expires_at,created_at,updated_at,session_json) VALUES('o1',?,'gw-01','h','pending','2099-01-01T00:00:00Z','x','x','sealed')",
    ).run(A)
    db.prepare(
      "INSERT INTO operation_audit(actor,action,target,before_json,after_json,created_at) VALUES('t','x',?,NULL,NULL,'x')",
    ).run(A)
    const vault = createCredentialVault({ db, keyring })
    await vault.put({ accountResourceId: A, grant: 'native', revision: 3, secrets: { refresh_token: 'rt-a' } })
    await vault.put({ accountResourceId: A, grant: 'bps', revision: 4, secrets: { refresh_token: 'bps-a' } })
    return await fn({ db, keyring, vault })
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('plan numbers legacy Gateway accounts by creation time after the current high-water mark', () =>
  fixture(({ db }) => {
    const plan = planRename(db, { now: () => new Date('2026-11-06T00:00:00Z') })
    assert.equal(plan.seq_after, 3)
    assert.deepEqual(
      plan.accounts.map((item) => [
        item.resource_id_old,
        item.resource_id_new,
        item.runtime_id_old,
        item.runtime_id_new,
      ]),
      [
        [B, 'gw-02', `gwacct_${B}`, 'gwacct_gw-02'],
        [A, 'gw-03', `gwacct_${A}`, 'gwacct_gw-03'],
      ],
    )
  }))

test('apply renames every derived form in one transaction and keeps credentials, rollups and evidence intact', () =>
  fixture(async ({ db, keyring, vault }) => {
    const plan = planRename(db)
    const report = applyRename(db, plan, { keyring, now: () => new Date('2026-11-06T00:00:00Z') })
    assert.equal(report.credentials_resealed, 2)
    assert.equal(report.oauth_sessions_expired, 1)

    const ids = db
      .prepare("SELECT id FROM vendor_resources WHERE resource_type='account' ORDER BY id")
      .all()
      .map((row) => row.id)
    assert.deepEqual(ids, ['gw-01', 'gw-02', 'gw-03'])
    assert.deepEqual(
      {
        ...db
          .prepare(
            "SELECT id,runtime_account_id FROM gateway_worker_account_bindings WHERE account_resource_id='gw-03'",
          )
          .get(),
      },
      { id: 'binding_gw-03_gw-01', runtime_account_id: 'gwacct_gw-03' },
    )
    assert.equal(
      db
        .prepare(
          "SELECT r.resource_id FROM group_resources r JOIN groups g ON g.id=r.group_id WHERE g.name='gwid-test'",
        )
        .get().resource_id,
      'gw-03',
    )
    assert.deepEqual(
      {
        ...db
          .prepare('SELECT vm_id,identity_hash,runtime_account_id,account_resource_id FROM codex_response_owners')
          .get(),
      },
      {
        vm_id: 'gateway:gw-03',
        identity_hash: 'gwacct_gw-03',
        runtime_account_id: 'gwacct_gw-03',
        account_resource_id: 'gw-03',
      },
    )
    // 凭据按新账号解密，代次不变；旧账号已无记录
    assert.equal((await vault.get('gw-03', 'native')).secrets.refresh_token, 'rt-a')
    assert.equal((await vault.get('gw-03', 'bps')).revision, 4)
    assert.equal(await vault.get(A, 'native'), null)
    // 用量明细改名，汇总表由触发器整体搬桶（没有旧桶、没有重复计数）；VM 账号不受影响
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) n FROM usage_logs WHERE account_resource_id='gw-03' AND vm_id='gateway:gw-03' AND account_id='gwacct_gw-03'",
        )
        .get().n,
      2,
    )
    assert.equal(
      db.prepare('SELECT SUM(input_tokens) n FROM usage_cost_hourly WHERE account_resource_id=?').get('gw-03').n,
      15,
    )
    assert.equal(db.prepare("SELECT COUNT(*) n FROM usage_cost_hourly WHERE account_key LIKE '%account_a%'").get().n, 0)
    assert.equal(db.prepare("SELECT SUM(requests) n FROM usage_stats_hourly WHERE vm_id='gateway:gw-03'").get().n, 2)
    assert.equal(db.prepare('SELECT vm_id FROM usage_logs WHERE id=?').get('u3').vm_id, VM)
    // 未完成的授权会话立即过期
    assert.equal(
      db.prepare("SELECT expires_at FROM gateway_worker_oauth_sessions WHERE session_id='o1'").get().expires_at,
      '2026-11-06T00:00:00.000Z',
    )
    // 审计证据原样保留，另有一条完整映射
    assert.equal(db.prepare("SELECT target FROM operation_audit WHERE actor='t'").get().target, A)
    const audit = db.prepare("SELECT after_json FROM operation_audit WHERE action='gateway.account_ids_renamed'").get()
    assert.deepEqual(JSON.parse(audit.after_json), { [B]: 'gw-02', [A]: 'gw-03' })
    // 下一个新账号接在改名区间之后
    assert.equal(await nextGatewayAccountId(db), 'gw-04')

    const verified = verifyRename(db, plan, { keyring })
    assert.equal(verified.ok, true, JSON.stringify(verified))
    assert.equal(verified.credentials_checked, 2)
    // 原有审计 + 改名审计本身（before/after 记录旧 ID）
    assert.deepEqual(verified.evidence_kept, {
      'operation_audit.target': 1,
      'operation_audit.before_json': 1,
      'operation_audit.after_json': 1,
    })
    assert.deepEqual(applyRename(db, plan, { keyring }), { already_applied: true, accounts: 2 })
  }))

test('apply rolls back entirely when credentials cannot be resealed', () =>
  fixture(({ db }) => {
    const plan = planRename(db)
    assert.throws(() => applyRename(db, plan, { keyring: null }), /master keys are required/)
    assert.ok(db.prepare('SELECT 1 FROM vendor_resources WHERE id=?').get(A))
    assert.equal(db.prepare('SELECT COUNT(*) n FROM usage_logs WHERE account_resource_id=?').get(A).n, 2)
    assert.equal(verifyRename(db, plan, {}).ok, false)
  }))

test('apply refuses a plan whose numbers were taken after it was made', () =>
  fixture(({ db, keyring }) => {
    const plan = planRename(db)
    db.prepare(
      "INSERT INTO vendor_resources(id,resource_type,name,status,config_json,created_by,created_at,updated_at) VALUES('gw-02','account','x','active',?,'t','x','x')",
    ).run('{"execution_kind":"gateway_worker","platform":"openai"}')
    assert.throws(() => applyRename(db, plan, { keyring }), /both .* exist|already in use/)
  }))

test('worker step runs the binary with the supervised Worker environment and runtime secrets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gwid-root-'))
  try {
    const dataDir = path.join(root, 'data')
    fs.mkdirSync(dataDir)
    fs.writeFileSync(
      path.join(dataDir, 'runtime-secrets.json'),
      JSON.stringify({ KIN_CODEX_GATEWAY_CREDENTIAL_BUNDLE_KEY: 'bundle-secret' }),
    )
    const calls = []
    const status = renameWorkerAccounts({
      planFile: '/plans/p.json',
      root,
      dataDir,
      env: { PATH: '/bin', KIN_REDIS_URL: 'redis://r:6379' },
      spawn: (bin, args, options) => {
        calls.push({ bin, args, env: options.env })
        return { status: 0 }
      },
    })
    assert.equal(status, 0)
    assert.equal(calls[0].bin, path.join(root, 'bin', 'kin-codex-gateway'))
    assert.deepEqual(calls[0].args, ['-rename-accounts', '/plans/p.json'])
    assert.equal(calls[0].env.KIN_CODEX_GATEWAY_CREDENTIAL_BUNDLE_KEY, 'bundle-secret')
    assert.equal(calls[0].env.KIN_CODEX_GATEWAY_DATA_DIR, path.join(dataDir, 'codex-gateway'))
    assert.equal(calls[0].env.KIN_CODEX_GATEWAY_INSTANCE_ID, 'gw-01')
    assert.equal(calls[0].env.KIN_REDIS_URL, 'redis://r:6379')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
