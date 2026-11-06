import '../fixtures/kin-computer-test-env.mjs'
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Panel sessions persist under KIN_DATA_DIR at module load; keep them in an owned temp dir.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-resource-perm-data-'))
const previousDataDir = process.env.KIN_DATA_DIR
process.env.KIN_DATA_DIR = dataDir
after(() => {
  if (previousDataDir == null) delete process.env.KIN_DATA_DIR
  else process.env.KIN_DATA_DIR = previousDataDir
  fs.rmSync(dataDir, { recursive: true, force: true })
})

const { createPanelHandler } = await import('../../src/lib/admin/panel-routes.mjs')
const { PanelUserStore } = await import('../../src/lib/admin/panel-users.mjs')
const { openDatabase, closeDatabase } = await import('../../src/lib/db/database.mjs')
const { attachPanelAuth } = await import('../../src/lib/core/security.mjs')
const { writeWorkerCredentialFile } = await import('../../src/lib/oauth/oauth-credentials.mjs')
const { oauthVmPaths } = await import('../../src/lib/oauth/oauth-route-context.mjs')

const SUPER = { apiKeyKind: 'master', panelRole: 'super_admin', panelUser: 'master' }
const admin = (...grants) => ({
  panelUser: 'ops',
  panelRole: 'admin',
  panelUserId: 'u-ops',
  panelResourcePermissions: grants.map((g) => `resources.${g}`),
})
const now = () => new Date().toISOString()

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-resource-perm-'))
  const db = openDatabase({ dataDir: path.join(root, 'data') })
  t.after(() => {
    closeDatabase()
    fs.rmSync(root, { recursive: true, force: true })
  })
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  return { root, db }
}

function seedVm(root, id) {
  fs.mkdirSync(path.join(root, 'vms', id), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'vms', `${id}.json`),
    JSON.stringify({ id, name: id, status: 'stopped', schedulable: false, policy: { maxConcurrency: 2 } }),
  )
}

function seedVendor(db, id, status = 'active') {
  db.prepare(
    `INSERT INTO vendors(id,name,external_code,email,tier,parent_id,root_id,status,platforms_json,created_by,created_at,updated_at)
     VALUES(?,?,?,?,1,NULL,?,?,'["openai","anthropic"]','sa',?,?)`,
  ).run(id, `Vendor ${id}`, id, `${id}@example.test`, id, status, now(), now())
}

function seedResource(db, { id, vendorId, type, config }) {
  db.prepare(
    `INSERT INTO vendor_resources(id,vendor_id,resource_type,name,status,config_json,created_by,created_at,updated_at)
     VALUES(?,?,?,?,'active',?,'sa',?,?)`,
  ).run(id, vendorId, type, id, JSON.stringify(config), now(), now())
}

function call(root, who, method, url, body = {}, extra = {}) {
  const response = {}
  const handlePanel = createPanelHandler({
    cfg: { paths: { project: root }, vm: { id: null } },
    routingConfig: {},
    panelUsers: { repo: { scopeIds: (id) => [id], scopeRootId: (id) => id } },
    proxyPool: { unbindVm() {}, state: { proxies: [] } },
    ...extra,
    requireAuth(req) {
      Object.assign(req, who)
      return true
    },
    json(_res, status, payload) {
      response.status = status
      response.body = payload
      return true
    },
    readBody: async () => body,
  })
  const res = { setHeader() {} }
  return handlePanel({ method, headers: {}, url }, res, new URL(`http://localhost${url}`)).then(() => response)
}

test('admin without grants is refused on every resource route', async (t) => {
  const { root } = fixture(t)
  seedVm(root, 'vm-1')
  const routes = [
    ['GET', '/api/panel/vms'],
    ['PATCH', '/api/panel/vms/vm-1'],
    ['DELETE', '/api/panel/vms/vm-1'],
    ['GET', '/api/panel/vms/vm-1/oauth/credential'],
    ['GET', '/api/panel/codex-accounts'],
    ['PATCH', '/api/panel/codex-accounts/acc-1'],
    ['GET', '/api/admin/vendors'],
    ['GET', '/api/admin/vendors/accounts'],
  ]
  for (const [method, url] of routes) {
    const out = await call(root, admin(), method, url, { active_hours: null })
    assert.equal(out.status, 403, `${method} ${url} ${JSON.stringify(out.body)}`)
  }
})

test('read can list VMs but not edit them; edit can PATCH but not delete or change owner', async (t) => {
  const { root } = fixture(t)
  seedVm(root, 'vm-1')
  const list = await call(root, admin('read'), 'GET', '/api/panel/vms')
  assert.equal(list.status, 200, JSON.stringify(list.body).slice(0, 300))
  assert.deepEqual(
    list.body.data.items.map((vm) => vm.id),
    ['vm-1'],
  )
  assert.equal((await call(root, admin('read'), 'PATCH', '/api/panel/vms/vm-1', { active_hours: null })).status, 403)

  const patched = await call(root, admin('edit'), 'PATCH', '/api/panel/vms/vm-1', { active_hours: null })
  assert.equal(patched.status, 200, JSON.stringify(patched.body).slice(0, 300))
  const owner = await call(root, admin('edit'), 'PATCH', '/api/panel/vms/vm-1', {
    active_hours: null,
    vendor_id: 'v-x',
  })
  assert.equal(owner.status, 403)
  assert.equal(owner.body.error.code, 'resource_manage_required')
  assert.equal((await call(root, admin('edit'), 'DELETE', '/api/panel/vms/vm-1')).status, 403)
  assert.equal((await call(root, admin('edit'), 'POST', '/api/panel/vms/vm-1/shell-ticket')).status, 403)
  assert.equal((await call(root, admin('edit'), 'GET', '/api/panel/vms/vm-1/package')).status, 403)
  assert.ok(fs.existsSync(path.join(root, 'vms', 'vm-1.json')))

  const removed = await call(root, admin('manage'), 'DELETE', '/api/panel/vms/vm-1')
  assert.equal(removed.status, 200, JSON.stringify(removed.body))
  assert.equal(fs.existsSync(path.join(root, 'vms', 'vm-1.json')), false)
})

test('credential plaintext export is manage-only; super_admin unchanged', async (t) => {
  const { root } = fixture(t)
  seedVm(root, 'vm-1')
  writeWorkerCredentialFile(oauthVmPaths(root, 'vm-1').homeDir, {
    access_token: 'sk-ant-oat01-PLAINTEXT-AT',
    refresh_token: 'sk-ant-ort01-PLAINTEXT-RT',
    expires_at: Date.now() + 3600_000,
  })
  const url = '/api/panel/vms/vm-1/oauth/credential'
  const edit = await call(root, admin('edit'), 'GET', url)
  assert.equal(edit.status, 200, JSON.stringify(edit.body))
  assert.equal(edit.body.data.export, null)
  assert.equal(edit.body.data.export_redacted, true)
  assert.equal(edit.body.data.has_token, true)
  assert.doesNotMatch(JSON.stringify(edit.body), /PLAINTEXT/)
  for (const who of [admin('manage'), SUPER]) {
    const out = await call(root, who, 'GET', url)
    assert.equal(out.status, 200)
    assert.match(JSON.stringify(out.body.data.export), /PLAINTEXT-AT/)
    assert.equal(out.body.data.export_redacted, undefined)
  }
})

test('supplier-owned VM follows the account-pool vendor rules from the VM page', async (t) => {
  const { root, db } = fixture(t)
  seedVm(root, 'vm-sup')
  seedVm(root, 'vm-own')
  seedVendor(db, 'v-paused', 'disabled')
  seedResource(db, { id: 'res-vm', vendorId: 'v-paused', type: 'vm', config: { runtime_vm_id: 'vm-sup' } })
  for (const method of ['PATCH', 'DELETE']) {
    const out = await call(root, SUPER, method, '/api/panel/vms/vm-sup', { active_hours: null })
    assert.equal(out.status, 409, `${method} ${JSON.stringify(out.body)}`)
    assert.equal(out.body.error.code, 'vendor_inactive')
  }
  assert.ok(fs.existsSync(path.join(root, 'vms', 'vm-sup.json')))
  // 平台自有 VM 不受供应商规则影响
  const own = await call(root, SUPER, 'PATCH', '/api/panel/vms/vm-own', { active_hours: null })
  assert.equal(own.status, 200, JSON.stringify(own.body).slice(0, 300))
})

test('Codex account routes follow resource levels and supplier rules', async (t) => {
  const { root, db } = fixture(t)
  seedVendor(db, 'v-active')
  seedVendor(db, 'v-paused', 'disabled')
  const gateway = { execution_kind: 'gateway_worker', platform: 'openai', group_ids: [] }
  seedResource(db, { id: 'acc-paused', vendorId: 'v-paused', type: 'account', config: gateway })
  seedResource(db, { id: 'acc-active', vendorId: 'v-active', type: 'account', config: gateway })

  const list = await call(root, admin('read'), 'GET', '/api/panel/codex-accounts')
  assert.equal(list.status, 200, JSON.stringify(list.body))
  assert.equal((await call(root, admin('read'), 'PATCH', '/api/panel/codex-accounts/acc-active', {})).status, 403)
  assert.equal((await call(root, admin('manage'), 'GET', '/api/panel/gateway-workers')).status, 403)
  assert.equal((await call(root, admin('edit'), 'POST', '/api/panel/codex-accounts/export', {})).status, 403)

  const archive = await call(root, admin('edit'), 'PATCH', '/api/panel/codex-accounts/acc-active', {
    status: 'archived',
  })
  assert.equal(archive.status, 403)
  assert.equal(archive.body.error.code, 'resource_manage_required')

  const paused = await call(root, SUPER, 'PATCH', '/api/panel/codex-accounts/acc-paused', { name: 'renamed' })
  assert.equal(paused.status, 409, JSON.stringify(paused.body))
  assert.equal(paused.body.error.code, 'vendor_inactive')
  // 供应商状态校验与供应商 VM 一致；调度参数（权重、并发）仍由平台运营调整，不套账号池字段白名单。
  const fields = await call(root, admin('edit'), 'PATCH', '/api/panel/codex-accounts/acc-active', { weight: 3 })
  assert.notEqual(fields.status, 403, JSON.stringify(fields.body))
  assert.notEqual(fields.body?.error?.code, 'invalid_resource_patch')
})

test('granted admins reach only the supplier account-pool admin paths', async (t) => {
  const { root, db } = fixture(t)
  seedVendor(db, 'v-active')
  seedResource(db, {
    id: 'acc-pool',
    vendorId: 'v-active',
    type: 'account',
    config: { execution_kind: 'gateway_worker', platform: 'openai', group_ids: [] },
  })
  const vendors = await call(root, admin('read'), 'GET', '/api/admin/vendors')
  assert.equal(vendors.status, 200, JSON.stringify(vendors.body))
  assert.deepEqual(Object.keys(vendors.body.data[0]).sort(), [
    'effective_platforms',
    'id',
    'name',
    'parent_id',
    'platforms',
    'status',
  ])
  const full = await call(root, SUPER, 'GET', '/api/admin/vendors')
  assert.ok('members' in full.body.data[0])
  assert.equal((await call(root, admin('manage'), 'GET', '/api/admin/vendors/settlements')).status, 403)
  assert.equal((await call(root, admin('manage'), 'POST', '/api/admin/vendors', {})).status, 403)
  const archive = await call(root, admin('edit'), 'PATCH', '/api/admin/vendors/accounts/acc-pool', {
    status: 'archived',
  })
  assert.equal(archive.status, 403, JSON.stringify(archive.body))
  assert.equal(archive.body.error.code, 'forbidden')
  assert.equal(archive.body.error.message, '归档账号需要资源管理权限')
})

test('only super_admin grants resource permissions, and only to admins', async (t) => {
  const { root, db } = fixture(t)
  const panelUsers = new PanelUserStore({ db })
  const sa = await panelUsers.create({ username: 'boss', password: 'boss-pass-1', role: 'super_admin' })
  const extra = { panelUsers }
  const created = await call(
    root,
    SUPER,
    'POST',
    '/api/panel/users',
    { username: 'ops1', password: 'ops-pass-1', role: 'admin', resource_permissions: ['resources.edit'] },
    extra,
  )
  assert.equal(created.status, 201, JSON.stringify(created.body))
  assert.deepEqual(created.body.data.item.resource_permissions, ['resources.read', 'resources.edit'])

  const toUser = await call(
    root,
    SUPER,
    'POST',
    '/api/panel/users',
    { username: 'u1', password: 'user-pass-1', role: 'user', resource_permissions: ['resources.read'] },
    extra,
  )
  assert.equal(toUser.status, 400)
  assert.equal(toUser.body.error.code, 'invalid_resource_permissions')

  const actor = { panelUser: 'ops1', panelRole: 'admin', panelUserId: created.body.data.item.id }
  const byAdmin = await call(
    root,
    actor,
    'POST',
    '/api/panel/users',
    { username: 'ops2', password: 'ops-pass-2', role: 'admin', resource_permissions: [] },
    extra,
  )
  assert.equal(byAdmin.status, 403)

  const plain = await panelUsers.create({ username: 'plain', password: 'user-pass-2', role: 'user' })
  const demote = await call(
    root,
    SUPER,
    'PATCH',
    `/api/panel/users/${plain.id}`,
    { resource_permissions: ['resources.read'] },
    extra,
  )
  assert.equal(demote.status, 400)
  assert.equal(demote.body.error.code, 'invalid_resource_permissions')
  assert.ok(sa.id)
})

test('login response carries the granted resource permissions', async (t) => {
  const { root, db } = fixture(t)
  const panelUsers = new PanelUserStore({ db })
  await panelUsers.create({
    username: 'ops',
    password: 'ops-pass-1',
    role: 'admin',
    resource_permissions: ['resources.read'],
  })
  attachPanelAuth({ authenticate: async (u, p) => panelUsers.authenticate(u, p) })
  t.after(() => attachPanelAuth({}))
  const out = await call(
    root,
    {},
    'POST',
    '/api/panel/login',
    { username: 'ops', password: 'ops-pass-1' },
    {
      panelUsers,
    },
  )
  assert.equal(out.status, 200, JSON.stringify(out.body))
  assert.deepEqual(out.body.resource_permissions, ['resources.read'])
  assert.ok(out.body.views.includes('vm'))
  assert.ok(out.body.capabilities.includes('resources.read'))
})
