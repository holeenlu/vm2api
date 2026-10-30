import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AccountsRepo } from '../../src/lib/db/repos/accounts-repo.mjs'
import { AccountRuntimeRepo } from '../../src/lib/db/repos/account-runtime-repo.mjs'
import { normalizeOpenAIQuotaPolicy } from '../../src/lib/pool/openai-quota-policy.mjs'
import { startGateway } from '../harness.mjs'

async function login(gw, username, password) {
  const res = await fetch(`${gw.baseUrl}/api/panel/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  return { status: res.status, json: await res.json(), cookie: res.headers.get('set-cookie') || '' }
}

async function request(gw, method, path, cookie, body) {
  const res = await fetch(gw.baseUrl + path, {
    method,
    headers: { cookie, 'content-type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() }
}

test('user-form supplier grants control both platform catalogs and account writes', async () => {
  const gw = await startGateway()
  try {
    const sa = await login(gw, 'admin', 'testpass')
    const addGroup = async (name, platform) => {
      const result = await request(gw, 'POST', '/api/panel/groups', sa.cookie, { name, platform })
      assert.equal(result.status, 201, JSON.stringify(result.json))
      return result.json.data.item.id
    }
    const coding = await addGroup('Scoped Coding', 'mixed')
    const claude = await addGroup('Unassigned Claude', 'anthropic')
    const codex = await addGroup('Unassigned Codex', 'openai')
    const created = await request(gw, 'POST', '/api/panel/users', sa.cookie, {
      username: 'scoped-vendor',
      password: 'supplier-test-123',
      role: 'vendor',
      vendor_create_child: true,
      groups: [{ group_id: coding, rate_multiplier: null }],
    })
    assert.equal(created.status, 201, JSON.stringify(created.json))
    const userId = created.json.data.item.id
    const vendorId = created.json.data.item.vendor.id
    assert.deepEqual(created.json.data.item.vendor.groups, [String(coding)])
    const supplier = await login(gw, 'scoped-vendor', 'supplier-test-123')
    const catalog = async () => {
      const result = await request(gw, 'GET', '/api/panel/groups', supplier.cookie)
      assert.equal(result.status, 200, JSON.stringify(result.json))
      return result.json.data.items
    }
    assert.deepEqual(
      (await catalog()).map((g) => g.id),
      [coding],
    )
    assert.deepEqual((await catalog())[0].supported_platforms, ['anthropic', 'openai'])
    for (const [platform, groupId] of [
      ['anthropic', claude],
      ['openai', codex],
    ]) {
      const denied = await request(gw, 'POST', '/api/vendor/accounts', supplier.cookie, {
        platform,
        group_ids: [groupId],
      })
      assert.equal(denied.status, 403, JSON.stringify(denied.json))
      assert.equal(denied.json.error.code, 'group_scope_forbidden')
    }
    const edit = await request(gw, 'PATCH', `/api/panel/users/${userId}`, sa.cookie, { groups: [claude] })
    assert.equal(edit.status, 200, JSON.stringify(edit.json))
    assert.deepEqual(
      (await catalog()).map((g) => g.id),
      [claude],
    )
    const noOpenAI = await request(gw, 'POST', '/api/vendor/accounts', supplier.cookie, { platform: 'openai' })
    assert.equal(noOpenAI.status, 409, JSON.stringify(noOpenAI.json))
    assert.equal(noOpenAI.json.error.code, 'no_available_group')
    const invalid = await request(gw, 'PATCH', `/api/panel/users/${userId}`, sa.cookie, { groups: [99999999] })
    assert.equal(invalid.status, 400)
    assert.deepEqual(
      (await catalog()).map((g) => g.id),
      [claude],
    )
    const put = await request(gw, 'PUT', `/api/panel/users/${userId}/groups`, sa.cookie, { groups: [codex] })
    assert.equal(put.status, 200, JSON.stringify(put.json))
    assert.deepEqual(
      (await catalog()).map((g) => g.id),
      [codex],
    )
    const editVendor = await request(gw, 'PATCH', `/api/admin/vendors/${vendorId}`, sa.cookie, {
      groups: [String(coding)],
    })
    assert.equal(editVendor.status, 200, JSON.stringify(editVendor.json))
    const userGrants = await request(gw, 'GET', `/api/panel/users/${userId}/groups`, sa.cookie)
    assert.deepEqual(
      userGrants.json.data.items.map((g) => g.group_id),
      [coding],
    )
    const child = await request(gw, 'POST', '/api/vendor/vendors', supplier.cookie, {
      username: 'scoped-child',
      password: 'supplier-test-123',
    })
    assert.equal(child.status, 201, JSON.stringify(child.json))
    const conflict = await request(gw, 'PATCH', `/api/panel/users/${userId}`, sa.cookie, { groups: [claude] })
    assert.equal(conflict.json.error.code, 'parent_scope_violation')
    const afterConflict = await request(gw, 'GET', `/api/panel/users/${userId}/groups`, sa.cookie)
    assert.deepEqual(
      afterConflict.json.data.items.map((g) => g.group_id),
      [coding],
    )
    assert.deepEqual(
      (await catalog()).map((g) => g.id),
      [coding],
    )
  } finally {
    await gw.stop()
  }
})

test('supplier portal creates account and VM together, and capability hides child menu', async () => {
  const gw = await startGateway()
  try {
    const sa = await login(gw, 'admin', 'testpass')
    assert.equal(sa.status, 200)
    assert.equal((await request(gw, 'GET', '/api/panel/providers', sa.cookie)).status, 404)
    const emptyAccounts = await request(gw, 'GET', '/api/admin/vendors/accounts', sa.cookie)
    assert.equal(emptyAccounts.status, 200)
    assert.deepEqual(emptyAccounts.json.data, [], 'platform VM must not be listed')
    const group = await request(gw, 'POST', '/api/panel/groups', sa.cookie, {
      name: 'supplier-coding',
      platform: 'anthropic',
    })
    assert.equal(group.status, 201, JSON.stringify(group.json))
    const groupId = group.json.data.item.id
    const user = await request(gw, 'POST', '/api/panel/users', sa.cookie, {
      username: 'vendor-one',
      password: 'vendor-pass',
      role: 'user',
    })
    assert.equal(user.status, 201)
    const vendor = await request(gw, 'POST', '/api/admin/vendors', sa.cookie, {
      groups: [String(groupId)],
      platforms: ['anthropic'],
      account_limit: 4,
      proxy_limit: 2,
      child_limit: 0,
      user_id: user.json.data.item.id,
    })
    assert.equal(vendor.status, 201, JSON.stringify(vendor.json))
    const vendorLogin = await login(gw, 'vendor-one', 'vendor-pass')
    assert.equal(vendorLogin.status, 200)
    assert.equal((await request(gw, 'GET', '/api/admin/vendors/accounts', vendorLogin.cookie)).status, 403)
    const me = await request(gw, 'GET', '/api/vendor/me', vendorLogin.cookie)
    assert.equal(me.status, 200, JSON.stringify(me.json))
    assert.equal(me.json.data.vendor.views.includes('vendors'), false)
    const directVm = await request(gw, 'POST', '/api/vendor/vms', vendorLogin.cookie, { name: 'illegal direct vm' })
    assert.equal(directVm.status, 409)
    assert.equal(directVm.json.error.code, 'account_creation_required')
    const proxy = await request(gw, 'POST', '/api/vendor/proxies', vendorLogin.cookie, {
      name: '供应商出口 01',
      config: { endpoint: 'socks5://127.0.0.1:1080' },
    })
    assert.equal(proxy.status, 201, JSON.stringify(proxy.json))
    assert.ok(proxy.json.data.config.pool_proxy_id)
    const account = await request(gw, 'POST', '/api/vendor/accounts', vendorLogin.cookie, {
      name: '账号 01',
      platform: 'anthropic',
      auth_method: 'oauth',
      authorization_kind: 'claude_oauth',
      proxy_id: proxy.json.data.id,
      group_ids: [groupId],
      idempotency_key: 'account-1',
    })
    assert.equal(account.status, 201, JSON.stringify(account.json))
    assert.equal(account.json.data.account.resource_type, 'account')
    assert.equal(account.json.data.vm.resource_type, 'vm')
    assert.equal(account.json.data.vm.config.account_resource_id, account.json.data.account.id)
    const runtimeVmId = account.json.data.vm.config.runtime_vm_id
    assert.ok(runtimeVmId)
    const accounts = await request(gw, 'GET', '/api/admin/vendors/accounts', sa.cookie)
    assert.equal(accounts.status, 200, JSON.stringify(accounts.json))
    assert.equal(accounts.json.data.length, 1)
    assert.equal(accounts.json.data[0].id, account.json.data.account.id)
    assert.equal(accounts.json.data[0].telemetry.vm_id, runtimeVmId)
    assert.equal(accounts.json.data[0].vendor_id, vendor.json.data.id)
    assert.equal(accounts.json.data[0].name, account.json.data.account.name)
    for (const [base, cookie] of [
      ['/api/vendor/accounts', vendorLogin.cookie],
      ['/api/admin/vendors/accounts', sa.cookie],
    ]) {
      const found = await request(
        gw,
        'GET',
        base +
          '?search=' +
          encodeURIComponent(account.json.data.account.name) +
          '&platform=anthropic&method=oauth&group=' +
          groupId,
        cookie,
      )
      assert.deepEqual(
        found.json.data.map((r) => r.id),
        [account.json.data.account.id],
      )
      for (const query of [
        'platform=openai',
        'method=apikey',
        'group=999999',
        'status=normal',
        'from=2099-01-01',
        'archived=only',
        'schedulable=yes',
      ]) {
        const filtered = await request(gw, 'GET', base + '?' + query, cookie)
        assert.equal(filtered.status, 200, JSON.stringify(filtered.json))
        assert.deepEqual(filtered.json.data, [], query)
      }
    }
    const vendors = await request(gw, 'GET', '/api/admin/vendors', sa.cookie)
    assert.equal(vendors.status, 200, JSON.stringify(vendors.json))
    assert.equal(
      vendors.json.data.find((item) => item.id === accounts.json.data[0].vendor_id).name,
      me.json.data.vendor.name,
    )
    const runtimeVm = JSON.parse(fs.readFileSync(path.join(gw.project, 'vms', `${runtimeVmId}.json`), 'utf8'))
    assert.equal(runtimeVm.vendor_account_resource_id, account.json.data.account.id)
    assert.equal(account.json.data.runtime_boot.ok, false)
    assert.equal(account.json.data.runtime_boot.code, 'runtime_start_failed')
    assert.equal(runtimeVm.status, 'stopped')
    assert.equal(runtimeVm.proxy.id, proxy.json.data.config.pool_proxy_id)
    const assigned = await request(gw, 'GET', `/api/panel/groups/${groupId}`, sa.cookie)
    assert.equal(assigned.status, 200, JSON.stringify(assigned.json))
    assert.ok(assigned.json.data.item.resources.some((item) => item.resource_id === runtimeVmId))
    const pool = await request(gw, 'GET', '/api/panel/proxies', sa.cookie)
    assert.equal(pool.status, 200, JSON.stringify(pool.json))
    const poolProxy = pool.json.data.proxies.find((item) => item.id === proxy.json.data.config.pool_proxy_id)
    assert.equal(poolProxy.vendor_id, vendor.json.data.id)
    assert.ok(poolProxy.bound_vm_ids.includes(runtimeVmId))
    const vendorPool = await request(gw, 'GET', `/api/panel/proxies?vendor_id=${vendor.json.data.id}`, sa.cookie)
    assert.equal(vendorPool.status, 200, JSON.stringify(vendorPool.json))
    assert.equal(vendorPool.json.data.proxies.length, 1)
    const platformPool = await request(gw, 'GET', '/api/panel/proxies?platform=anthropic', sa.cookie)
    assert.equal(platformPool.status, 200, JSON.stringify(platformPool.json))
    assert.ok(platformPool.json.data.proxies.some((item) => item.id === poolProxy.id))
    const poolLimit = await request(gw, 'PUT', '/api/panel/proxies/config', sa.cookie, { bind_limit: 1 })
    assert.equal(poolLimit.status, 200, JSON.stringify(poolLimit.json))
    const beforeFiles = fs.readdirSync(path.join(gw.project, 'vms')).sort()
    const full = await request(gw, 'POST', '/api/vendor/accounts', vendorLogin.cookie, {
      name: 'cannot-bind',
      proxy_id: proxy.json.data.id,
      group_ids: [groupId],
      idempotency_key: 'full-proxy',
    })
    assert.equal(full.status, 409, JSON.stringify(full.json))
    assert.equal(full.json.error.code, 'proxy_bind_failed')
    assert.deepEqual(fs.readdirSync(path.join(gw.project, 'vms')).sort(), beforeFiles)
    const afterFailure = await request(gw, 'GET', '/api/vendor/accounts', vendorLogin.cookie)
    assert.equal(afterFailure.json.data.length, 1)
    const rename = await request(
      gw,
      'PATCH',
      '/api/vendor/accounts/' + account.json.data.account.id,
      vendorLogin.cookie,
      { name: 'Atomic rename', notes: 'review', status: 'paused' },
    )
    assert.equal(rename.status, 200, JSON.stringify(rename.json))
    const renamedVm = JSON.parse(fs.readFileSync(path.join(gw.project, 'vms', runtimeVmId + '.json'), 'utf8'))
    assert.equal(renamedVm.name, 'Atomic rename')
    assert.equal(renamedVm.vendor_resource_paused, true)
    const rootDb = new DatabaseSync(path.join(gw.project, 'data', 'kin.db'))
    rootDb.exec(
      "CREATE TRIGGER audit_failure BEFORE INSERT ON vendor_resources WHEN NEW.name='fail-reviewed' BEGIN SELECT RAISE(ABORT,'db-private-detail'); END",
    )
    const rejected = await request(gw, 'POST', '/api/vendor/accounts', vendorLogin.cookie, { name: 'fail-reviewed' })
    assert.equal(rejected.status, 500)
    assert.ok(!JSON.stringify(rejected.json).includes('db-private-detail'))
    rootDb.exec('DROP TRIGGER audit_failure')
    rootDb.close()
    const inline = await request(gw, 'POST', '/api/vendor/accounts', vendorLogin.cookie, {
      name: 'pasted proxy',
      authorization_kind: 'claude_oauth',
      proxy_endpoint: '127.0.0.1:3129:newuser:secret-pass',
      group_ids: [groupId],
      idempotency_key: 'inline-account',
    })
    assert.equal(inline.status, 201, JSON.stringify(inline.json))
    assert.equal(JSON.stringify(inline.json).includes('secret-pass'), false)
    const ownedProxies = await request(gw, 'GET', '/api/vendor/proxies', vendorLogin.cookie)
    const savedProxy = ownedProxies.json.data.find((p) => p.id === inline.json.data.account.config.proxy_id)
    assert.ok(savedProxy.config.pool_proxy_id)
    const pastedVm = JSON.parse(
      fs.readFileSync(path.join(gw.project, 'vms', inline.json.data.vm.config.runtime_vm_id + '.json'), 'utf8'),
    )
    assert.equal(pastedVm.proxy.id, savedProxy.config.pool_proxy_id)
    const retry = await request(gw, 'POST', '/api/vendor/accounts', vendorLogin.cookie, {
      name: 'changed',
      platform: 'anthropic',
      auth_method: 'oauth',
      idempotency_key: 'account-1',
    })
    assert.equal(retry.status, 200)
    assert.equal(retry.json.data.reused, true)
    assert.equal(retry.json.data.account.id, account.json.data.account.id)
  } finally {
    await gw.stop()
  }
})

test('supplier UI endpoints enforce zero limit, read scope, method and schedule isolation', async () => {
  const gw = await startGateway()
  try {
    const sa = await login(gw, 'admin', 'testpass')
    const create = await request(gw, 'POST', '/api/panel/users', sa.cookie, {
      username: 'portal-parent',
      password: 'supplier-test-123',
      role: 'vendor',
      vendor_create_child: true,
      vendor_child_limit: 0,
    })
    assert.equal(create.status, 201, JSON.stringify(create.json))
    assert.equal(create.json.data.item.vendor.child_limit, 0)
    assert.equal(create.json.data.item.vendor.name, 'portal-parent')
    assert.equal(create.json.data.item.vendor.settlement_email, undefined)
    assert.equal(create.json.data.item.vendor.contact_name, undefined)
    const parent = await login(gw, 'portal-parent', 'supplier-test-123')
    const childIds = []
    for (let n = 1; n <= 2; n++) {
      const child = await request(gw, 'POST', '/api/vendor/vendors', parent.cookie, {
        username: 'portal-child' + n,
        password: 'supplier-test-123',
      })
      assert.equal(child.status, 201, JSON.stringify(child.json))
      childIds.push(child.json.data.id)
    }
    const billing = await request(gw, 'GET', '/api/vendor/billing', parent.cookie)
    assert.equal(billing.status, 200, JSON.stringify(billing.json))
    assert.equal(billing.json.data.profile, undefined)
    const settlement = await request(gw, 'POST', '/api/vendor/settlements', parent.cookie, {
      vendor_id: childIds[0],
      start_date: '2026-10-01',
      end_date: '2026-10-08',
    })
    assert.equal(settlement.status, 400, JSON.stringify(settlement.json))
    assert.equal(settlement.json.error.code, 'settlement_preview_required')
    assert.equal((await request(gw, 'GET', '/api/vendor/audit-logs', parent.cookie)).status, 404)
    const child = await login(gw, 'portal-child1', 'supplier-test-123')
    const pair = await request(gw, 'POST', '/api/vendor/accounts', child.cookie, {
      name: 'Test account',
      platform: 'anthropic',
    })
    assert.equal(pair.status, 201, JSON.stringify(pair.json))
    const accountId = pair.json.data.account.id
    const vmId = pair.json.data.vm.config.runtime_vm_id
    const list = await request(gw, 'GET', '/api/vendor/accounts?vendor_id=all', parent.cookie)
    assert.equal(list.status, 200, JSON.stringify(list.json))
    assert.equal(list.json.data.length, 1)
    const parentId = create.json.data.item.vendor.id
    const selectedParent = await request(gw, 'GET', '/api/admin/vendors/accounts?vendor_id=' + parentId, sa.cookie)
    assert.equal(selectedParent.status, 200, JSON.stringify(selectedParent.json))
    assert.equal(selectedParent.json.data.length, 0)
    assert.equal(list.json.data[0].telemetry.state, 'unauthorized')
    assert.equal((await request(gw, 'GET', '/api/vendor/accounts?vendor_id=all', child.cookie)).status, 403)
    assert.equal((await request(gw, 'GET', '/api/vendor/vendors', child.cookie)).status, 403)
    assert.equal(
      (await request(gw, 'PATCH', '/api/vendor/accounts/' + accountId, parent.cookie, { status: 'paused' })).status,
      403,
    )
    assert.equal((await request(gw, 'GET', `/api/vendor/accounts/${accountId}/pause`, child.cookie)).status, 405)
    assert.equal(
      (await request(gw, 'PATCH', '/api/vendor/accounts/' + accountId, child.cookie, { status: 'paused' })).status,
      200,
    )
    let vm = JSON.parse(fs.readFileSync(path.join(gw.project, 'vms', vmId + '.json'), 'utf8'))
    assert.equal(vm.vendor_resource_paused, true)
    assert.equal(
      (await request(gw, 'PATCH', '/api/vendor/accounts/' + accountId, child.cookie, { status: 'active' })).status,
      200,
    )
    vm = JSON.parse(fs.readFileSync(path.join(gw.project, 'vms', vmId + '.json'), 'utf8'))
    assert.equal(vm.unschedulable.reason, 'no_credential')
    assert.equal(vm.schedulable, false)
    const detail = await request(gw, 'GET', '/api/vendor/accounts/' + accountId, child.cookie)
    assert.equal('secret_json' in detail.json.data, false)
    assert.equal(detail.status, 200, JSON.stringify(detail.json))
    assert.equal(detail.json.data.owner.name, 'portal-child1')
    const adminDetail = await request(gw, 'GET', '/api/admin/vendors/accounts/' + accountId, sa.cookie)
    assert.equal(adminDetail.status, 200, JSON.stringify(adminDetail.json))
    assert.deepEqual(adminDetail.json.data.groups, detail.json.data.groups)
    const choices = await request(gw, 'GET', `/api/vendor/accounts/${accountId}/groups`, child.cookie)
    const adminChoices = await request(gw, 'GET', `/api/admin/vendors/accounts/${accountId}/groups`, sa.cookie)
    assert.equal(choices.status, 200, JSON.stringify(choices.json))
    assert.deepEqual(adminChoices.json.data, choices.json.data)
    assert.equal((await request(gw, 'GET', `/api/vendor/accounts/${accountId}/groups`, parent.cookie)).status, 403)

    assert.deepEqual(adminDetail.json.data.all_time_usage, detail.json.data.all_time_usage)
    assert.equal(adminDetail.json.data.telemetry.vm_id, detail.json.data.telemetry.vm_id)
    assert.ok(Array.isArray(detail.json.data.cooldowns))
    assert.equal(
      (await request(gw, 'POST', `/api/vendor/accounts/${accountId}/cooldown/clear`, parent.cookie)).status,
      403,
    )
    assert.equal((await request(gw, 'DELETE', `/api/vendor/accounts/${accountId}`, parent.cookie)).status, 403)
    assert.equal(
      (await request(gw, 'PATCH', `/api/vendor/accounts/${accountId}`, child.cookie, { weight: 999 })).status,
      400,
    )
    const proxyEdit = await request(gw, 'PATCH', `/api/vendor/accounts/${accountId}`, child.cookie, {
      name: 'Edited supplier account',
      notes: 'Saved notes',
      proxy_source: 'new',
      proxy_endpoint: '127.0.0.1:4555:own:private',
      expected_updated_at: detail.json.data.updated_at,
    })
    assert.equal(proxyEdit.status, 200, JSON.stringify(proxyEdit.json))
    assert.equal(proxyEdit.json.data.config.vendor_notes, 'Saved notes')
    assert.equal(JSON.stringify(proxyEdit.json).includes('private'), false)
    const edited = await request(gw, 'GET', `/api/vendor/accounts/${accountId}`, child.cookie)
    assert.equal(edited.json.data.proxy.endpoint, 'http://127.0.0.1:4555/')
    assert.equal(
      (
        await request(gw, 'PATCH', `/api/vendor/accounts/${accountId}`, child.cookie, {
          name: 'stale',
          expected_updated_at: 'old',
        })
      ).status,
      409,
    )
    const vmFile = path.join(gw.project, 'vms', vmId + '.json')
    vm = JSON.parse(fs.readFileSync(vmFile, 'utf8'))
    vm.claude.temp_unschedulable_until = Date.now() + 600000
    vm.claude.temp_unschedulable_reason = 'proxy_timeout'
    vm.claude.quota_test = { utilization_7d: 0.98, reset_7d: '2030-01-01' }
    fs.writeFileSync(vmFile, JSON.stringify(vm))
    const quotaDb = new DatabaseSync(path.join(gw.project, 'data', 'kin.db'))
    const quotaReset = Date.now() + 86400000
    const unified = {
      '5h': { utilization: 0.93, reset: new Date(quotaReset).toISOString(), status: 'rate_limited' },
      '7d': { utilization: 1, reset: new Date(quotaReset).toISOString(), status: 'rate_limited' },
    }
    new AccountsRepo(quotaDb).insert({ account_id: 'audit-quota', vm_id: vmId, unified })
    new AccountRuntimeRepo(quotaDb).upsert({
      account_id: 'audit-quota',
      vm_id: vmId,
      status: 'rate_limited',
      cooldown_until: Date.now() + 60000,
      cooldown_reason: 'temporary_network',
      rate_limit_reset_at: quotaReset,
    })
    vm.claude.account_uuid = 'audit-quota'
    fs.writeFileSync(vmFile, JSON.stringify(vm))
    const cooling = await request(gw, 'GET', `/api/vendor/accounts/${accountId}`, child.cookie)
    assert.ok(cooling.json.data.cooldowns.length)
    const cleared = await request(gw, 'POST', `/api/vendor/accounts/${accountId}/cooldown/clear`, child.cookie)
    assert.equal(cleared.status, 200, JSON.stringify(cleared.json))
    vm = JSON.parse(fs.readFileSync(vmFile, 'utf8'))
    assert.equal(vm.claude.temp_unschedulable_until, undefined)
    assert.equal(vm.claude.quota_test.utilization_7d, 0.98)
    assert.deepEqual(new AccountsRepo(quotaDb).get('audit-quota').unified, unified)
    assert.equal(new AccountRuntimeRepo(quotaDb).get('audit-quota').rate_limit_reset_at, quotaReset)
    quotaDb.close()
    vm.claude.temp_unschedulable_until = Date.now() + 600000
    vm.claude.temp_unschedulable_reason = 'credential_refresh_failed'
    fs.writeFileSync(vmFile, JSON.stringify(vm))
    await request(gw, 'POST', `/api/vendor/accounts/${accountId}/cooldown/clear`, child.cookie)
    assert.equal(
      JSON.parse(fs.readFileSync(vmFile, 'utf8')).claude.temp_unschedulable_reason,
      'credential_refresh_failed',
    )
    const db = new DatabaseSync(path.join(gw.project, 'data', 'kin.db'))
    try {
      db.prepare(
        "INSERT INTO usage_logs(id,request_id,vm_id,created_at,status,model,total_cost,input_tokens) VALUES ('http-usage','http-usage',?,?,200,'claude-sonnet-4',1.5,10)",
      ).run(vmId, new Date(Date.now() - 1000).toISOString())
    } finally {
      db.close()
    }
    const usage = await request(gw, 'GET', `/api/vendor/accounts/${accountId}/usage`, child.cookie)
    assert.equal(usage.status, 200, JSON.stringify(usage.json))
    assert.equal(usage.json.data.summary.requests, 1)
    assert.ok(usage.json.data.fixed_windows['30d'])
    const adminUsage = await request(gw, 'GET', `/api/admin/vendors/accounts/${accountId}/usage`, sa.cookie)
    assert.equal(adminUsage.status, 200, JSON.stringify(adminUsage.json))
    assert.deepEqual(adminUsage.json.data.summary, usage.json.data.summary)
    const archived = await request(gw, 'DELETE', `/api/vendor/accounts/${accountId}`, child.cookie)
    assert.equal(archived.status, 200, JSON.stringify(archived.json))
    assert.equal(archived.json.data.status, 'archived')
    vm = JSON.parse(fs.readFileSync(vmFile, 'utf8'))
    assert.equal(vm.status, 'stopped')
    assert.equal(vm.schedule_off_reason, 'vendor_archived')
    const ownPool = await request(gw, 'GET', '/api/vendor/proxies', child.cookie)
    assert.equal(ownPool.json.data.find((p) => p.id === proxyEdit.json.data.config.proxy_id).config.bound_count, 0)
    assert.equal(
      (await request(gw, 'GET', `/api/vendor/accounts/${accountId}/usage`, child.cookie)).json.data.summary.requests,
      1,
    )
    assert.equal(
      (await request(gw, 'PATCH', `/api/vendor/accounts/${accountId}`, child.cookie, { name: 'revive' })).status,
      409,
    )
    const openaiGroup = await request(gw, 'POST', '/api/panel/groups', sa.cookie, {
      name: 'audit-openai',
      platform: 'openai',
    })
    assert.equal(openaiGroup.status, 201, JSON.stringify(openaiGroup.json))
    const codex = await request(gw, 'POST', '/api/vendor/accounts', child.cookie, {
      platform: 'openai',
      authorization_kind: 'codex_account_file',
    })
    assert.equal(codex.status, 201, JSON.stringify(codex.json))
    const codexVm = JSON.parse(
      fs.readFileSync(path.join(gw.project, 'vms', codex.json.data.vm.config.runtime_vm_id + '.json'), 'utf8'),
    )
    assert.equal(codexVm.platform, 'openai')
    assert.equal(codexVm.family, 'codex')
    assert.equal(codexVm.claude, undefined)
    const routing = JSON.parse(fs.readFileSync(path.join(gw.project, 'config', 'routing.json'), 'utf8'))
    const defaults = normalizeOpenAIQuotaPolicy(routing.codex?.quota)
    assert.equal(codexVm.policy.maxConcurrency, defaults.max_concurrency)
    assert.equal(codexVm.policy.maxRpm, defaults.max_rpm)
    assert.equal(codexVm.policy.maxSessions, defaults.max_sessions)
    assert.equal(codexVm.policy.concurrencyOverride, false)
    for (const field of ['weight', 'max_concurrency', 'runtime_type', 'machine', 'kernel', 'family']) {
      assert.equal(
        (await request(gw, 'POST', '/api/vendor/accounts', child.cookie, { platform: 'openai', [field]: 99 })).status,
        403,
        field,
      )
      assert.equal(
        (
          await request(gw, 'PATCH', '/api/vendor/accounts/' + codex.json.data.account.id, child.cookie, {
            [field]: 99,
          })
        ).status,
        400,
        field,
      )
    }
    assert.equal(
      (await request(gw, 'PATCH', '/api/panel/vms/' + codexVm.id, child.cookie, { max_concurrency: 99, weight: 99 }))
        .status,
      403,
    )
    const superView = await request(gw, 'GET', '/api/panel/vms/' + codexVm.id, sa.cookie)
    assert.equal(superView.status, 200, JSON.stringify(superView.json))
    assert.equal(superView.json.data.vm.id, codexVm.id)
    assert.equal(superView.json.data.vm.name, codex.json.data.account.name)
    assert.equal(superView.json.data.vm.platform, 'openai')
    assert.match(codexVm.name, /^vm-\d+$/)
    assert.equal(codexVm.id, codexVm.name)
    assert.equal(
      (await request(gw, 'PATCH', '/api/vendor/vms/' + codex.json.data.vm.id, child.cookie, { name: 'escape' })).status,
      403,
    )
    assert.equal(codex.json.data.account.name, codexVm.name)
    assert.equal(codex.json.data.vm.name, codexVm.name)
    const next = await request(gw, 'POST', '/api/vendor/accounts', child.cookie, {
      platform: 'openai',
      authorization_kind: 'codex_oauth',
    })
    assert.equal(next.status, 201, JSON.stringify(next.json))
    assert.notEqual(next.json.data.account.name, codexVm.name)
    assert.equal(next.json.data.account.name, next.json.data.vm.name)
    const revoke = await request(gw, 'PATCH', '/api/admin/vendors/' + parentId, sa.cookie, { platforms: ['anthropic'] })
    assert.equal(revoke.status, 200, JSON.stringify(revoke.json))
    const catalog = await request(gw, 'GET', '/api/panel/groups', child.cookie)
    assert.equal(catalog.status, 200)
    assert.ok(!catalog.json.data.items.some((g) => g.id === openaiGroup.json.data.item.id))
    const childMe = await request(gw, 'GET', '/api/vendor/me', child.cookie)
    assert.deepEqual(childMe.json.data.vendor.effective_platforms, ['anthropic'])
    const auth = await request(
      gw,
      'POST',
      '/api/panel/vms/' + codexVm.id + '/oauth/generate-auth-url',
      child.cookie,
      {},
    )
    assert.equal(auth.status, 403, JSON.stringify(auth.json))

    assert.equal(
      (
        await request(gw, 'POST', '/api/vendor/accounts', child.cookie, {
          platform: 'anthropic',
          authorization_kind: 'codex_oauth',
        })
      ).status,
      400,
    )
  } finally {
    await gw.stop()
  }
})
