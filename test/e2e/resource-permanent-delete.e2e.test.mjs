import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { startGateway } from '../harness.mjs'
import { startGatewayAccountFixture } from '../helpers/gateway-account-fixture.mjs'
import { requestVendorAccount } from './vendor-account-test-helper.mjs'

// 永久删除（docs/RESOURCE_WORKBENCH.md 第 6 节）：Codex 账号、账号池账号与 VM 页删除供应商 VM 共用同一规则；
// 归档仍是可逆选项（供应商门户的 DELETE 仍为归档）。

function readDb(project, sql, ...params) {
  const db = new DatabaseSync(path.join(project, 'data', 'kin.db'))
  try {
    return db.prepare(sql).all(...params)
  } finally {
    db.close()
  }
}

async function supplierGatewayAccount(f) {
  const created = await f.request('POST', 'users', {
    username: 'delete-supplier',
    password: 'supplier-test-123',
    role: 'vendor',
    groups: [{ group_id: f.groups[0] }],
  })
  assert.equal(created.status, 201, JSON.stringify(created.raw))
  const login = await fetch(f.baseUrl + '/api/panel/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'delete-supplier', password: 'supplier-test-123' }),
  })
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const vendor = async (method, pathname, body) => {
    const res = await fetch(f.baseUrl + pathname, {
      method,
      headers: { cookie, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const json = await res.json()
    return { status: res.status, data: json.data || json, raw: json }
  }
  const me = await vendor('GET', '/api/vendor/me')
  const vendorId = me.data.vendor.id
  await f.request('PUT', `gateway-execution-policies?vendor_id=${vendorId}`, {
    platform: 'openai',
    execution_kind: 'gateway_worker',
    allow_create: true,
    allow_runtime: true,
  })
  const proxy = await vendor('POST', '/api/vendor/proxies', {
    name: 'Supplier exit',
    config: { endpoint: 'socks5://pxuser:pxsecret@127.0.0.1:1080' },
  })
  const draft = await vendor('POST', '/api/vendor/account-drafts', {
    platform: 'openai',
    authorization_kind: 'codex_account_file',
    execution_kind: 'gateway_worker',
    group_ids: [f.groups[0]],
    proxy_id: proxy.data.id,
  })
  assert.equal(draft.status, 201, JSON.stringify(draft.raw))
  const imported = await vendor('POST', `/api/vendor/account-drafts/${draft.data.draft.id}/import`, {
    type: 'codex',
    mode: 'json',
    auth_json: JSON.stringify({
      access_token: 'at-test',
      refresh_token: 'rt-test',
      email: 'delete-codex@example.test',
      chatgpt_account_id: 'acct-delete',
    }),
  })
  assert.equal(imported.status, 200, JSON.stringify(imported.raw))
  return {
    vendor,
    vendorId,
    accountId: imported.data.account.id,
    runtimeId: imported.data.gateway_worker.runtime_account_id,
  }
}

test('Codex accounts are permanently deleted from every view and tombstoned for the Worker; supplier rules apply', async (t) => {
  const f = await startGatewayAccountFixture()
  t.after(() => f.stop())
  // 平台自有账号：Codex 账号页的 DELETE
  const draft = await f.request('POST', 'codex-accounts/drafts', {
    name: 'Platform delete',
    group_ids: f.groups,
    proxy_endpoint: 'socks5://user:fixture-secret@proxy.example.test:1080',
    idempotency_key: crypto.randomUUID(),
  })
  const base = `codex-accounts/drafts/${draft.data.draft.id}`
  const session = await f.request('POST', `${base}/oauth/generate-auth-url`, {})
  const completed = await f.request('POST', `${base}/oauth/exchange-code`, {
    session_id: session.data.session_id,
    code: f.callbackFor(session.data.auth_url),
  })
  assert.equal(completed.status, 200, JSON.stringify(completed.raw))
  const platform = completed.data.account
  // 令牌由控制面直接写进凭据库（S1），Worker 从库里读到
  assert.equal(f.facts(platform.id).native_revision, 1)
  const removed = await f.request('DELETE', `codex-accounts/${platform.id}`)
  assert.equal(removed.status, 200, JSON.stringify(removed.raw))
  assert.equal(removed.data.deleted, platform.id)
  // Worker 读到墓碑后删除本地账号与凭据（Go ApplyFacts）；控制面不调用 Worker 的删除接口
  const tombFacts = f.facts(platform.id)
  assert.ok(tombFacts.deleted_at)
  assert.equal(tombFacts.native_revision, null, 'the vault no longer holds its credentials')
  assert.equal(
    f.calls.some((c) => c.method === 'DELETE'),
    false,
  )
  assert.equal((await f.request('GET', `codex-accounts/${platform.id}`)).status, 404)
  assert.equal(
    (await f.request('GET', 'codex-accounts?archived=all')).data.items.some((a) => a.id === platform.id),
    false,
  )
  assert.equal((await f.request('DELETE', `codex-accounts/${platform.id}`)).status, 404)
  const [tomb] = readDb(f.project, 'SELECT status,deleted_at,secret_json FROM vendor_resources WHERE id=?', platform.id)
  assert.equal(tomb.status, 'archived')
  assert.ok(tomb.deleted_at)
  assert.equal(tomb.secret_json, null)

  // 供应商自有账号：供应商停用时拒绝（与归档同一规则），启用后从运营端账号池永久删除
  const supplier = await supplierGatewayAccount(f)
  const disabled = await f.request('PATCH', `../admin/vendors/${supplier.vendorId}`, { status: 'disabled' })
  assert.equal(disabled.status, 200, JSON.stringify(disabled.raw))
  const refused = await f.request('DELETE', `codex-accounts/${supplier.accountId}`)
  assert.deepEqual([refused.status, refused.raw.error.code], [409, 'vendor_inactive'])
  const refusedPool = await fetch(`${f.baseUrl}/api/admin/vendors/accounts/${supplier.accountId}`, {
    method: 'DELETE',
    headers: { cookie: f.cookie },
  })
  assert.equal(refusedPool.status, 409)
  assert.equal(f.facts(supplier.accountId).deleted_at, null)
  await f.request('PATCH', `../admin/vendors/${supplier.vendorId}`, { status: 'active' })
  const pooled = await fetch(`${f.baseUrl}/api/admin/vendors/accounts/${supplier.accountId}`, {
    method: 'DELETE',
    headers: { cookie: f.cookie },
  })
  assert.equal(pooled.status, 200, await pooled.clone().text())
  assert.equal((await pooled.json()).data.deleted, supplier.accountId)
  assert.ok(f.facts(supplier.accountId).deleted_at)
  const pool = await fetch(`${f.baseUrl}/api/admin/vendors/accounts?archived=all`, { headers: { cookie: f.cookie } })
  assert.equal(
    (await pool.json()).data.some((row) => row.id === supplier.accountId),
    false,
  )
  const portal = await supplier.vendor('GET', '/api/vendor/accounts?archived=all')
  assert.equal(portal.status, 200, JSON.stringify(portal.raw))
  assert.equal(
    portal.data.some((row) => row.id === supplier.accountId),
    false,
  )
  assert.equal((await supplier.vendor('GET', `/api/vendor/accounts/${supplier.accountId}`)).status, 404)
})

async function login(gw, username, password) {
  const res = await fetch(`${gw.baseUrl}/api/panel/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  return { status: res.status, json: await res.json(), cookie: res.headers.get('set-cookie') || '' }
}

async function rawRequest(gw, method, pathname, cookie, body) {
  const res = await fetch(gw.baseUrl + pathname, {
    method,
    headers: { cookie, 'content-type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() }
}

const request = (gw, method, pathname, cookie, body) =>
  method === 'POST' && pathname === '/api/vendor/accounts'
    ? requestVendorAccount(gw, cookie, body || {}, rawRequest)
    : rawRequest(gw, method, pathname, cookie, body)

test('VM-backed supplier accounts delete their runtime VM through the VM delete path; settlement history stays', async () => {
  const gw = await startGateway()
  try {
    const sa = await login(gw, 'admin', 'testpass')
    const group = await request(gw, 'POST', '/api/panel/groups', sa.cookie, {
      name: 'del-coding',
      platform: 'anthropic',
    })
    const groupId = group.json.data.item.id
    const user = await request(gw, 'POST', '/api/panel/users', sa.cookie, {
      username: 'vendor-del',
      password: 'vendor-pass',
      role: 'user',
    })
    const vendor = await request(gw, 'POST', '/api/admin/vendors', sa.cookie, {
      groups: [String(groupId)],
      platforms: ['anthropic'],
      account_limit: 4,
      proxy_limit: 2,
      child_limit: 0,
      user_id: user.json.data.item.id,
    })
    assert.equal(vendor.status, 201, JSON.stringify(vendor.json))
    const vendorId = vendor.json.data.id
    const supplier = await login(gw, 'vendor-del', 'vendor-pass')
    const create = async (key) => {
      const created = await request(gw, 'POST', '/api/vendor/accounts', supplier.cookie, {
        name: key,
        platform: 'anthropic',
        auth_method: 'oauth',
        authorization_kind: 'claude_oauth',
        group_ids: [groupId],
        idempotency_key: key,
      })
      assert.equal(created.status, 201, JSON.stringify(created.json))
      return {
        accountId: created.json.data.account.id,
        vmResourceId: created.json.data.vm.id,
        vmId: created.json.data.vm.config.runtime_vm_id,
      }
    }
    const pooled = await create('delete-from-pool')
    const fromVmPage = await create('delete-from-vm-page')
    const archivedFirst = await create('archive-then-delete')
    const vmFile = (id) => path.join(gw.project, 'vms', `${id}.json`)
    assert.ok(fs.existsSync(vmFile(pooled.vmId)))
    // 结算历史：已删除账号的用量事实仍引用墓碑行
    const db = new DatabaseSync(path.join(gw.project, 'data', 'kin.db'))
    try {
      db.prepare(
        "INSERT INTO usage_logs(id,request_id,vm_id,created_at,status,model,total_cost,input_tokens) VALUES ('del-usage','del-usage',?,?,200,'claude-sonnet-4',1.5,10)",
      ).run(pooled.vmId, new Date(Date.now() - 1000).toISOString())
    } finally {
      db.close()
    }

    // 供应商停用时拒绝，VM 保持不动
    await request(gw, 'PATCH', `/api/admin/vendors/${vendorId}`, sa.cookie, { status: 'disabled' })
    const refused = await request(gw, 'DELETE', `/api/admin/vendors/accounts/${pooled.accountId}`, sa.cookie)
    assert.deepEqual([refused.status, refused.json.error.code], [409, 'vendor_inactive'])
    assert.ok(fs.existsSync(vmFile(pooled.vmId)))
    const refusedVm = await request(gw, 'DELETE', `/api/panel/vms/${fromVmPage.vmId}`, sa.cookie)
    assert.equal(refusedVm.status, 409)
    assert.ok(fs.existsSync(vmFile(fromVmPage.vmId)))
    await request(gw, 'PATCH', `/api/admin/vendors/${vendorId}`, sa.cookie, { status: 'active' })

    // 账号池永久删除：配对 VM 与 VM 页删除同一流程，资源对写成墓碑
    const deleted = await request(gw, 'DELETE', `/api/admin/vendors/accounts/${pooled.accountId}`, sa.cookie)
    assert.equal(deleted.status, 200, JSON.stringify(deleted.json))
    assert.deepEqual(deleted.json.data, { deleted: pooled.accountId, vm_id: pooled.vmId })
    assert.equal(fs.existsSync(vmFile(pooled.vmId)), false)
    assert.equal(fs.existsSync(path.join(gw.project, 'vms', pooled.vmId)), false)
    const groupAfter = await request(gw, 'GET', `/api/panel/groups/${groupId}`, sa.cookie)
    assert.equal(
      groupAfter.json.data.item.resources.some((r) => r.resource_id === pooled.vmId),
      false,
    )

    // VM 页删除供应商自有 VM：同时删除它的账号 / 虚拟机资源对，账号池不留孤儿
    const vmDeleted = await request(gw, 'DELETE', `/api/panel/vms/${fromVmPage.vmId}`, sa.cookie)
    assert.equal(vmDeleted.status, 200, JSON.stringify(vmDeleted.json))

    // 已归档账号（归档已销毁 VM）也可以永久删除
    const archived = await request(gw, 'DELETE', `/api/vendor/accounts/${archivedFirst.accountId}`, supplier.cookie)
    assert.equal(archived.status, 200, JSON.stringify(archived.json))
    assert.equal(archived.json.data.status, 'archived', 'the supplier portal DELETE still archives')
    assert.equal(fs.existsSync(vmFile(archivedFirst.vmId)), false)
    const afterArchive = await request(
      gw,
      'DELETE',
      `/api/admin/vendors/accounts/${archivedFirst.accountId}`,
      sa.cookie,
    )
    assert.equal(afterArchive.status, 200, JSON.stringify(afterArchive.json))

    const tombstones = readDb(
      gw.project,
      'SELECT id,status,deleted_at,secret_json FROM vendor_resources WHERE id IN (?,?,?,?,?,?) ORDER BY id',
      ...[pooled, fromVmPage, archivedFirst].flatMap((p) => [p.accountId, p.vmResourceId]),
    )
    assert.equal(tombstones.length, 6)
    for (const row of tombstones) {
      assert.equal(row.status, 'archived', row.id)
      assert.ok(row.deleted_at, row.id)
      assert.equal(row.secret_json, null)
    }
    for (const [base, cookie] of [
      ['/api/admin/vendors/accounts?archived=all', sa.cookie],
      ['/api/vendor/accounts?archived=all', supplier.cookie],
    ]) {
      const list = await request(gw, 'GET', base, cookie)
      assert.equal(list.status, 200, JSON.stringify(list.json))
      assert.deepEqual(list.json.data, [], base)
    }
    assert.equal((await request(gw, 'GET', `/api/admin/vendors/accounts/${pooled.accountId}`, sa.cookie)).status, 404)
    assert.equal(
      (await request(gw, 'DELETE', `/api/admin/vendors/accounts/${pooled.accountId}`, sa.cookie)).status,
      404,
    )
    // 用量与结算历史仍按资源 ID 解析名称
    const usage = await request(gw, 'GET', '/api/vendor/usage', supplier.cookie)
    assert.equal(usage.status, 200, JSON.stringify(usage.json))
    const row = usage.json.data.account_usage.find((item) => item.account_id === pooled.accountId)
    assert.ok(row, JSON.stringify(usage.json.data.account_usage))
    assert.equal(row.account_name, 'delete-from-pool')
    assert.equal(row.requests, 1)
  } finally {
    await gw.stop()
  }
})
