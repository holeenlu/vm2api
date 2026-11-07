import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { GroupsRepo } from '../../src/lib/db/repos/groups-repo.mjs'
import { PanelUserStore } from '../../src/lib/admin/panel-users.mjs'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
import { assertPriced } from '../../src/lib/admin/relay-billing.mjs'
import { pickCodexCandidates } from '../../src/lib/protocol/handle-codex.mjs'
import { admissionBody, applyCodexFastPolicy, planCodexRequest } from '../../src/lib/protocol/codex-request-plan.mjs'

// 审计阶段 2 W12：Codex 请求计划消除 VM 与 Gateway 两条路径的口径漂移

test('the VM fast policy follows the Worker applyFastPolicy rules', () => {
  const cases = [
    // [mode, supportsPriority, service_tier, expected]
    ['disabled', true, 'priority', 'default'],
    ['disabled', true, 'fast', 'default'],
    ['disabled', true, 'flex', 'flex'],
    ['disabled', true, undefined, undefined],
    ['enabled', true, undefined, 'priority'],
    ['enabled', true, null, 'priority'],
    ['enabled', true, 'default', 'priority'],
    ['enabled', true, 'flex', 'flex'],
    ['enabled', true, '', ''],
    ['enabled', false, undefined, undefined],
    ['default', true, undefined, undefined],
    ['default', true, 'priority', 'priority'],
  ]
  for (const [mode, supports, tier, expected] of cases) {
    const body = { model: 'gpt-x', ...(tier === undefined ? {} : { service_tier: tier }) }
    const out = applyCodexFastPolicy(body, mode, supports)
    assert.equal(out.service_tier, expected, `${mode}/${supports}/${tier}`)
    if (expected === tier) assert.equal(out, body, 'unchanged bodies are returned as is')
  }
})

test('admission prices the tier the group fast policy will actually send', () => {
  const quote = { platform: 'openai', price: { input: 1, output: 1, modes: {} } }
  const body = { model: 'gpt-x', service_tier: 'priority' }
  assert.throws(() => assertPriced(quote, 'gpt-x', body), { code: 'service_tier_unpriced' })
  // 分组关闭 Fast：priority 会被降为 default 发出，准入不再以未定价档位拒绝
  assert.doesNotThrow(() => assertPriced(quote, 'gpt-x', admissionBody(body, 'disabled')))
  assert.equal(admissionBody(body, 'enabled'), body)
  assert.equal(admissionBody(body, 'default'), body)
})

test('the request plan keeps the client model for the allowlist and normalizes the fast mode', () => {
  const plan = planCodexRequest({
    body: { model: 'gpt-upstream', input: [] },
    clientModel: 'gpt-public',
    fastMode: 'odd',
  })
  assert.equal(plan.allowlistModel, 'gpt-public')
  assert.equal(plan.fastMode, 'default')
  assert.equal(plan.compaction, null)
  assert.equal(planCodexRequest({ body: { model: 'gpt-upstream' } }).allowlistModel, 'gpt-upstream')
})

test('VM admission checks the group allowlist against the client model, not the mapped upstream model', async (t) => {
  const db = openDatabase({ dbPath: ':memory:' })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-plan-'))
  t.after(async () => {
    await closeDatabase()
    fs.rmSync(root, { recursive: true, force: true })
  })
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  const groups = new GroupsRepo(db)
  const user = await new PanelUserStore({ db }).create({ username: 'gpt-plan', password: 'testpass' })
  const group = await groups.create({
    name: 'gpt-plan',
    platform: 'openai',
    rate_multiplier: 0,
    models: ['gpt-public'],
  })
  await groups.setGrants(user.id, [group.id])
  const key = await new ApiKeyStore({ db }).create({ user_id: user.id, group_id: group.id })
  const req = { headers: {}, apiKeyKind: 'managed', apiKeyRecord: key, socket: { remoteAddress: '127.0.0.1' } }
  const mapped = { model: 'gpt-upstream', input: [] }
  // 未带请求计划时按映射后的上游模型判断：误判为分组无权调用（W12 之前 VM 复核的行为）
  assert.equal((await pickCodexCandidates(root, req, { body: mapped })).error, 'group_unavailable')
  const picked = await pickCodexCandidates(root, req, { body: mapped, allowlistModel: 'gpt-public' })
  assert.notEqual(picked.error, 'group_unavailable')
  assert.equal(
    (await pickCodexCandidates(root, req, { body: mapped, allowlistModel: 'gpt-other' })).error,
    'group_unavailable',
  )
})
