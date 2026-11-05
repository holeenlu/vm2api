import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { GroupsRepo } from '../../src/lib/db/repos/groups-repo.mjs'
import { getVm, patchVmRecord } from '../../src/lib/vm/vm-registry.mjs'
import { atomicWriteJson } from '../../src/lib/vm/vm-file.mjs'
import { createVmBulkEditService } from '../../src/lib/admin/vm-bulk-edit.mjs'
import { createPanelVmBulkRoutes } from '../../src/lib/admin/panel-vm-bulk-routes.mjs'
import { createRoutingRuntime } from '../../src/lib/admin/routing-runtime.mjs'
import { authorizePanelRoute } from '../../src/lib/admin/capability-policy.mjs'

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-bulk-test-'))
  const db = createDatabase({ dataDir: root })
  t.after(() => {
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  fs.mkdirSync(path.join(root, 'vms'))
  for (const [id, platform] of [
    ['gpt-1', 'openai'],
    ['gpt-2', 'openai'],
    ['claude-1', 'anthropic'],
  ])
    atomicWriteJson(path.join(root, 'vms', `${id}.json`), {
      id,
      name: id,
      platform,
      status: 'running',
      policy: {},
      schedule_off: false,
    })
  const calls = []
  const runtime = createRoutingRuntime({
    cfg: { paths: { project: root } },
    routingConfig: { codex: { quota: { max_concurrency: 2, max_rpm: 0 } } },
    accountQuota: {
      setMaxConcurrency: (...x) => calls.push(x),
      setMaxRpm: (...x) => calls.push(x),
      repo: { get: () => null },
    },
  })
  const options = { db, project: root, ...runtime }
  const svc = createVmBulkEditService(options)
  const groups = new GroupsRepo(db),
    group = groups.create({ name: 'OpenAI bulk', platform: 'openai' })
  const command = (patch, ids = ['gpt-1', 'gpt-2']) => ({
    operation_id: randomUUID(),
    items: svc.snapshot(ids).items,
    patch,
  })
  return { root, db, svc, groups, group, command, options, calls }
}
test('mixed platform updates persist, omit unchecked fields and retain receipts across reopen', (t) => {
  const { root, db, svc, command, options } = setup(t)
  const cmd = command({ max_concurrency: 4, max_rpm: 60, weight: 7, schedule_level: 3 }, ['gpt-1', 'claude-1'])
  const result = svc.save(cmd, 'admin')
  assert.equal(result.status, 'complete')
  assert.equal(result.items[0].fields.schedule_level.status, 'not_applicable')
  assert.equal(result.items[1].fields.weight.status, 'not_applicable')
  assert.equal(getVm(root, 'gpt-1').policy.weight, 7)
  assert.equal(getVm(root, 'claude-1').policy.priority, 3)
  assert.equal(getVm(root, 'gpt-2').policy.maxConcurrency, undefined)
  assert.equal(createVmBulkEditService(options).get(cmd.operation_id, 'admin').status, 'complete')
  const other = createDatabase({ dataDir: root })
  assert.equal(JSON.parse(other.prepare('SELECT report_json FROM vm_bulk_edits').get().report_json).status, 'complete')
  other.close()
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM operation_audit WHERE action='vm.bulk_edit'").get().n >= 6)
})
test('replay does not overwrite subsequent edits; operation IDs and actors cannot be reused', (t) => {
  const { root, svc, command } = setup(t),
    cmd = command({ weight: 8 })
  svc.save(cmd, 'admin')
  patchVmRecord(root, 'gpt-1', (v) => ({ policy: { ...v.policy, weight: 9 } }))
  assert.equal(svc.save(cmd, 'admin').status, 'complete')
  assert.equal(getVm(root, 'gpt-1').policy.weight, 9)
  assert.throws(() => svc.save({ ...cmd, patch: { weight: 4 } }, 'admin'), { code: 'operation_conflict' })
  assert.throws(() => svc.get(cmd.operation_id, 'other'), { code: 'forbidden' })
})
test('field conflicts block the entire batch; unrelated telemetry does not', (t) => {
  const { root, svc, command } = setup(t),
    cmd = command({ weight: 8 })
  patchVmRecord(root, 'gpt-2', (v) => ({ policy: { ...v.policy, weight: 2 } }))
  assert.throws(() => svc.save(cmd, 'admin'), { code: 'version_conflict' })
  assert.equal(getVm(root, 'gpt-1').policy.weight, undefined)
  const fresh = command({ weight: 8 })
  patchVmRecord(root, 'gpt-1', { last_seen: 'later' })
  assert.equal(svc.save(fresh, 'admin').status, 'complete')
})
test('group add/remove/replace reuse transactional membership and skip no-op version bumps', (t) => {
  const { svc, command, groups, group } = setup(t)
  svc.save(command({ groups: { operation: 'add', ids: [group.id] } }), 'admin')
  const version = groups.resourceVersion('vm', 'gpt-1')
  svc.save(command({ groups: { operation: 'add', ids: [group.id] } }), 'admin')
  assert.equal(groups.resourceVersion('vm', 'gpt-1'), version)
  const replace = command({ groups: { operation: 'replace', ids: [] } })
  assert.throws(() => svc.save(replace, 'admin'), { code: 'empty_groups_confirmation' })
  assert.equal(svc.save({ ...replace, confirm_empty_groups: true }, 'admin').status, 'complete')
  assert.deepEqual(groups.forResource('vm', 'gpt-1'), [])
  svc.save(command({ groups: { operation: 'add', ids: [group.id] } }), 'admin')
  const remove = command({ groups: { operation: 'remove', ids: [group.id] } })
  assert.throws(() => svc.save(remove, 'admin'), { code: 'empty_groups_confirmation' })
  svc.save({ ...remove, confirm_empty_groups: true }, 'admin')
  assert.deepEqual(groups.forResource('vm', 'gpt-2'), [])
})
test('group/platform/version preflight failures do not write other fields', (t) => {
  const { svc, command, groups, group, root } = setup(t)
  assert.throws(
    () =>
      svc.save(command({ groups: { operation: 'add', ids: [group.id] }, max_concurrency: 5 }, ['claude-1']), 'admin'),
    { code: 'group_platform_mismatch' },
  )
  assert.throws(
    () => svc.save(command({ groups: { operation: 'add', ids: [group.id] } }, ['gpt-1', 'claude-1']), 'admin'),
    { code: 'group_platform_mismatch' },
  )
  const cmd = command({ groups: { operation: 'add', ids: [group.id] }, weight: 8 })
  groups.assignResource('vm', 'gpt-2', [group.id], 0, 'other')
  assert.throws(() => svc.save(cmd, 'admin'), { code: 'version_conflict' })
  assert.equal(getVm(root, 'gpt-1').policy.weight, undefined)
  assert.deepEqual(groups.forResource('vm', 'gpt-1'), [])
})
test('SQLite failure in the second group write rolls back the first, with no policy writes', (t) => {
  const { svc, db, command, group, groups, root } = setup(t)
  db.exec(
    "CREATE TRIGGER reject_second BEFORE INSERT ON group_resources WHEN NEW.resource_id='gpt-2' BEGIN SELECT RAISE(ABORT, 'disk simulation'); END",
  )
  const cmd = command({ groups: { operation: 'add', ids: [group.id] }, weight: 9 })
  assert.equal(svc.save(cmd, 'admin').status, 'incomplete')
  assert.deepEqual(groups.forResource('vm', 'gpt-1'), [])
  assert.equal(getVm(root, 'gpt-1').policy.weight, undefined)
  assert.equal(svc.get(cmd.operation_id, 'admin').items[0].fields.groups.status, 'pending')
  db.exec('DROP TRIGGER reject_second')
  assert.equal(svc.save(cmd, 'admin').status, 'complete')
})
test('a file write followed by runtime failure is reconciled; completed fields are not replayed', (t) => {
  const { root, options, command } = setup(t)
  let fail = true,
    calls = 0
  const svc = createVmBulkEditService({
    ...options,
    applyVmRpm: (...args) => {
      calls++
      const result = options.applyVmRpm(...args)
      if (fail) throw new Error('runtime interrupted')
      return result
    },
  })
  const cmd = command({ max_concurrency: 4, max_rpm: 50 }, ['gpt-1'])
  const first = svc.save(cmd, 'admin')
  assert.equal(first.status, 'incomplete')
  assert.equal(first.items[0].fields.max_concurrency.status, 'saved')
  assert.equal(first.items[0].fields.max_rpm.status, 'writing')
  // A completed field changed independently must not be replayed during retry.
  options.applyVmConcurrency('gpt-1', 6, { override: true })
  fail = false
  assert.equal(svc.save(cmd, 'admin').status, 'complete')
  assert.equal(calls, 2)
  assert.equal(getVm(root, 'gpt-1').policy.maxConcurrency, 6)
})
test('unconfirmed writes refuse to clobber an independent third value', (t) => {
  const { root, options, command } = setup(t)
  const svc = createVmBulkEditService({
    ...options,
    applyVmRpm: (...args) => {
      options.applyVmRpm(...args)
      throw new Error('crash')
    },
  })
  const cmd = command({ max_rpm: 50 }, ['gpt-1'])
  svc.save(cmd, 'admin')
  options.applyVmRpm('gpt-1', 75, { override: true })
  assert.throws(() => svc.save(cmd, 'admin'), { code: 'version_conflict' })
  assert.equal(getVm(root, 'gpt-1').policy.maxRpm, 75)
})
test('inheritance clears pins and uses the current platform defaults', (t) => {
  const { svc, command, root } = setup(t)
  svc.save(command({ max_concurrency: 7, max_rpm: 80, weight: 5 }), 'admin')
  assert.equal(svc.save(command({ max_concurrency: null, max_rpm: null, weight: null }), 'admin').status, 'complete')
  const v = getVm(root, 'gpt-1')
  assert.equal(v.policy.maxConcurrency, 2)
  assert.equal(v.policy.concurrencyOverride, false)
  assert.equal(v.policy.rpmOverride, false)
  assert.equal(v.policy.weight, 1)
})
test('manual scheduling changes preserve restrictions and block archived/revoked supply', (t) => {
  const { svc, command, root } = setup(t)
  patchVmRecord(root, 'gpt-1', {
    schedule_off: true,
    unschedulable: { reason: 'no_credential' },
    schedule_hold: { reason: 'maintenance' },
    cooldown_until: 9999999999999,
  })
  assert.equal(svc.save(command({ schedulable: true }, ['gpt-1']), 'admin').status, 'complete')
  const v = getVm(root, 'gpt-1')
  assert.equal(v.unschedulable.reason, 'no_credential')
  assert.equal(v.schedule_hold.reason, 'maintenance')
  assert.equal(v.cooldown_until, 9999999999999)
  patchVmRecord(root, 'gpt-2', { schedule_off: true, claude: { refresh_error: 'oauth_revoked' } })
  assert.throws(() => svc.save(command({ schedulable: true }, ['gpt-2']), 'admin'), { code: 'credential_unavailable' })
  patchVmRecord(root, 'gpt-2', { vendor_account_resource_id: 'missing' })
  assert.throws(() => svc.snapshot(['gpt-2']), { code: 'resource_archived' })
})
test('unsafe IDs, bad values, missing snapshots and too many targets are rejected', (t) => {
  const { svc, command } = setup(t)
  for (const ids of [['../vms/x'], [], ['gpt-1', 'gpt-1'], Array.from({ length: 501 }, (_, i) => `x-${i}`)])
    assert.throws(() => svc.snapshot(ids))
  for (const patch of [
    { weight: 0 },
    { weight: '3' },
    { max_concurrency: 257 },
    { max_rpm: -1 },
    { schedulable: 1 },
    { unknown: 1 },
    { groups: null },
    {},
  ])
    assert.throws(() => svc.save(command(patch), 'admin'))
  const cmd = command({ weight: 7 })
  delete cmd.items[0].versions
  assert.throws(() => svc.save(cmd, 'admin'), { code: 'snapshot_required' })
})
test('all bulk routes deny admin, user and vendor identities before reading a body', async (t) => {
  const { options } = setup(t)
  for (const role of ['admin', 'user', 'vendor'])
    for (const [method, route] of [
      ['POST', ''],
      ['POST', '/snapshot'],
      ['GET', '/operations/0000000000000000'],
    ]) {
      const url = new URL(`http://localhost/api/panel/vms/bulk-edit${route}`)
      assert.equal(authorizePanelRoute(method, url.pathname, role).ok, false)
      let result
      const handler = createPanelVmBulkRoutes({
        ...options,
        cfg: { paths: { project: options.project } },
        json: (_, status, body) => {
          result = { status, body }
        },
        readBody: () => {
          throw new Error('must not read')
        },
      })
      assert.equal(await handler({ method, panelRole: role }, {}, url), true)
      assert.equal(result.status, 403)
    }
})
test('schema upgrades an existing database and preserves earlier rows', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bulk-upgrade-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dir = path.join(root, 'migrations')
  fs.mkdirSync(dir)
  const source = new URL('../../src/lib/db/migrations/', import.meta.url)
  for (const file of fs.readdirSync(source).filter((f) => f.endsWith('.sql') && !f.startsWith('076_')))
    fs.copyFileSync(new URL(file, source), path.join(dir, file))
  let db = createDatabase({ dataDir: root, migrationsDir: dir })
  const before = db.prepare('SELECT COUNT(*) AS n FROM groups').get().n
  db.close()
  db = createDatabase({ dataDir: root })
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM groups').get().n, before)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vm_bulk_edits').get().n, 0)
  db.close()
})
