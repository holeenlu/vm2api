import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { reloadActiveVm } from '../../src/lib/core/config.mjs'
import { getVm } from '../../src/lib/vm/vm-registry.mjs'
import { readCodexAccounts, writeCodexAccounts } from '../../src/lib/vm/codex-slot.mjs'
import { invalidateReadCache } from '../../src/lib/vm/vm-file.mjs'

function seed(root, id, { active = false } = {}) {
  const dir = path.join(root, 'vms')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({ id, name: id, status: 'stopped', schedulable: false, policy: { maxConcurrency: 2 } }),
  )
  if (active) fs.writeFileSync(path.join(dir, 'active.json'), JSON.stringify({ active_vm: id }))
}

function handler(project) {
  const response = {}
  const cfg = { paths: { project }, vm: { id: 'stale' } }
  const handlePanel = createPanelHandler({
    cfg,
    requireAuth(req) {
      req.apiKeyKind = 'master'
      req.panelRole = 'super_admin'
      return true
    },
    json(_res, status, payload) {
      response.status = status
      response.body = payload
      return true
    },
    readBody: async () => ({}),
    proxyPool: { unbindVm() {} },
  })
  return { handlePanel, response, cfg }
}

test('fresh deploy can delete its only active VM', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-del-only-'))
  try {
    seed(root, 'vm-01', { active: true })
    const { handlePanel, response, cfg } = handler(root)
    await handlePanel({ method: 'DELETE' }, {}, new URL('http://localhost/api/panel/vms/vm-01'))
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.equal(response.body?.data?.deleted, 'vm-01')
    assert.equal(fs.existsSync(path.join(root, 'vms', 'vm-01.json')), false)
    assert.equal(fs.existsSync(path.join(root, 'vms', 'active.json')), false)
    reloadActiveVm(cfg)
    assert.equal(cfg.vm.id, null)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('active VM stays when another slot exists', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-del-active-'))
  try {
    seed(root, 'vm-01', { active: true })
    seed(root, 'vm-02')
    const { handlePanel, response } = handler(root)
    await handlePanel({ method: 'DELETE' }, {}, new URL('http://localhost/api/panel/vms/vm-01'))
    assert.equal(response.status, 409)
    assert.match(response.body?.error?.message, /switch active first/)
    assert.equal(fs.existsSync(path.join(root, 'vms', 'vm-01.json')), true)
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'vms', 'active.json'), 'utf8')).active_vm, 'vm-01')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('non-active VM deletes while the active pointer stays', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-del-other-'))
  try {
    seed(root, 'vm-01', { active: true })
    seed(root, 'vm-02')
    const { handlePanel, response } = handler(root)
    await handlePanel({ method: 'DELETE' }, {}, new URL('http://localhost/api/panel/vms/vm-02'))
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.equal(fs.existsSync(path.join(root, 'vms', 'vm-02.json')), false)
    assert.equal(fs.existsSync(path.join(root, 'vms', 'vm-01.json')), true)
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'vms', 'active.json'), 'utf8')).active_vm, 'vm-01')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('startup reconcile does not resurrect a deleted sole active VM', async () => {
  const { openDatabase, closeDatabase } = await import('../../src/lib/db/database.mjs')
  const { initVmDbSync, stopVmWatch, reconcileVms } = await import('../../src/lib/vm/vm-db-sync.mjs')
  const { setVmWriteHook } = await import('../../src/lib/vm/vm-file.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-del-db-'))
  try {
    openDatabase({ dataDir: path.join(root, 'data') })
    seed(root, 'vm-01', { active: true })
    await initVmDbSync(root, { watch: false })
    const { handlePanel, response } = handler(root)
    await handlePanel({ method: 'DELETE' }, {}, new URL('http://localhost/api/panel/vms/vm-01'))
    assert.equal(response.status, 200, JSON.stringify(response.body))
    const again = await reconcileVms(root)
    assert.equal(again.rebuilt, 0)
    assert.equal(again.active, null)
    assert.equal(fs.existsSync(path.join(root, 'vms', 'vm-01.json')), false)
    assert.equal(fs.existsSync(path.join(root, 'vms', 'active.json')), false)
  } finally {
    stopVmWatch()
    setVmWriteHook(null)
    await closeDatabase()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('deleting a slot drops cached record and credential entries', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-del-cache-'))
  try {
    seed(root, 'vm-02')
    fs.mkdirSync(path.join(root, 'vms', 'vm-02'), { recursive: true })
    writeCodexAccounts(root, 'vm-02', [{ access_token: 'stay-secret' }])
    const recPath = path.join(root, 'vms', 'vm-02.json')
    const credPath = path.join(root, 'vms', 'vm-02', 'codex-credentials.json')
    assert.equal(getVm(root, 'vm-02').id, 'vm-02')
    assert.equal(readCodexAccounts(root, 'vm-02')[0].access_token, 'stay-secret')
    const { handlePanel, response } = handler(root)
    await handlePanel({ method: 'DELETE' }, {}, new URL('http://localhost/api/panel/vms/vm-02'))
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.equal(invalidateReadCache(recPath), false)
    assert.equal(invalidateReadCache(credPath), false)
    assert.equal(getVm(root, 'vm-02'), null)
    assert.deepEqual(readCodexAccounts(root, 'vm-02'), [])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('deletion clears every group without an API-key store and rejects stale group saves', async () => {
  const { openDatabase, closeDatabase } = await import('../../src/lib/db/database.mjs')
  const { GroupsRepo } = await import('../../src/lib/db/repos/groups-repo.mjs')
  const { VmsRepo } = await import('../../src/lib/db/repos/vms-repo.mjs')
  const { initVmDbSync } = await import('../../src/lib/vm/vm-db-sync.mjs')
  const { setVmWriteHook } = await import('../../src/lib/vm/vm-file.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-del-groups-'))
  try {
    const db = openDatabase({ dataDir: path.join(root, 'data') })
    seed(root, 'vm-02')
    seed(root, 'vm-03')
    await initVmDbSync(root, { watch: false })
    const groups = new GroupsRepo(db)
    const first = await groups.create({ name: 'first' })
    const second = await groups.create({ name: 'second' })
    await groups.assignResource('vm', 'vm-02', [first.id, second.id], 0)
    await groups.assignResource('vm', 'vm-03', [first.id], 0)
    const before = await groups.getById(first.id)
    const { handlePanel, response } = handler(root)
    await handlePanel({ method: 'DELETE' }, {}, new URL('http://localhost/api/panel/vms/vm-02'))
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.deepEqual(await groups.forResource('vm', 'vm-02'), [])
    assert.deepEqual(await groups.resources(second.id), [])
    assert.deepEqual(
      (await groups.resources(first.id)).map((r) => r.resource_id),
      ['vm-03'],
    )
    assert.equal((await groups.getById(first.id)).version, before.version + 1)
    assert.equal(await groups.resourceVersion('vm', 'vm-02'), 2)
    assert.equal(await new VmsRepo(db).get('vm-02'), null)
    await assert.rejects(() => groups.update(first.id, { expected_version: before.version, name: 'stale' }), /刷新/)
    seed(root, 'vm-02')
    await initVmDbSync(root, { watch: false })
    assert.deepEqual(await groups.forResource('vm', 'vm-02'), [])
    await assert.rejects(() => groups.assignResource('vm', 'vm-02', [second.id], 1), /刷新/)
  } finally {
    setVmWriteHook(null)
    await closeDatabase()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('failed membership cleanup rolls back DB deletion and does not report success', async () => {
  const { openDatabase, closeDatabase } = await import('../../src/lib/db/database.mjs')
  const { GroupsRepo } = await import('../../src/lib/db/repos/groups-repo.mjs')
  const { VmsRepo } = await import('../../src/lib/db/repos/vms-repo.mjs')
  const { initVmDbSync } = await import('../../src/lib/vm/vm-db-sync.mjs')
  const { setVmWriteHook } = await import('../../src/lib/vm/vm-file.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-del-failure-'))
  try {
    const db = openDatabase({ dataDir: path.join(root, 'data') })
    seed(root, 'vm-02')
    await initVmDbSync(root, { watch: false })
    const groups = new GroupsRepo(db)
    const group = await groups.create({ name: 'service' })
    await groups.assignResource('vm', 'vm-02', [group.id], 0)
    db.exec(
      "CREATE TRIGGER fail_cleanup BEFORE DELETE ON group_resources BEGIN SELECT RAISE(ABORT, 'test failure'); END",
    )
    const { handlePanel, response } = handler(root)
    await handlePanel({ method: 'DELETE' }, {}, new URL('http://localhost/api/panel/vms/vm-02'))
    assert.equal(response.status, 500)
    assert.equal(response.body.error.code, 'vm_delete_failed')
    assert.ok(await new VmsRepo(db).get('vm-02'))
    assert.ok(getVm(root, 'vm-02'))
    assert.equal((await groups.resources(group.id)).length, 1)
    assert.equal(await groups.resourceVersion('vm', 'vm-02'), 1)
    db.exec('DROP TRIGGER fail_cleanup')
    await handlePanel({ method: 'DELETE' }, {}, new URL('http://localhost/api/panel/vms/vm-02'))
    assert.equal(response.status, 200)
    assert.deepEqual(await groups.resources(group.id), [])
  } finally {
    setVmWriteHook(null)
    await closeDatabase()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('group reads and copies exclude historical deleted slots while preserving live empty slots', async () => {
  const { openDatabase, closeDatabase } = await import('../../src/lib/db/database.mjs')
  const { GroupsRepo } = await import('../../src/lib/db/repos/groups-repo.mjs')
  const { createRelayHandler } = await import('../../src/lib/admin/relay-routes.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-del-stale-'))
  try {
    const db = openDatabase({ dataDir: path.join(root, 'data') })
    seed(root, 'vm-live')
    const groups = new GroupsRepo(db)
    const group = await groups.create({ name: 'service' })
    await groups.assignResource('vm', 'vm-gone', [group.id], 0)
    await groups.assignResource('vm', 'vm-live', [group.id], 0)
    let response, input
    const handle = createRelayHandler({
      cfg: { paths: { project: root } },
      apiKeyStore: { db },
      json(_res, status, body) {
        response = { status, body }
      },
      readBody: async () => input,
    })
    const call = async (method, suffix = '', body) => {
      input = body
      await handle(
        { method, apiKeyKind: 'master', panelRole: 'super_admin' },
        {},
        new URL('http://localhost/api/panel/groups/' + group.id + suffix),
      )
      assert.equal(response.status, method === 'POST' ? 201 : 200, JSON.stringify(response.body))
      return response.body.data.item
    }
    const view = await call('GET')
    assert.deepEqual(
      view.resources.map((r) => r.resource_id),
      ['vm-live'],
    )
    assert.equal(view.capacity.resources, 1)
    const copy = await call('POST', '/duplicate', { name: 'copy', copy_resources: true })
    assert.deepEqual(
      (await groups.resources(copy.id)).map((r) => r.resource_id),
      ['vm-live'],
    )
    // Reading leaves old data untouched; the existing explicit save replaces membership.
    assert.equal((await groups.resources(group.id)).length, 2)
    const saved = await call('PUT', '/resources', { expected_version: view.version, resources: view.resources })
    assert.equal(saved.resources.length, 1)
    assert.deepEqual(await groups.forResource('vm', 'vm-gone'), [])
  } finally {
    await closeDatabase()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
