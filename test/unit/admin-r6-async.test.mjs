// 数据访问分层 R6 B6b：管理面异步化后的竞态修复（R1–R3、R18）与临时同步出口一致性
import test from 'node:test'
import assert from 'node:assert/strict'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { PanelUserStore } from '../../src/lib/admin/panel-users.mjs'
import { RelayBilling } from '../../src/lib/admin/relay-billing.mjs'
import { GroupsRepo } from '../../src/lib/db/repos/groups-repo.mjs'
import { UsersRepo } from '../../src/lib/db/repos/users-repo.mjs'
import { SettingsRepo } from '../../src/lib/db/repos/settings-repo.mjs'
import { ApiEndpointStore } from '../../src/lib/admin/api-endpoints.mjs'
import { bumpGroupVersion } from '../../src/lib/admin/repos/relay-repo.mjs'
import { dbTime } from '../../src/shared/system-time.mjs'

async function setup(t) {
  const db = createDatabase({ dbPath: ':memory:' })
  t.after(() => db.close())
  const users = new PanelUserStore({ db })
  const add = (name, role, parent) =>
    users.create({ username: name, password: 'testing-pass', role, actorId: parent?.id })
  const sa = await add('super', 'super_admin')
  const admin = await add('admin-a', 'admin', sa)
  const user = await add('customer', 'user', admin)
  const own = await add('own-customer', 'user', sa)
  const billing = new RelayBilling(db)
  const groups = new GroupsRepo(db)
  return { db, users, sa, admin, user, own, billing, groups }
}

const micros = (db, id) => db.prepare('SELECT balance_micros FROM users WHERE id=?').get(id).balance_micros
const domainMicros = (db, id) =>
  db.prepare('SELECT balance_micros FROM admin_domains WHERE id=?').get(id).balance_micros
const ledgerCount = (db, key) => db.prepare('SELECT COUNT(*) n FROM wallet_ledger WHERE idempotency_key=?').get(key).n

/** 在第 nth 次调用 billing.balance 读完余额之后、扣款写入之前插入一次竞争写入。 */
function competeAfterBalance(billing, compete, nth = 1) {
  const original = billing.balance.bind(billing)
  let calls = 0
  billing.balance = async (userId) => {
    const out = await original(userId)
    if (++calls === nth) compete(userId)
    return out
  }
}

test('R1: a competing debit between the balance check and the write cannot overdraw the wallet', async (t) => {
  const { db, billing, own } = await setup(t)
  await billing.adjust(own.id, { amount: 5, idempotency_key: 'credit-0001' }, 'super')
  // 另一请求在本次读完余额后扣光余额
  competeAfterBalance(billing, (id) => db.prepare('UPDATE users SET balance_micros=0,balance=0 WHERE id=?').run(id))
  await assert.rejects(
    billing.adjust(own.id, { amount: 3, operation: 'subtract', idempotency_key: 'debit-0001' }, 'super'),
    { code: 'insufficient_balance' },
  )
  // 单连接上，模拟的竞争写入落在本事务里，随本次失败一起回滚；关键是条件扣款没有让余额变负
  assert.ok(micros(db, own.id) >= 0, '余额不为负')
  assert.equal(ledgerCount(db, 'debit-0001'), 0, '失败的扣款不留流水')
})

test('R1: a concurrent request committing the same idempotency key returns duplicate instead of UNIQUE', async (t) => {
  const { db, billing, own } = await setup(t)
  competeAfterBalance(billing, (id) => {
    // 另一请求已用同一幂等键完成同一笔充值
    db.prepare('UPDATE users SET balance_micros=balance_micros+2000000,balance=balance+2 WHERE id=?').run(id)
    db.prepare(
      "INSERT INTO wallet_ledger(id,user_id,kind,amount_micros,balance_after_micros,idempotency_key,actor,reason,created_at) VALUES('other',?,'adjustment',2000000,2000000,'credit-race1','super','',?)",
    ).run(id, new Date().toISOString())
  })
  const out = await billing.adjust(own.id, { amount: 2, idempotency_key: 'credit-race1' }, 'super')
  assert.equal(out.duplicate, true)
  assert.equal(out.transaction.id, 'other')
  assert.equal(micros(db, own.id), 2000000, '只入账一次')
  assert.equal(ledgerCount(db, 'credit-race1'), 1)
})

test('R1: concurrent identical adjustments settle once and the replay keeps conflict detection', async (t) => {
  const { db, billing, own } = await setup(t)
  const input = { amount: 1, idempotency_key: 'credit-twice' }
  const results = await Promise.all([billing.adjust(own.id, input, 'super'), billing.adjust(own.id, input, 'super')])
  assert.deepEqual(results.map((r) => r.duplicate).sort(), [false, true])
  assert.equal(micros(db, own.id), 1000000)
  await assert.rejects(billing.adjust(own.id, { amount: 2, idempotency_key: 'credit-twice' }, 'super'), {
    code: 'idempotency_conflict',
  })
})

test('R2: a competing debit of the source wallet makes the transfer fail without moving funds', async (t) => {
  const { db, billing, admin, user } = await setup(t)
  await billing.adjust(admin.id, { amount: 5, idempotency_key: 'fund-admin1' }, 'super')
  const domainId = (await new UsersRepo(db).getById(admin.id)).admin_domain_id
  competeAfterBalance(billing, () =>
    db.prepare('UPDATE admin_domains SET balance_micros=1000000 WHERE id=?').run(domainId),
  )
  await assert.rejects(
    billing.transfer(admin.id, user.id, { amount: 2, idempotency_key: 'transfer-race' }, 'admin-a'),
    { code: 'insufficient_balance' },
  )
  assert.ok(domainMicros(db, domainId) >= 0)
  assert.equal(micros(db, user.id), 0)
  assert.equal(db.prepare("SELECT COUNT(*) n FROM wallet_ledger WHERE kind='transfer'").get().n, 0)
})

test('R2: concurrent identical transfers move funds once', async (t) => {
  const { db, billing, admin, user } = await setup(t)
  await billing.adjust(admin.id, { amount: 5, idempotency_key: 'fund-admin2' }, 'super')
  const domainId = (await new UsersRepo(db).getById(admin.id)).admin_domain_id
  const input = { amount: 2, idempotency_key: 'transfer-twice' }
  const results = await Promise.all([
    billing.transfer(admin.id, user.id, input, 'admin-a'),
    billing.transfer(admin.id, user.id, input, 'admin-a'),
  ])
  assert.deepEqual(results.map((r) => r.duplicate).sort(), [false, true])
  assert.equal(domainMicros(db, domainId), 3000000)
  assert.equal(micros(db, user.id), 2000000)
})

test('R3: a reversal raced by another reversal of the same entry applies once', async (t) => {
  const { db, billing, own } = await setup(t)
  const credit = await billing.adjust(own.id, { amount: 4, idempotency_key: 'credit-rev1' }, 'super')
  const originalId = credit.transaction.id
  // adjust 读完余额后，另一冲正已提交（同一 reversal:<id> 幂等键）
  competeAfterBalance(billing, (id) => {
    db.prepare('UPDATE users SET balance_micros=balance_micros-4000000,balance=balance-4 WHERE id=?').run(id)
    db.prepare(
      "INSERT INTO wallet_ledger(id,user_id,kind,amount_micros,balance_after_micros,idempotency_key,actor,reason,created_at) VALUES('rev-other',?,'reversal',-4000000,0,?,'super','dup',?)",
    ).run(id, 'reversal:' + originalId, new Date().toISOString())
  })
  const out = await billing.reverse(originalId, { reason: 'mistake' }, 'super')
  assert.equal(out.duplicate, true)
  assert.equal(out.transaction.id, 'rev-other')
  assert.equal(micros(db, own.id), 0)
  assert.equal(ledgerCount(db, 'reversal:' + originalId), 1)
})

test('R3: concurrent reversals of the same entry reverse once', async (t) => {
  const { db, billing, own } = await setup(t)
  const credit = await billing.adjust(own.id, { amount: 4, idempotency_key: 'credit-rev2' }, 'super')
  const results = await Promise.all([
    billing.reverse(credit.transaction.id, { reason: 'a' }, 'super'),
    billing.reverse(credit.transaction.id, { reason: 'b' }, 'super'),
  ])
  assert.deepEqual(results.map((r) => r.duplicate).sort(), [false, true])
  assert.equal(micros(db, own.id), 0)
  const reversal = results.find((r) => !r.duplicate).transaction
  assert.deepEqual(
    JSON.parse(db.prepare('SELECT metadata_json FROM wallet_ledger WHERE id=?').get(reversal.id).metadata_json),
    {
      reverses: credit.transaction.id,
      request_id: null,
    },
  )
})

test('R18: a membership change between the version read and the write is rejected and rolled back', async (t) => {
  const { db, groups } = await setup(t)
  const a = await groups.create({ name: 'a' })
  const b = await groups.create({ name: 'b' })
  await groups.assignResource('api_endpoint', 'ep-1', [a.id], 0)
  const read = groups.resourceVersion.bind(groups)
  groups.resourceVersion = async (kind, id) => {
    const version = await read(kind, id)
    // 另一管理员在本次读完版本后改了这个资源的分组
    db.prepare('UPDATE resource_group_versions SET version=version+1 WHERE resource_kind=? AND resource_id=?').run(
      kind,
      id,
    )
    return version
  }
  await assert.rejects(groups.assignResource('api_endpoint', 'ep-1', [b.id], 1), { code: 'version_conflict' })
  delete groups.resourceVersion
  assert.deepEqual(
    (await groups.forResource('api_endpoint', 'ep-1')).map((g) => g.id),
    [a.id],
    '关系集回滚',
  )
  // 单连接上，模拟的竞争写入落在本事务里，随 version_conflict 一起回滚
  assert.equal(await groups.resourceVersion('api_endpoint', 'ep-1'), 1)
})

test('R18: group resource replacement bumps the group version only from the version it read', async (t) => {
  const { db, groups } = await setup(t)
  const g = await groups.create({ name: 'g' })
  const stamp = new Date().toISOString()
  assert.equal((await bumpGroupVersion(db, stamp, g.id, g.version)).changes, 1)
  assert.equal((await bumpGroupVersion(db, stamp, g.id, g.version)).changes, 0, '已被并发修改的版本不再递增')
  assert.equal((await groups.getById(g.id)).version, g.version + 1)
})

test('sync exits: B7c removed the user and group ones; B8 removed the settings ones', async (t) => {
  const { db, groups, admin, user, billing } = await setup(t)
  const usersRepo = new UsersRepo(db)
  const g = await groups.create({ name: 'sync-check', platform: 'anthropic', rate_multiplier: 2 })
  await groups.assignResource('vm', 'vm-1', [g.id], 0)
  // R6 B7c 删除：Key 作用域与 VM 摘要改 async（keyScopeFromRequest、summarizeVm / listVms）
  assert.equal(usersRepo.getByIdSync, undefined)
  for (const name of [
    'getByIdSync',
    'resourcesSync',
    'forResourceSync',
    'resourceVersionSync',
    'overrideSync',
    'accessSync',
  ])
    assert.equal(groups[name], undefined, name)
  // 摘要批量读取与逐个读取一致
  assert.deepEqual((await groups.forResourceKind('vm')).get('vm-1'), await groups.forResource('vm', 'vm-1'))
  assert.equal((await groups.resourceVersionsOfKind('vm')).get('vm-1'), await groups.resourceVersion('vm', 'vm-1'))
  // 失败时抛错
  const userRec = await usersRepo.getById(user.id)
  await assert.rejects(groups.access(userRec, 999), { code: 'group_unavailable' })
  assert.ok(admin.id)
  // B7a 删除的出口：钱包与套餐窗口、面板按用户名查用户（准入、结算、requireAuth 已改 async）
  for (const name of ['walletSync', 'walletAmountSync', 'changeWalletSync', 'subscriptionWindowsSync'])
    assert.equal(billing[name], undefined, name)
  assert.equal(usersRepo.getByUsernameSync, undefined)
  // 设置写入：R6 B8 删除了同步出口 setSync / removeSync，只剩 async 写入
  const settings = new SettingsRepo(db)
  assert.equal(settings.setSync, undefined)
  assert.equal(settings.removeSync, undefined)
  await settings.set('sync-b', { v: 1 })
  assert.deepEqual(settings.get('sync-b'), { v: 1 })
  await settings.remove('sync-b')
  assert.equal(settings.has('sync-b'), false)
})

test('API endpoint sync exits are gone; the async store cools keys', async (t) => {
  const db = createDatabase({ dbPath: ':memory:' })
  t.after(() => db.close())
  const store = new ApiEndpointStore({ db })
  const ep = await store.create({
    name: 'ep',
    base_url: 'https://example.com',
    api_key_entries: [{ api_key: 'sk-test-0001' }],
    models: [{ name: 'm', alias: 'm' }],
  })
  // B7a 删除的出口：API 端点调度器重载与 Key 冷却已改 async
  assert.equal(store.listRawSync, undefined)
  assert.equal(store.setKeyCooldownSync, undefined)
  assert.equal(store.repo.listHydratedSync, undefined)
  assert.equal(store.repo.hydrateSync, undefined)
  assert.equal(store.repo.setKeyCooldownSync, undefined)
  const until = dbTime(Date.now() + 60_000)
  await store.setKeyCooldown(ep.api_key_entries[0].id, until)
  assert.equal((await store.listRaw())[0].api_key_entries[0].cooldown_until, until)
  await store.setKeyCooldown(ep.api_key_entries[0].id, null)
  assert.equal((await store.listRaw())[0].api_key_entries[0].cooldown_until, null)
})
