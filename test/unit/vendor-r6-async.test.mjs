// R6 B4：供应商数据访问异步化的专项回归——竞态 R20（幂等写入）与临时同步出口（…Sync）和 async 版本结果一致。
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { dbClient } from '../../src/lib/db/db-client.mjs'
import { VendorPlatform } from '../../src/lib/vendor/vendor-platform.mjs'
import { createGlobalPricing, pricingEffectiveAt } from '../../src/lib/vendor/vendor-pricing.mjs'
import {
  createDownstreamSettlement,
  mutateDownstreamSettlement,
  previewDownstreamSettlements,
} from '../../src/lib/vendor/vendor-settlements.mjs'
import * as vendorUsage from '../../src/lib/vendor/vendor-usage.mjs'
import * as usageRepo from '../../src/lib/vendor/repos/usage-repo.mjs'
import { UsageLogsRepo } from '../../src/lib/db/repos/usage-logs-repo.mjs'

const { recordVendorUsage } = vendorUsage
import * as accountName from '../../src/lib/vendor/vendor-account-name.mjs'
import * as resources from '../../src/lib/vendor/repos/resources-repo.mjs'

const actor = { system_admin: true, user_id: 'sa' }
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex')

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-r6-async-'))
  const db = createDatabase({ dataDir: dir })
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  db.prepare("UPDATE groups SET platform='mixed' WHERE id=1").run()
  const service = new VendorPlatform(db, { vmProvisioner: ({ resourceId }) => ({ id: 'runtime-' + resourceId }) })
  return { db, service }
}

async function settlementFixture(t) {
  const f = fixture(t)
  const parent = await f.service.createRoot({
    actorUserId: 'sa',
    body: {
      username: 'r20-parent',
      password: 'test-password',
      capabilities: [
        'vendor.create_child',
        'vendor.resource.manage',
        'vendor.vm.create',
        'vendor.usage.read',
        'vendor.settlement.read',
        'vendor.settlement.pay',
      ],
    },
  })
  f.db.prepare('UPDATE vendors SET groups_json=? WHERE id=?').run(JSON.stringify(['1']), parent.id)
  const identity = {
    user_id: f.db.prepare("SELECT id FROM users WHERE username='r20-parent'").get().id,
    vendor: await f.service.getVendor(parent.id),
  }
  const child = await f.service.createChild(identity, { username: 'r20-child', password: 'test-password' })
  const childIdentity = {
    user_id: f.db.prepare("SELECT id FROM users WHERE username='r20-child'").get().id,
    vendor: child,
  }
  const pair = await f.service.createAccount(childIdentity, { platform: 'openai', name: 'r20-account' })
  await createGlobalPricing(f.service, actor, {
    idempotency_key: 'r20-price',
    effective_date: '2026-10-01',
    openai_price: 2,
    claude_price: 1,
    exchange_rate: 5,
  })
  f.db
    .prepare(
      "INSERT INTO usage_logs(id,request_id,vm_id,created_at,status,model,total_cost,input_tokens,output_tokens) VALUES ('u1','u1',?,'2026-10-01T10:00:00.000Z',200,'gpt-5',10,100,20)",
    )
    .run(pair.vm.config.runtime_vm_id)
  await recordVendorUsage(f.db, f.db.prepare("SELECT * FROM usage_logs WHERE id='u1'").get())
  const preview = async () =>
    (
      await previewDownstreamSettlements(f.service, identity, {
        vendor_ids: [child.id],
        start_date: '2026-10-01',
        end_date: '2026-10-02',
        timezone: 'Asia/Shanghai',
      })
    ).items[0]
  return { ...f, parent, identity, child, pair, preview }
}

// 模拟另一个写入方在本次请求“查重之后、写入之前”提交了同一幂等标识：拦截下一次含 marker 的查重，
// 照常返回查询结果（未命中），随后立即写入竞争行。
function commitBetweenCheckAndInsert(db, marker, competitor) {
  const client = dbClient(db)
  const one = client.one
  client.one = async (sql, ...params) => {
    if (!sql.includes(marker)) return one(sql, ...params)
    client.one = one
    const seen = await one(sql, ...params)
    competitor()
    return seen
  }
}

test('R20 global price: a concurrent duplicate key returns the saved price or an idempotency conflict', async (t) => {
  const f = fixture(t)
  const body = {
    idempotency_key: 'race-price-key',
    effective_date: '2026-10-01',
    openai_price: 2,
    claude_price: 1,
    exchange_rate: 5,
  }
  const input = { openai_price: 2, claude_price: 1, exchange_rate: 5, effective_at: pricingEffectiveAt('2026-10-01') }
  const competitor = (inputHash) => () =>
    f.db
      .prepare(`INSERT INTO vendor_contracts(id,leg,payer_vendor_id,payee_vendor_id,version,effective_at,price_cny_per_usd,fx_cny_per_usdt,multiplier,group_prices_json,status,created_by,created_at,idempotency_key,input_hash)
        VALUES ('pricing_winner','platform_to_l1',NULL,NULL,1,?,1,5,1,'{"openai":2,"anthropic":1}','active','sa',?,'race-price-key',?)`)
      .run(input.effective_at, new Date().toISOString(), inputHash)
  commitBetweenCheckAndInsert(f.db, 'idempotency_key=?', competitor(sha256(JSON.stringify(input))))
  const saved = await createGlobalPricing(f.service, actor, body)
  assert.equal(saved.id, 'pricing_winner')
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM vendor_contracts').get().n, 1)
  assert.equal(
    f.db.prepare("SELECT COUNT(*) n FROM vendor_audit_events WHERE action='pricing.version_created'").get().n,
    0,
  )

  f.db.prepare('DELETE FROM vendor_contracts').run()
  commitBetweenCheckAndInsert(f.db, 'idempotency_key=?', competitor('another-request'))
  await assert.rejects(createGlobalPricing(f.service, actor, body), { code: 'idempotency_conflict' })
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM vendor_contracts').get().n, 0)
})

test('R20 downstream statement: a concurrent duplicate key returns the first statement without double allocation', async (t) => {
  const f = await settlementFixture(t)
  const quote = await f.preview()
  const competitor = (inputHash) => () =>
    f.db
      .prepare(`INSERT INTO vendor_settlements(id,contract_id,period_start,period_end,status,amount_usdt,usage_snapshot_json,created_by,created_at,updated_at,idempotency_key,input_hash,payer_vendor_id,payee_vendor_id)
        VALUES ('settlement_winner',?,?,?,'draft',0,'{"source":"usage_logs_v2"}',?,?,?,'race-bill-key',?,?,?)`)
      .run(
        quote.statement.contract_id,
        quote.statement.start_at,
        quote.statement.end_at,
        f.identity.user_id,
        new Date().toISOString(),
        new Date().toISOString(),
        inputHash,
        f.parent.id,
        f.child.id,
      )
  commitBetweenCheckAndInsert(
    f.db,
    'FROM vendor_settlements WHERE created_by=? AND idempotency_key=?',
    competitor(sha256(quote.preview_token)),
  )
  const body = { preview_token: quote.preview_token, idempotency_key: 'race-bill-key' }
  const statement = await createDownstreamSettlement(f.service, f.identity, body)
  assert.equal(statement.id, 'settlement_winner')
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM vendor_settlements').get().n, 1)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM vendor_settlement_allocations').get().n, 0)

  f.db.prepare('DELETE FROM vendor_settlements').run()
  commitBetweenCheckAndInsert(
    f.db,
    'FROM vendor_settlements WHERE created_by=? AND idempotency_key=?',
    competitor('another-preview'),
  )
  await assert.rejects(createDownstreamSettlement(f.service, f.identity, body), {
    code: 'idempotency_conflict',
  })
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM vendor_settlements').get().n, 0)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM vendor_settlement_allocations').get().n, 0)
})

test('R20 payment: a concurrent duplicate payment key is replayed instead of failing on the unique index', async (t) => {
  const f = await settlementFixture(t)
  const quote = await f.preview()
  const bill = await createDownstreamSettlement(f.service, f.identity, {
    preview_token: quote.preview_token,
    idempotency_key: 'race-payment-bill',
  })
  await mutateDownstreamSettlement(f.service, f.identity, bill.id, 'confirm')
  const body = { amount_usdt: bill.amount_usdt, reason: 'bank receipt', idempotency_key: 'race-payment-key' }
  const competitor = (reason) => () =>
    f.db
      .prepare(`INSERT INTO vendor_payments (id,settlement_id,idempotency_key,amount_usdt,action,reason,actor_user_id,created_at)
        VALUES ('payment_winner',?,'race-payment-key',?,'payment',?,?,?)`)
      .run(bill.id, bill.amount_usdt, reason, f.identity.user_id, new Date().toISOString())
  commitBetweenCheckAndInsert(f.db, 'FROM vendor_payments WHERE idempotency_key=?', competitor('bank receipt'))
  const replayed = await mutateDownstreamSettlement(f.service, f.identity, bill.id, 'payments', body)
  assert.equal(replayed.id, bill.id)
  assert.deepEqual(
    f.db
      .prepare('SELECT id FROM vendor_payments')
      .all()
      .map((r) => r.id),
    ['payment_winner'],
  )
  // 重放不再改状态、不记付款审计：状态仍是确认后的 confirmed
  assert.equal(f.db.prepare('SELECT status FROM vendor_settlements WHERE id=?').get(bill.id).status, 'confirmed')
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM vendor_audit_events WHERE action='settlement.payments'").get().n, 0)

  f.db.prepare('DELETE FROM vendor_payments').run()
  commitBetweenCheckAndInsert(f.db, 'FROM vendor_payments WHERE idempotency_key=?', competitor('other receipt'))
  await assert.rejects(mutateDownstreamSettlement(f.service, f.identity, bill.id, 'payments', body), {
    code: 'idempotency_conflict',
  })
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM vendor_payments').get().n, 0)
})

// R6 B8：使用记录落库 UsageLogsRepo.insertSummary 改为在同一 async 事务里 await recordVendorUsage，同步出口已删除
test('insertSummary writes the same supplier fact as recordVendorUsage (VM and Gateway rows)', async (t) => {
  const f = await settlementFixture(t)
  const vmId = f.pair.vm.config.runtime_vm_id
  const insertLog = (id, extra = {}) => {
    const row = {
      id,
      request_id: id,
      vm_id: vmId,
      created_at: '2026-10-01T11:00:00.000Z',
      status: 200,
      model: 'gpt-5',
      total_cost: 3,
      input_tokens: 7,
      output_tokens: 5,
      ...extra,
    }
    f.db
      .prepare(
        'INSERT INTO usage_logs(id,request_id,vm_id,created_at,status,model,total_cost,input_tokens,output_tokens,execution_kind,account_resource_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        row.id,
        row.request_id,
        row.vm_id,
        row.created_at,
        row.status,
        row.model,
        row.total_cost,
        row.input_tokens,
        row.output_tokens,
        row.execution_kind || null,
        row.account_resource_id || null,
      )
    return f.db.prepare('SELECT * FROM usage_logs WHERE id=?').get(id)
  }
  const repo = new UsageLogsRepo(f.db)
  const viaRepo = async (id, extra = {}) =>
    repo.insertSummary({
      id,
      request_id: id,
      vm_id: vmId,
      created_at: '2026-10-01T11:00:00.000Z',
      status: 200,
      model: 'gpt-5',
      total_cost: 3,
      input_tokens: 7,
      output_tokens: 5,
      ...extra,
    })
  const fact = (requestId) => {
    // 缓存列：insertSummary 的 toRow 把缺省的 cache_read_tokens 记为 0，直接插入的夹具行为 NULL，不比较
    const { id, created_at, source_request_id, cache_read_tokens, cache_creation_tokens, ...rest } = f.db
      .prepare('SELECT * FROM vendor_usage_facts WHERE source_request_id=?')
      .get(requestId)
    return rest
  }
  await recordVendorUsage(f.db, insertLog('vm-async'))
  await viaRepo('vm-sync')
  assert.deepEqual(fact('vm-sync'), fact('vm-async'))
  const gateway = { vm_id: null, execution_kind: 'gateway_worker', account_resource_id: f.pair.account.id }
  await recordVendorUsage(f.db, insertLog('gw-async', gateway))
  await viaRepo('gw-sync', gateway)
  assert.deepEqual(fact('gw-sync'), fact('gw-async'))
  // 未定价、失败与无归属的记录两个版本都不写
  for (const [id, extra] of [
    ['unpriced', { total_cost: null }],
    ['failed', { status: 500 }],
    ['orphan', { vm_id: 'no-such-vm' }],
  ]) {
    await recordVendorUsage(f.db, insertLog(`${id}-async`, extra))
    await viaRepo(`${id}-sync`, extra)
  }
  assert.equal(
    f.db
      .prepare(
        "SELECT COUNT(*) n FROM vendor_usage_facts WHERE source_request_id LIKE '%-async' OR source_request_id LIKE '%-sync'",
      )
      .get().n,
    4,
  )
  for (const name of ['recordVendorUsageSync']) assert.equal(vendorUsage[name], undefined, name)
  for (const name of ['gatewayAccountResourceSync', 'vmAccountResourceSync', 'insertUsageFactSync'])
    assert.equal(usageRepo[name], undefined, name)
})

test('resolveVendorAccountName names a supplier account once; B7c removed its sync exits', async (t) => {
  const { resolveVendorAccountName } = accountName
  const f = await settlementFixture(t)
  const identity = f.identity
  const pair = await f.service.createAccount(identity, { platform: 'openai' })
  f.db
    .prepare('UPDATE vendor_resources SET config_json=? WHERE id=?')
    .run(JSON.stringify({ ...pair.vm.config, runtime_vm_id: 'vm-name-sync' }), pair.vm.id)
  const vm = { id: 'vm-name-sync', vendor_account_resource_id: pair.account.id }
  const s = { pair }
  assert.equal(await resolveVendorAccountName(vm, null, f.db), false)
  assert.equal(await resolveVendorAccountName(vm, ' named@example.test ', f.db), true)
  const row = (id) => {
    const { name, config_json } = f.db.prepare('SELECT name,config_json FROM vendor_resources WHERE id=?').get(id)
    return { name, config: JSON.parse(config_json) }
  }
  assert.equal(row(s.pair.account.id).name, 'named@example.test')
  assert.equal(row(s.pair.account.id).config.name_from_authorization, undefined)
  assert.equal(await resolveVendorAccountName(vm, 'again@example.test', f.db), false)
  // R6 B7c 删除的临时出口：凭据写回 persistOauthToVm 改 await resolveVendorAccountName，
  // VM 摘要与 Codex 槽位闸门改 await vendorRuntimeBlock
  assert.equal(accountName.resolveVendorAccountNameSync, undefined)
  for (const name of [
    'findAuthorizationNamedAccountSync',
    'setResourceNameConfigStampedSync',
    'getVendorVmResourceSync',
  ])
    assert.equal(resources[name], undefined, name)
  // B7a 删除的临时出口：请求日志 RequestLogStore.finish 已改 async，改用 findSupplierRuntimeVm
  assert.equal(resources.findSupplierRuntimeVmSync, undefined)
  assert.ok(await resources.findSupplierRuntimeVm(f.db, 'vm-name-sync'))
  assert.equal(await resources.findSupplierRuntimeVm(f.db, 'unknown-vm'), undefined)
  assert.equal((await resources.getVendorVmResource(f.db, s.pair.vm.id, f.parent.id))?.id, s.pair.vm.id)
  // B5 删除的临时出口：Gateway 账号管理已改 async，这两个同步版本不再存在
  assert.equal(resources.getResourceSecretJsonSync, undefined)
  assert.equal(resources.updateResourceConfigStampedSync, undefined)
  const stamp = '2026-11-01T00:00:00.000Z'
  assert.equal((await resources.updateResourceConfigStamped(f.db, '{"k":1}', stamp, s.pair.account.id)).changes, 1)
  assert.equal(row(s.pair.account.id).config.k, 1)
})
