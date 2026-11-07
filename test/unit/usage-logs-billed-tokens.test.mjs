// 119：usage_logs 主 token 列是客户计费口径，上游原始消耗只在两者不同时存 upstream_*。
// 展示 / 统计读主列；账号成本汇总、成本重算、槽位统计读上游口径。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { applyMigrations, createDatabase } from '../../src/lib/db/database.mjs'
import { UsageLogsRepo } from '../../src/lib/db/repos/usage-logs-repo.mjs'
import { applyBilledTokens } from '../../src/lib/admin/request-log.mjs'
import { customerUsage } from '../../src/lib/protocol/customer-usage.mjs'
import { projectUsage } from '../../src/lib/usage/public-usage-projection.mjs'

const RAW = {
  input_tokens: 670,
  output_tokens: 4,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 2833,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 2833 },
  cache_ttl: '1h',
}

function tmpDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function rowSummary(overrides = {}) {
  return {
    id: 'log_1',
    request_id: 'req-1',
    ts: '2026-11-06T03:00:00.000Z',
    model: 'claude-sonnet-5-5',
    upstream_model: 'claude-sonnet-5-5',
    protocol: 'anthropic.messages',
    status: 200,
    api_key_id: 'key-1',
    user_id: 'user-1',
    vm_id: 'vm-1',
    account_id: 'acc-1',
    pricing_model: 'claude-sonnet-5-5',
    input_tokens: 670,
    output_tokens: 4,
    cache_read_tokens: 0,
    cache_creation_tokens: 2833,
    cache_creation_5m_tokens: null,
    cache_creation_1h_tokens: 2833,
    input_cost: 0.00134,
    output_cost: 0.00004,
    cache_read_cost: 0,
    cache_creation_cost: 0.011332,
    total_cost: 0.012712,
    actual_cost: 0.006,
    rate_multiplier: 1,
    ...overrides,
  }
}

test('applyBilledTokens writes the billed basis to the main columns and keeps raw in upstream_*', () => {
  // 客户没写 cache_control：缓存写入按普通 input 计；网关注入 450 token 不计费
  const billed = customerUsage(RAW, { injectedTokens: 450, cacheIntent: 'none', callerTokens: 50 })
  const summary = applyBilledTokens(rowSummary(), billed)
  assert.equal(summary.input_tokens, 670 + 2833 - 450)
  assert.equal(summary.cache_creation_tokens, 0)
  assert.equal(summary.cache_creation_1h_tokens, null)
  assert.equal(summary.output_tokens, 4)
  assert.equal(summary.upstream_input_tokens, 670)
  assert.equal(summary.upstream_cache_creation_tokens, 2833)
  assert.equal(summary.upstream_cache_creation_1h_tokens, 2833)

  // 两种口径相同（Codex、无注入且缓存意图一致）时不写 upstream_*
  const same = applyBilledTokens(rowSummary(), RAW)
  assert.equal(same.input_tokens, 670)
  assert.equal(same.upstream_input_tokens, undefined)
})

test('billed rows feed display stats on the billed basis and account cost on the upstream basis', async (t) => {
  const db = createDatabase({ dataDir: tmpDir(t, 'billed-tokens-') })
  t.after(() => db.close())
  const repo = new UsageLogsRepo(db)
  const billed = customerUsage(RAW, { injectedTokens: 450, cacheIntent: 'none', callerTokens: 50 })
  await repo.insertSummaryIfAbsent(applyBilledTokens(rowSummary(), billed))

  const stats = db.prepare('SELECT SUM(input_tokens) i, SUM(cache_creation_tokens) cc FROM usage_stats_hourly').get()
  assert.deepEqual({ ...stats }, { i: 3053, cc: 0 })
  const cost = db.prepare('SELECT SUM(input_tokens) i, SUM(cache_creation_tokens) cc FROM usage_cost_hourly').get()
  assert.deepEqual({ ...cost }, { i: 670, cc: 2833 })

  const slot = await repo.costBetween({ since: '2026-11-06T00:00:00Z', until: '2026-11-07T00:00:00Z', vmId: 'vm-1' })
  assert.equal(slot.input_tokens, 670)
  assert.equal(slot.cache_creation_tokens, 2833)
  const vmDays = (await repo.vmUsageStats({ vmId: 'vm-1', days: 90 })).history
  assert.equal(
    vmDays.reduce((sum, d) => sum + d.input_tokens, 0),
    670,
  )
  const keyDays = (await repo.keyUsageStats({ apiKeyId: 'key-1', days: 90 })).history
  assert.equal(
    keyDays.reduce((sum, d) => sum + d.input_tokens, 0),
    3053,
  )

  // 成本重算只读上游口径：重算后成本列不变
  const before = db.prepare('SELECT total_cost, input_cost, cache_creation_cost FROM usage_logs').get()
  await repo.repriceRange({ since: '2026-11-06T00:00:00Z', until: '2026-11-07T00:00:00Z' })
  const after = db.prepare('SELECT total_cost, input_cost, cache_creation_cost FROM usage_logs').get()
  assert.deepEqual({ ...after }, { ...before })
})

test('119 backfills billed tokens from billing_charges without moving the account cost rollup', (t) => {
  const dir = tmpDir(t, 'billed-119-')
  const migrationsDir = path.resolve('src/lib/db/migrations')
  const oldDir = path.join(dir, 'before-119')
  fs.mkdirSync(oldDir)
  for (const file of fs.readdirSync(migrationsDir))
    if (file < '119') fs.copyFileSync(path.join(migrationsDir, file), path.join(oldDir, file))
  const db = new DatabaseSync(path.join(dir, 'upgrade.db'))
  t.after(() => db.close())
  applyMigrations(db, { migrationsDir: oldDir })
  const insert =
    db.prepare(`INSERT INTO usage_logs (id, request_id, created_at, model, upstream_model, protocol, status,
      user_id, api_key_id, vm_id, account_id, pricing_model, input_tokens, output_tokens, cache_read_tokens,
      cache_creation_tokens, cache_creation_5m_tokens, cache_creation_1h_tokens, total_cost, actual_cost)
    VALUES (?, ?, ?, 'claude-sonnet-5-5', 'claude-sonnet-5-5', ?, 200, 'u1', 'k1', 'vm-1', 'acc-1',
      'claude-sonnet-5-5', ?, 10, ?, ?, ?, ?, 0.01, 0.005)`)
  const charge = db.prepare(`INSERT INTO billing_charges (request_id, user_id, api_key_id, group_id, rate_multiplier,
      actual_micros, model, usage_json, created_at, settlement_source) VALUES (?, 'u1', 'k1', 1, 1, 5000, 'm', ?, ?, ?)`)
  const at = '2026-11-06T03:00:00.000Z'
  // 1) 注入扣减 + 未写 ttl 的缓存写入按 5m 计：应回填
  insert.run('a', 'a', at, 'anthropic.messages', 56, 395679, 2732, 0, 2732)
  charge.run(
    'a',
    JSON.stringify({
      input_tokens: 56,
      output_tokens: 10,
      cache_read_input_tokens: 393113,
      cache_creation_input_tokens: 2732,
      cache_creation: { ephemeral_5m_input_tokens: 2732, ephemeral_1h_input_tokens: 0 },
    }),
    at,
    null,
  )
  // 2) 两种口径相同：不改
  insert.run('b', 'b', at, 'anthropic.messages', 9, 0, 0, 0, 0)
  charge.run('b', JSON.stringify({ input_tokens: 9, output_tokens: 10 }), at, null)
  // 3) OpenAI 包含式（Codex 回执）：不改
  insert.run('c', 'c', at, 'openai.responses', 100, 0, 0, 0, 0)
  charge.run('c', JSON.stringify({ input_tokens: 500, input_tokens_details: { cached_tokens: 400 } }), at, null)
  // 4) 客户口径上线前的记录：不改
  const old = '2026-11-05T10:00:00.000Z'
  insert.run('d', 'd', old, 'anthropic.messages', 700, 0, 0, 0, 0)
  charge.run('d', JSON.stringify({ input_tokens: 250, output_tokens: 10 }), old, null)

  const costBefore = db.prepare('SELECT * FROM usage_cost_hourly ORDER BY hour, account_key').all()
  applyMigrations(db, { migrationsDir })
  const row = (id) => db.prepare('SELECT * FROM usage_logs WHERE id = ?').get(id)
  const a = row('a')
  assert.deepEqual(
    [
      a.input_tokens,
      a.cache_read_tokens,
      a.cache_creation_tokens,
      a.cache_creation_5m_tokens,
      a.cache_creation_1h_tokens,
    ],
    [56, 393113, 2732, 2732, 0],
  )
  assert.deepEqual(
    [a.upstream_input_tokens, a.upstream_cache_read_tokens, a.upstream_cache_creation_1h_tokens],
    [56, 395679, 2732],
  )
  for (const id of ['b', 'c', 'd']) assert.equal(row(id).upstream_input_tokens, null, id)
  assert.equal(row('c').input_tokens, 100)
  assert.equal(row('d').input_tokens, 700)

  // 账号成本汇总保持上游口径；统计汇总跟随主列
  // 127（M6）给汇总表加了整数金额列：只比较 119 之前就有的列
  const costAfter = db
    .prepare('SELECT * FROM usage_cost_hourly ORDER BY hour, account_key')
    .all()
    .map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !k.endsWith('_micros'))))
  assert.deepEqual(
    costAfter,
    costBefore.map((r) => ({ ...r })),
  )
  const stats = db
    .prepare("SELECT SUM(cache_read_tokens) cr FROM usage_stats_hourly WHERE hour = '2026-11-06T03'")
    .get()
  assert.equal(stats.cr, 393113)

  // 新的成本汇总触发器按上游口径计入新行
  db.prepare(`INSERT INTO usage_logs (id, request_id, created_at, model, status, vm_id, account_id, input_tokens,
      upstream_input_tokens, output_tokens, total_cost) VALUES ('e', 'e', ?, 'm', 200, 'vm-2', 'acc-2', 5, 500, 1, 0)`).run(
    at,
  )
  const added = db.prepare("SELECT input_tokens FROM usage_cost_hourly WHERE account_key = 'acc-2'").get()
  assert.equal(added.input_tokens, 500)
})

test('upstream token columns stay private to super admins', () => {
  const row = { input_tokens: 3053, upstream_input_tokens: 670, upstream_cache_creation_tokens: 2833 }
  assert.equal(projectUsage(row, 'user').upstream_input_tokens, undefined)
  assert.equal(projectUsage(row, 'admin').upstream_cache_creation_tokens, undefined)
  assert.equal(projectUsage(row, 'super_admin').upstream_input_tokens, 670)
})
