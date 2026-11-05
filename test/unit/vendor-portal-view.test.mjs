import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { GroupsRepo } from '../../src/lib/db/repos/groups-repo.mjs'
import { VendorPlatform } from '../../src/lib/vendor/vendor-platform.mjs'
import { accountPortalRows, normalizeAccountReason } from '../../src/lib/vendor/vendor-portal-view.mjs'
import { resolveVendorAccountName } from '../../src/lib/vendor/vendor-account-name.mjs'
import { supplierBilling } from '../../src/lib/vendor/vendor-settlements.mjs'
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supplier-view-'))
  const db = createDatabase({ dataDir: dir })
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const group = new GroupsRepo(db).create({ name: 'supplier-view', platform: 'mixed' })
  const platform = new VendorPlatform(db)
  const vendor = await platform.createRoot({
    actorUserId: 'sa',
    body: {
      username: 'vendor-a',
      password: 'vendor-test-123',
      groups: [String(group.id)],
      capabilities: ['vendor.vm.create', 'vendor.resource.manage', 'vendor.create_child', 'vendor.settlement.read'],
    },
  })
  return { platform, identity: { vendor, user_id: 'sa' } }
}
test('portal keeps unknown values null, excludes other accounts and omits raw credentials', async (t) => {
  const { platform, identity } = await fixture(t)
  const pair = await platform.createAccount(identity, { name: 'A', platform: 'anthropic' })
  platform.db
    .prepare('UPDATE vendor_resources SET config_json=? WHERE id=?')
    .run(JSON.stringify({ runtime_vm_id: 'vm-a' }), pair.vm.id)
  const resources = await platform.listResources(identity, 'account')
  let rows = await accountPortalRows(platform, resources, {
    readVm: () => ({ schedulable: false, summary: { has_token: false, status: 'stopped', token: 'secret' } }),
  })
  assert.equal(rows[0].telemetry.state, 'unauthorized')
  assert.equal(rows[0].telemetry.total_cost, 0)
  platform.db
    .prepare(
      "INSERT INTO usage_logs(id,request_id,vm_id,created_at,status,total_cost) VALUES ('usage-test','req-test','vm-a',?,200,2.5)",
    )
    .run(new Date(Date.now() - 1000).toISOString())
  rows = await accountPortalRows(platform, resources, {
    usageAccounts: [
      { vm_id: 'other', total_cost: 999 },
      { vm_id: 'vm-a', total_cost: 2.5, utilization_7d: 0.3, reset_7d: '2030-01-01T00:00:00Z', token: 'secret' },
    ],
    readVm: () => ({ schedulable: true, summary: { has_token: true, status: 'running' } }),
  })
  assert.equal(rows[0].telemetry.total_cost, 2.5)
  assert.equal(rows[0].telemetry.state, 'available')
  assert.equal(rows[0].telemetry.utilization_7d, 0.3)
  assert.equal(JSON.stringify(rows).includes('secret'), false)
})

test('portal exposes operator scheduling and credential status for the shared account state', async (t) => {
  const { platform, identity } = await fixture(t)
  const pair = await platform.createAccount(identity, { name: 'revoked', platform: 'anthropic' })
  platform.db
    .prepare('UPDATE vendor_resources SET config_json=? WHERE id=?')
    .run(JSON.stringify({ runtime_vm_id: 'vm-revoked' }), pair.vm.id)
  const rows = await accountPortalRows(platform, await platform.listResources(identity, 'account'), {
    readVm: () => ({
      schedulable: false,
      summary: {
        has_token: true,
        status: 'running',
        unschedulable: { reason: 'oauth_revoked' },
        refresh_error: 'oauth_revoked',
      },
    }),
  })
  assert.equal(rows[0].telemetry.state, 'error')
  assert.equal(rows[0].telemetry.schedulable, false)
  assert.equal(rows[0].telemetry.unschedulable_reason, 'oauth_revoked')
  assert.equal(rows[0].telemetry.credential_state, 'revoked')
})

test('portal reports quota and 429 restrictions as restricted, not as an account fault', async (t) => {
  const { platform, identity } = await fixture(t)
  const now = Date.parse('2026-11-03T00:00:00Z')
  const until = Date.parse('2026-11-04T07:37:38Z')
  for (const [reason, text, quota, expected = reason] of [
    ['quota_7d_header', '7d 限制'],
    ['rate_limited', '限流中'],
    // A 429 that spent the 7d window reads like the passive 7d restriction.
    ['account_quota_exhausted', '7d 限制', { status_7d: 'rejected' }, 'quota_7d_header'],
  ]) {
    const pair = await platform.createAccount(identity, { name: reason, platform: 'openai' })
    platform.db
      .prepare('UPDATE vendor_resources SET config_json=? WHERE id=?')
      .run(JSON.stringify({ runtime_vm_id: `vm-${reason}` }), pair.vm.id)
    const rows = await accountPortalRows(platform, [pair.account], {
      now,
      readVm: () => ({
        schedulable: true,
        summary: {
          platform: 'openai',
          has_token: true,
          status: 'running',
          schedulable: true,
          temp_unschedulable_until: until,
          temp_unschedulable_reason: reason,
          ...quota,
        },
      }),
    })
    const telemetry = rows[0].telemetry
    assert.equal(telemetry.state, 'cooling')
    assert.equal(telemetry.schedule_state, 'restricted')
    assert.equal(telemetry.restriction_reason, expected)
    assert.equal(telemetry.restriction_text, text)
    assert.equal(telemetry.cooldown_until, new Date(until).toISOString())
    assert.equal(telemetry.unschedulable_reason, null)
    assert.equal(telemetry.failure_category, null)
    assert.equal(telemetry.requires_authorization, false)
  }
})

test('portal normalizes upstream account blockers without exposing proxy credentials', async (t) => {
  const { platform, identity } = await fixture(t)
  const cases = [
    ['OAuth access token has been revoked.', 'oauth_revoked', 'revoked'],
    ['OAuth authentication is currently not allowed for this organization.', 'organization_disabled', 'blocked'],
    ['OAuth access token has expired. Re-authenticate to continue.', 'oauth_expired', 'expired'],
    [
      "We've updated our Consumer Terms and Privacy Policy. You'll need to accept them in claude.ai with the email in /status to continue.",
      'terms_not_accepted',
      'blocked',
    ],
    [
      "代理不可用：http://user:secret@example.test:7253 (no upstream response before the CLI's model validation deadline)",
      'proxy_unavailable',
      'valid',
    ],
  ]
  for (const [message, reason, credentialState] of cases) {
    assert.equal(normalizeAccountReason(message), reason)
    const pair = await platform.createAccount(identity, { name: reason, platform: 'anthropic' })
    platform.db
      .prepare('UPDATE vendor_resources SET config_json=? WHERE id=?')
      .run(JSON.stringify({ runtime_vm_id: `vm-${reason}` }), pair.vm.id)
    const rows = await accountPortalRows(platform, [pair.account], {
      readVm: () => ({
        schedulable: false,
        summary: {
          has_token: true,
          status: 'running',
          refresh_error: { code: 'upstream_error', message },
          unschedulable: { reason: 'upstream_error', detail: { message } },
        },
      }),
    })
    assert.equal(rows[0].telemetry.unschedulable_reason, reason)
    assert.equal(rows[0].telemetry.credential_state, credentialState)
    assert.equal(JSON.stringify(rows).includes('user:secret'), false)
  }
})
test('proxy credentials stay private and binding validates supplier ownership', async (t) => {
  const { platform, identity } = await fixture(t)
  const proxy = await platform.createProxy(identity, {
    name: 'exit',
    config: { endpoint: 'socks5://user:private@127.0.0.1:1080' },
  })
  assert.equal(JSON.stringify(proxy).includes('private'), false)
  let bound
  platform.vmProvisioner = ({ body }) => {
    bound = body.proxy
    return { id: 'vm-bound' }
  }
  await platform.createAccount(identity, { name: 'bound', proxy_id: proxy.id })
  assert.equal(bound.url, 'socks5h://user:private@127.0.0.1:1080')
  const other = await platform.createRoot({
    actorUserId: 'sa',
    body: { username: 'vendor-b', password: 'vendor-test-123' },
  })
  await assert.rejects(
    async () => platform.createAccount({ user_id: 'sa', vendor: other }, { name: 'bad', proxy_id: proxy.id }),
    (e) => e.code === 'vendor_scope_forbidden',
  )
  await assert.rejects(
    async () => platform.createProxy(identity, { name: 'bad', config: { endpoint: 'file:///tmp/test' } }),
    (e) => e.code === 'invalid_proxy',
  )
})
test('negative and fractional child limits rejected; zero remains stored', async (t) => {
  const { platform, identity } = await fixture(t)
  assert.equal(identity.vendor.child_limit, 0)
  for (const child_limit of [-1, 0.5, NaN])
    await assert.rejects(
      async () =>
        platform.createRoot({
          actorUserId: 'sa',
          body: { username: 'bad-vendor', password: 'vendor-test-123', child_limit },
        }),
      (e) => e.code === 'invalid_child_limit',
    )
})
test('statements require explicit settlement permission', async (t) => {
  const { platform, identity } = await fixture(t)
  assert.deepEqual((await supplierBilling(platform, identity)).upstream, [])
  platform.db
    .prepare("UPDATE vendor_capabilities SET enabled=0 WHERE vendor_id=? AND capability='vendor.settlement.read'")
    .run(identity.vendor.id)
  await assert.rejects(
    async () => supplierBilling(platform, identity),
    (e) => e.code === 'capability_required',
  )
})

test('account workbench reports recent throughput, Fable windows and scoped metadata', async (t) => {
  const { platform, identity } = await fixture(t)
  const proxy = await platform.createProxy(identity, {
    name: 'private exit',
    config: { endpoint: 'socks5://user:never-echo@127.0.0.1:1080' },
  })
  platform.vmProvisioner = () => ({ id: 'vm-metrics' })
  const pair = await platform.createAccount(identity, { name: 'metrics', proxy_id: proxy.id })
  const now = Date.now()
  for (const [id, vm, ago, cost, tokens, model] of [
    ['old', 'vm-metrics', 120000, 8, 9999, 'claude-fable-5'],
    ['new', 'vm-metrics', 1000, 2, 100, 'claude-fable-5'],
    ['outside', 'vm-other', 1000, 999, 50000, 'other'],
  ]) {
    platform.db
      .prepare(
        'INSERT INTO usage_logs(id,request_id,vm_id,created_at,status,model,total_cost,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens) VALUES (?,?,?,?,200,?,?,?,20,30,10)',
      )
      .run(id, id, vm, new Date(now - ago).toISOString(), model, cost, tokens)
  }
  const row = (
    await accountPortalRows(platform, [pair.account], {
      now,
      usageAccounts: [
        {
          vm_id: 'vm-metrics',
          total_cost: 10,
          today_cost: 10,
          utilization_7d_oi: 0.3,
          reset_7d_oi: '2030-01-01',
          usage_has_fable: true,
        },
      ],
      readVm: () => ({
        schedulable: true,
        summary: {
          has_token: true,
          status: 'running',
          platform: 'anthropic',
          account_tier: 'max',
          weight: 2,
          email: 'observed@example.test',
          rate_limit_tier: 'default_claude_max_20x',
          billing_type: 'apple_subscription',
          subscription_updated_at: '2026-10-31T00:00:00Z',
          can_refresh_profile: true,
          credential_mode: 'official-setup-token',
        },
      }),
    })
  )[0]
  assert.equal(row.config.auth_method, 'setup-token')
  assert.equal(row.telemetry.email, 'observed@example.test')
  assert.equal(row.telemetry.rate_limit_tier, 'default_claude_max_20x')
  assert.equal(row.telemetry.billing_type, 'apple_subscription')
  assert.equal(row.telemetry.subscription_updated_at, '2026-10-31T00:00:00Z')
  assert.equal(row.telemetry.can_refresh_profile, true)
  assert.equal(row.telemetry.requires_authorization, false)
  assert.equal(row.telemetry.rpm, 1)
  assert.equal(row.telemetry.tpm, 120)
  assert.equal(row.telemetry.tpm_with_cache, 160)
  assert.equal(row.telemetry.has_fable, true)
  assert.equal(row.telemetry.utilization_fable, 0.3)
  assert.equal(row.telemetry.fable_cost, 10)
  assert.equal(row.telemetry.priority, 2)
  assert.equal(row.proxy.name, 'private exit')
  assert.equal(JSON.stringify(row).includes('never-echo'), false)
})

test('subscription display uses observed tiers and never the scheduler default', async (t) => {
  const { platform, identity } = await fixture(t)
  const pair = await platform.createAccount(identity, { name: 'unknown plan', platform: 'anthropic' })
  platform.db
    .prepare('UPDATE vendor_resources SET config_json=? WHERE id=?')
    .run(JSON.stringify({ runtime_vm_id: 'vm-plan' }), pair.vm.id)
  const render = async (summary) =>
    (await accountPortalRows(platform, [pair.account], { readVm: () => ({ summary }) }))[0].telemetry
  assert.equal((await render({ account_tier: 'pro', account_tier_source: 'default' })).plan_type, null)
  assert.equal((await render({ account_tier: 'max', account_tier_source: 'usage' })).plan_type, null)
  assert.equal(
    (
      await render({
        account_tier: 'max',
        account_tier_source: 'usage',
        subscription_updated_at: '2026-10-31T00:00:00Z',
      })
    ).plan_type,
    null,
  )
  assert.equal((await render({ subscription_type: 'team' })).plan_type, 'team')
})

test('OpenAI unknown quota readings do not fall back to synthetic zero counters', async (t) => {
  const { platform, identity } = await fixture(t)
  platform.db.prepare("UPDATE groups SET platform='mixed' WHERE id=1").run()
  platform.vmProvisioner = () => ({ id: 'vm-codex-unknown' })
  const pair = await platform.createAccount(identity, { name: 'unknown', platform: 'openai' })
  const row = (
    await accountPortalRows(platform, [pair.account], {
      usageAccounts: [{ vm_id: 'vm-codex-unknown', utilization_5h: 0, utilization_7d: 0, total_tokens: 999999 }],
      readVm: () => ({
        summary: {
          platform: 'openai',
          has_token: false,
          account_tier: 'codex',
          utilization_5h: null,
          utilization_7d: null,
        },
      }),
    })
  )[0]
  assert.equal(row.telemetry.utilization_5h, null)
  assert.equal(row.telemetry.utilization_7d, null)
  assert.equal(row.telemetry.plan_type, null)
  assert.equal(row.telemetry.tpm, 0)
})

test('blank names resolve once from the bound authorization while explicit names and unrelated accounts stay intact', async (t) => {
  const { platform, identity } = await fixture(t)
  for (const input of ['', '  ', 'My subscription']) {
    const pair = await platform.createAccount(identity, { name: input, platform: 'anthropic' })
    platform.db
      .prepare('UPDATE vendor_resources SET config_json=? WHERE id=?')
      .run(JSON.stringify({ runtime_vm_id: 'vm-name' }), pair.vm.id)
    const vm = { id: 'vm-name', vendor_account_resource_id: pair.account.id }
    const read = async () => (await platform.listResources(identity, 'account')).find((r) => r.id === pair.account.id)
    await platform.updateResource(identity, pair.account.id, { name: pair.account.name, notes: 'Keep pending default' })
    assert.equal(await resolveVendorAccountName(vm, null, platform.db), false)
    assert.equal(await resolveVendorAccountName({ ...vm, id: 'unrelated' }, 'other@example.test', platform.db), false)
    assert.equal(
      await resolveVendorAccountName(vm, ' subscription@privaterelay.appleid.com ', platform.db),
      !input.trim(),
    )
    assert.equal((await read()).name, input.trim() || 'subscription@privaterelay.appleid.com')
    assert.equal((await read()).config.name_from_authorization, undefined)
    assert.equal(await resolveVendorAccountName(vm, 'changed@example.test', platform.db), false)
  }
  const pair = await platform.createAccount(identity, { platform: 'anthropic' })
  platform.db
    .prepare('UPDATE vendor_resources SET config_json=? WHERE id=?')
    .run(JSON.stringify({ runtime_vm_id: 'vm-renamed' }), pair.vm.id)
  await platform.updateResource(identity, pair.account.id, { name: 'Chosen before authorization' })
  assert.equal(
    await resolveVendorAccountName(
      { id: 'vm-renamed', vendor_account_resource_id: pair.account.id },
      'authorized@example.test',
      platform.db,
    ),
    false,
  )
  assert.equal(
    (await platform.listResources(identity, 'account')).find((r) => r.id === pair.account.id).name,
    'Chosen before authorization',
  )
})

test('supplier Gateway Worker accounts show quota windows, plan, email and limits like VM rows', async (t) => {
  const { platform, identity } = await fixture(t)
  const now = Date.parse('2026-11-03T12:00:00Z')
  const stamp = new Date(now).toISOString()
  platform.db
    .prepare(
      `INSERT INTO vendor_resources(id,vendor_id,resource_type,name,status,config_json,created_by,created_at,updated_at)
       VALUES('gw-acct',?,'account','codex-a@example.test','active',?,'sa',?,?)`,
    )
    .run(
      identity.vendor.id,
      JSON.stringify({
        platform: 'openai',
        execution_kind: 'gateway_worker',
        email: 'codex-a@example.test',
        plan: 'plus',
        weight: 7,
        max_concurrency: 4,
        max_rpm: 120,
      }),
      stamp,
      stamp,
    )
  for (const id of ['gw-1', 'gw-2'])
    platform.db
      .prepare(
        "INSERT INTO gateway_worker_instances(id,name,base_url,created_at,updated_at) VALUES(?,?,'http://127.0.0.1:1',?,?)",
      )
      .run(id, id, stamp, stamp)
  const quota = {
    plan_type: 'pro',
    // 位置与时长相反：按时长归类，secondary 才是 5h
    primary_window: { used_percent: 100, window_minutes: 10080, reset_at: '2026-11-05T00:00:00.000Z' },
    secondary_window: { used_percent: 40, window_minutes: 300, reset_at: '2026-11-03T14:00:00.000Z' },
  }
  const bind = platform.db.prepare(
    `INSERT INTO gateway_worker_account_bindings(id,account_resource_id,gateway_instance_id,runtime_account_id,projection_status,quota_json,created_at,updated_at)
     VALUES(?,'gw-acct',?,'gwacct_gw-acct',?,?,?,?)`,
  )
  bind.run('b-synced', 'gw-1', 'synced', JSON.stringify(quota), stamp, '2026-11-03T11:00:00.000Z')
  // 更新的 drifted 绑定不能把已同步的账号判成待授权
  bind.run('b-drifted', 'gw-2', 'drifted', null, stamp, '2026-11-03T11:59:00.000Z')
  const read = async () =>
    (await accountPortalRows(platform, await platform.listResources(identity, 'account'), { now })).find(
      (r) => r.id === 'gw-acct',
    ).telemetry
  let row = await read()
  assert.equal(row.execution_kind, 'gateway_worker')
  assert.equal(row.credential_state, 'valid')
  assert.equal(row.requires_authorization, false)
  assert.equal(row.utilization_5h, 0.4)
  assert.equal(row.reset_5h, '2026-11-03T14:00:00.000Z')
  assert.equal(row.utilization_7d, 1)
  assert.equal(row.reset_7d, '2026-11-05T00:00:00.000Z')
  assert.equal(row.plan_type, 'pro')
  assert.equal(row.email, 'codex-a@example.test')
  assert.equal(row.priority, 7)
  assert.equal(row.max_concurrency, 4)
  assert.equal(row.max_rpm, 120)
  assert.equal(row.near_limit, true)
  // 7D 用尽未重置：受限而非故障，冷却到窗口重置
  assert.equal(row.state, 'cooling')
  assert.equal(row.schedule_state, 'restricted')
  assert.equal(row.restriction_reason, 'quota_7d')
  assert.equal(row.cooldown_until, '2026-11-05T00:00:00.000Z')
  assert.equal(row.window_7d_requests, 0)
  // 错误保护冻结优先于额度窗口
  platform.db
    .prepare(
      "INSERT INTO gateway_account_freezes(account_resource_id,source_instance_id,frozen_until,reason,updated_at) VALUES('gw-acct','gw-1','2026-11-03T12:30:00.000Z','rule',?)",
    )
    .run(stamp)
  row = await read()
  assert.equal(row.restriction_reason, 'cooldown')
  assert.equal(row.cooldown_until, '2026-11-03T12:30:00.000Z')
  // 额度未用尽、无冻结：可调度
  platform.db.prepare('DELETE FROM gateway_account_freezes').run()
  quota.primary_window.used_percent = 20
  platform.db
    .prepare("UPDATE gateway_worker_account_bindings SET quota_json=? WHERE id='b-synced'")
    .run(JSON.stringify(quota))
  row = await read()
  assert.equal(row.state, 'available')
  assert.equal(row.schedule_state, 'on')
  assert.equal(row.schedulable, true)
  assert.equal(row.cooldown_until, null)
})
