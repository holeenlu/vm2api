import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startGateway } from '../harness.mjs'

async function request(gw, method, pathname, cookie = '', body) {
  const res = await fetch(gw.baseUrl + pathname, {
    method,
    headers: { cookie, 'content-type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: await res.json(), cookie: res.headers.get('set-cookie') || '' }
}

test('supplier authorization draft creates no account or VM until authorization succeeds', async () => {
  const gw = await startGateway()
  try {
    const admin = await request(gw, 'POST', '/api/panel/login', '', { username: 'admin', password: 'testpass' })
    const group = await request(gw, 'POST', '/api/panel/groups', admin.cookie, {
      name: 'Draft Claude',
      platform: 'anthropic',
    })
    const created = await request(gw, 'POST', '/api/panel/users', admin.cookie, {
      username: 'draft-supplier',
      password: 'supplier-test-123',
      role: 'vendor',
      vendor_create_child: true,
      groups: [{ group_id: group.json.data.item.id }],
    })
    assert.equal(created.status, 201, JSON.stringify(created.json))
    const supplier = await request(gw, 'POST', '/api/panel/login', '', {
      username: 'draft-supplier',
      password: 'supplier-test-123',
    })
    const before = fs.readdirSync(path.join(gw.project, 'vms')).sort()
    const draft = await request(gw, 'POST', '/api/vendor/account-drafts', supplier.cookie, {
      platform: 'anthropic',
      authorization_kind: 'claude_oauth',
      proxy_endpoint: '127.0.0.1:4555:test:example',
      group_ids: [group.json.data.item.id],
    })
    assert.equal(draft.status, 201, JSON.stringify(draft.json))
    assert.equal((await request(gw, 'GET', '/api/vendor/accounts', supplier.cookie)).json.data.length, 0)
    assert.deepEqual(fs.readdirSync(path.join(gw.project, 'vms')).sort(), before)

    const id = draft.json.data.draft.id
    const link = await request(
      gw,
      'POST',
      `/api/vendor/account-drafts/${id}/oauth/generate-auth-url`,
      supplier.cookie,
      {
        flavor: 'cai',
      },
    )
    assert.equal(link.status, 200, JSON.stringify(link.json))
    const completed = await request(
      gw,
      'POST',
      `/api/vendor/account-drafts/${id}/oauth/exchange-code`,
      supplier.cookie,
      {
        session_id: link.json.data.session_id,
        code: 'fake#state',
      },
    )
    assert.equal(completed.status, 200, JSON.stringify(completed.json))
    assert.ok(['normal', 'preparing'].includes(completed.json.data.provisioning.state))
    assert.ok(completed.json.data.account.id)
    assert.ok(completed.json.data.vm.config.runtime_vm_id)
    const rows = (await request(gw, 'GET', '/api/vendor/accounts', supplier.cookie)).json.data
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, completed.json.data.account.id)
    assert.equal(rows[0].name, 'fake-oauth@kin.test')
    assert.equal(rows[0].telemetry.email, 'fake-oauth@kin.test')
    assert.equal(completed.json.data.account.name, 'fake-oauth@kin.test')
    assert.equal(rows[0].config.name_from_authorization, undefined)

    const me = await request(gw, 'GET', '/api/vendor/me', supplier.cookie)
    const vendorId = me.json.data.vendor.id
    const codexGroup = await request(gw, 'POST', '/api/panel/groups', admin.cookie, {
      name: 'Draft Codex',
      platform: 'openai',
    })
    await request(gw, 'PATCH', `/api/admin/vendors/${vendorId}`, admin.cookie, {
      groups: [String(group.json.data.item.id), String(codexGroup.json.data.item.id)],
    })
    for (const [platform, name] of [
      ['anthropic', ''],
      ['anthropic', 'Custom Claude'],
      ['openai', ''],
      ['openai', 'Custom GPT'],
    ]) {
      const created = await request(gw, 'POST', `/api/admin/vendors/accounts?vendor_id=${vendorId}`, admin.cookie, {
        name,
        platform,
        proxy_endpoint: '127.0.0.1:4555:test:example',
        group_ids: [platform === 'openai' ? codexGroup.json.data.item.id : group.json.data.item.id],
      })
      assert.equal(created.status, 201, JSON.stringify(created.json))
      const vmId = created.json.data.vm.config.runtime_vm_id
      const imported = await request(
        gw,
        'POST',
        '/api/panel/vms/import',
        admin.cookie,
        platform === 'openai'
          ? {
              vm_id: vmId,
              type: 'codex',
              mode: 'json',
              auth_json: JSON.stringify({
                access_token: 'at-test',
                email: 'gpt@example.test',
                chatgpt_account_id: vmId,
              }),
            }
          : { vm_id: vmId, sessionKey: 'sk-ant-sid01-FAKE-TEST' },
      )
      assert.equal(imported.status, 200, JSON.stringify(imported.json))
      const listed = await request(gw, 'GET', `/api/admin/vendors/accounts?vendor_id=${vendorId}`, admin.cookie)
      const row = listed.json.data.find((r) => r.id === created.json.data.account.id)
      assert.equal(row.name, name || (platform === 'openai' ? 'gpt@example.test' : 'fake-oauth@kin.test'))
      assert.equal(row.config.name_from_authorization, undefined)
    }
  } finally {
    await gw.stop()
  }
})
