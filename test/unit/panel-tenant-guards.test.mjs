import '../fixtures/kin-computer-test-env.mjs'
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

// Panel sessions persist under KIN_DATA_DIR at module load; keep them in an owned temp dir.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-tenant-guards-data-'))
const previousDataDir = process.env.KIN_DATA_DIR
process.env.KIN_DATA_DIR = dataDir
after(() => {
  if (previousDataDir == null) delete process.env.KIN_DATA_DIR
  else process.env.KIN_DATA_DIR = previousDataDir
  fs.rmSync(dataDir, { recursive: true, force: true })
})

const { createPanelHandler } = await import('../../src/lib/admin/panel-routes.mjs')
const { authorizePanelRoute } = await import('../../src/lib/admin/panel-acl.mjs')
const { PanelUserStore } = await import('../../src/lib/admin/panel-users.mjs')
const { openDatabase, closeDatabase } = await import('../../src/lib/db/database.mjs')
const { createPanelSession, verifyPanelSession } = await import('../../src/lib/core/security.mjs')
const { readCodexAccounts, upsertCodexAccount } = await import('../../src/lib/vm/codex-slot.mjs')

const TENANT = { panelUser: 'tenant', panelRole: 'user', panelUserId: 'u-1' }
const ADMIN = { apiKeyKind: 'master', panelRole: 'super_admin' }

function makeProject(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-tenant-guards-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  return root
}

function writeVm(root, vm) {
  fs.mkdirSync(path.join(root, 'vms', vm.id), { recursive: true })
  fs.writeFileSync(path.join(root, 'vms', `${vm.id}.json`), JSON.stringify(vm))
}

function codexVm(root, id, owner) {
  writeVm(root, {
    id,
    platform: 'openai',
    family: 'codex',
    owner_user_id: owner,
    codex: { email: `${id}@example.com`, has_access: true, has_refresh: true },
  })
  upsertCodexAccount(root, id, { email: `${id}@example.com`, access_token: `old-${id}`, refresh_token: 'rt' })
}

function claudeVm(root, id, owner) {
  writeVm(root, { id, platform: 'anthropic', family: 'claude', owner_user_id: owner })
}

function makeHandler(root, who, body, extra = {}) {
  const response = {}
  const handlePanel = createPanelHandler({
    cfg: { paths: { project: root } },
    routingConfig: {},
    panelUsers: { repo: { scopeIds: (id) => [id], scopeRootId: (id) => id } },
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
  const call = (method, url) =>
    handlePanel({ method, headers: {} }, {}, new URL(`http://localhost${url}`)).then(() => response)
  return { call, response }
}

test('commercial customers cannot import credentials into own, foreign or missing slots', async (t) => {
  const root = makeProject(t)
  codexVm(root, 'vm-mine', 'u-1')
  codexVm(root, 'vm-other', 'u-2')
  const body = (vm_id) => ({ vm_id, mode: 'access_token', raw: 'tenant-at' })

  const foreign = await makeHandler(root, TENANT, body('vm-other')).call('POST', '/api/panel/vms/import')
  assert.equal(foreign.status, 403)
  const missing = await makeHandler(root, TENANT, body('vm-nope')).call('POST', '/api/panel/vms/import')
  assert.equal(missing.status, 403)
  assert.deepEqual(foreign.body, missing.body)
  assert.equal(readCodexAccounts(root, 'vm-other')[0].access_token, 'old-vm-other')

  const own = await makeHandler(root, TENANT, body('vm-mine')).call('POST', '/api/panel/vms/import')
  assert.equal(own.status, 403, JSON.stringify(own.body))
  assert.equal(readCodexAccounts(root, 'vm-mine')[0].access_token, 'old-vm-mine')
})

test('admin import still reaches any slot', async (t) => {
  const root = makeProject(t)
  codexVm(root, 'vm-other', 'u-2')
  const out = await makeHandler(root, ADMIN, { vm_id: 'vm-other', mode: 'access_token', raw: 'admin-at' }).call(
    'POST',
    '/api/panel/vms/import',
  )
  assert.equal(out.status, 200, JSON.stringify(out.body))
  assert.equal(readCodexAccounts(root, 'vm-other')[0].access_token, 'admin-at')
})

test('tenant proxy import cannot bind a slot it does not own', async (t) => {
  const root = makeProject(t)
  claudeVm(root, 'vm-other', 'u-2')
  const calls = []
  const proxyPool = {
    importLines(...args) {
      calls.push(['import', ...args])
      return { items: [{ id: 'px-1' }] }
    },
    bind(...args) {
      calls.push(['bind', ...args])
      return { ok: false, error: 'stub' }
    },
  }
  const tenant = await makeHandler(root, TENANT, { text: 'h:1080', bind_vm_id: 'vm-other' }, { proxyPool }).call(
    'POST',
    '/api/panel/proxies/import',
  )
  assert.equal(tenant.status, 403)
  assert.deepEqual(calls, [])

  const admin = await makeHandler(root, ADMIN, { text: 'h:1080', bind_vm_id: 'vm-other' }, { proxyPool }).call(
    'POST',
    '/api/panel/proxies/import',
  )
  assert.equal(admin.status, 200, JSON.stringify(admin.body))
  assert.deepEqual(
    calls.map((c) => c[0]),
    ['import', 'bind'],
  )
})

function usersFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-tenant-guards-users-'))
  const db = openDatabase({ dataDir: dir })
  t.after(() => {
    closeDatabase()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const panelUsers = new PanelUserStore({ db })
  panelUsers.create({ username: 'boss', password: 'boss-pass-1', role: 'super_admin' })
  return panelUsers
}

test('changing a user role or disabling it ends that user panel sessions', async (t) => {
  const panelUsers = usersFixture(t)
  const root = makeProject(t)
  for (const [i, patch] of [{ role: 'admin' }, { enabled: false }].entries()) {
    const user = panelUsers.create({ username: `tenant${i}`, password: 'tenant-pass', role: 'user' })
    const token = createPanelSession(user.username, { role: 'user' })
    const other = createPanelSession('boss', { role: 'super_admin' })
    const out = await makeHandler(root, ADMIN, patch, { panelUsers }).call('PATCH', `/api/panel/users/${user.id}`)
    assert.equal(out.status, 200, JSON.stringify(out.body))
    assert.equal(verifyPanelSession(token), null, JSON.stringify(patch))
    assert.equal(verifyPanelSession(other)?.user, 'boss')
  }
})

test('unrelated user edits keep sessions alive', async (t) => {
  const panelUsers = usersFixture(t)
  const root = makeProject(t)
  const user = panelUsers.create({ username: 'quota', password: 'tenant-pass', role: 'user' })
  const token = createPanelSession(user.username, { role: 'user' })
  const out = await makeHandler(root, ADMIN, { concurrency: 3, role: 'user', enabled: true }, { panelUsers }).call(
    'PATCH',
    `/api/panel/users/${user.id}`,
  )
  assert.equal(out.status, 200, JSON.stringify(out.body))
  assert.equal(verifyPanelSession(token)?.user, 'quota')
})

test('only SA can inspect slot test models', () => {
  for (const role of ['user', 'admin'])
    assert.equal(authorizePanelRoute('GET', '/api/panel/test-models', role).ok, false)
  assert.equal(authorizePanelRoute('GET', '/api/panel/test-models', 'super_admin').ok, true)
})

test('customers cannot inspect slot models; operators cannot force live catalog refresh', async (t) => {
  const root = makeProject(t)
  // A listener standing in for the slot SOCKS5: any connection means a live catalog refresh ran.
  let dials = 0
  const socks = net.createServer((socket) => {
    dials += 1
    socket.destroy()
  })
  await new Promise((resolve) => socks.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => socks.close(resolve)))
  const proxy = { host: '127.0.0.1', port: socks.address().port }
  for (const [id, owner] of [
    ['vm-mine', 'u-1'],
    ['vm-other', 'u-2'],
  ]) {
    codexVm(root, id, owner)
    const file = path.join(root, 'vms', `${id}.json`)
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), proxy }))
  }
  // Fresh catalog-version cache so a refresh never reaches the public registry.
  fs.writeFileSync(
    path.join(dataDir, 'codex-catalog-client.json'),
    JSON.stringify({ version: '0.160.0', fetched_at: new Date().toISOString() }),
  )

  const own = await makeHandler(root, TENANT, null).call('GET', '/api/panel/test-models?vm_id=vm-mine&refresh=1')
  assert.equal(own.status, 403, JSON.stringify(own.body))
  assert.equal(dials, 0)

  const foreign = await makeHandler(root, TENANT, null).call('GET', '/api/panel/test-models?vm_id=vm-other')
  assert.equal(foreign.status, 403)
  const missing = await makeHandler(root, TENANT, null).call('GET', '/api/panel/test-models?vm_id=vm-nope')
  assert.deepEqual(foreign.body, missing.body)

  const superUser = { panelUser: 'ops', panelRole: 'admin', panelUserId: 'u-9' }
  const sup = await makeHandler(root, superUser, null).call('GET', '/api/panel/test-models?vm_id=vm-other&refresh=1')
  assert.equal(sup.status, 403)
  assert.equal(dials, 0)

  const admin = await makeHandler(root, ADMIN, null).call('GET', '/api/panel/test-models?vm_id=vm-other&refresh=1')
  assert.equal(admin.status, 200)
  assert.ok(dials > 0, 'admin refresh still goes live')
})
