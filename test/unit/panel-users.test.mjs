import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import {
  PanelUserStore,
  hashPassword,
  verifyPassword,
  publicUserView,
  isPanelUsername,
} from '../../src/lib/admin/panel-users.mjs'

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-panel-users-'))
  const db = createDatabase({ dataDir: dir })
  return { dir, db, store: new PanelUserStore({ db, projectRoot: dir }) }
}

test('scrypt hash verifies and is not reversible', () => {
  const hashed = hashPassword('correct-horse')
  assert.match(hashed, /^scrypt\$/)
  assert.equal(verifyPassword('correct-horse', hashed), true)
  assert.equal(verifyPassword('wrong-pass', hashed), false)
  assert.doesNotMatch(hashed, /correct-horse/)
})

test('email usernames preserve login, duplicate, password-change and disable behavior', async (t) => {
  const { store, db, dir } = tmpStore()
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const username = '123.customer+tag@long-example-domain.test'
  const user = await store.create({ username: ` ${username} `, password: 'email-user-pass' })
  assert.equal(user.username, username)
  assert.equal((await store.authenticate(username.toUpperCase(), 'email-user-pass')).id, user.id)
  await assert.rejects(() => store.create({ username: username.toUpperCase(), password: 'another-pass' }), {
    code: 'username_exists',
  })
  await store.update(user.id, { password: 'email-user-next' })
  assert.equal(await store.authenticate(username, 'email-user-pass'), null)
  assert.equal((await store.authenticate(username, 'email-user-next')).id, user.id)
  await store.update(user.id, { enabled: false })
  assert.equal(await store.authenticate(username, 'email-user-next'), null)
})

test('username validation accepts email boundaries and rejects malformed addresses', () => {
  const maxEmail = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`
  assert.equal(maxEmail.length, 254)
  for (const name of ['ab', 'a'.repeat(32), 'user.name_1-2', '123+tag@example.test', maxEmail]) {
    assert.equal(isPanelUsername(name), true, name)
  }
  for (const name of [
    'a',
    '1bad',
    'a'.repeat(33),
    '@example.test',
    'a@@example.test',
    'a@example',
    'a b@example.test',
    '.a@example.test',
    'a..b@example.test',
    'a.@example.test',
    'a@-example.test',
    'a@example-.test',
    'a@example..test',
    `${'a'.repeat(65)}@example.test`,
    `${maxEmail}e`,
  ]) {
    assert.equal(isPanelUsername(name), false, name)
  }
})

test('bootstrap seeds env admin once', async () => {
  const { store } = tmpStore()
  const first = await store.bootstrapFromEnv({ username: 'admin', password: 'testpass1' })
  const second = await store.bootstrapFromEnv({ username: 'admin', password: 'otherpass' })
  assert.equal(first.username, 'admin')
  assert.equal(first.role, 'super_admin')
  assert.equal(second.id, first.id)
  assert.ok(await store.authenticate('admin', 'testpass1'))
  assert.equal(await store.authenticate('admin', 'otherpass'), null)
})

test('bootstrap imports legacy env passwords without relaxing user password validation', async () => {
  const { store } = tmpStore()
  for (const [username, password] of [
    ['admin', '123456'],
    ['legacy', 'short'],
  ]) {
    const admin = await store.bootstrapFromEnv({ username, password })
    assert.equal(admin.role, 'super_admin')
    assert.equal(admin.enabled, true)
    assert.equal(admin.password_hash, undefined)
    assert.ok((await store.list()).some((user) => user.id === admin.id))
    assert.ok(await store.authenticate(username, password))
    assert.notEqual((await store.getById(admin.id)).password_hash, password)
    await assert.rejects(() => store.update(admin.id, { password: 'short' }), /密码至少 8 位/)

    await store.update(admin.id, { password: 'changed-admin-pass' })
    const again = await store.bootstrapFromEnv({ username, password })
    assert.equal(again.id, admin.id)
    assert.equal(await store.authenticate(username, password), null)
    assert.ok(await store.authenticate(username, 'changed-admin-pass'))
  }
  await assert.rejects(() => store.create({ username: 'reader', password: '123456' }), /密码至少 8 位/)
})

test('bootstrap preserves disabled admins and validates usernames', async () => {
  const { store } = tmpStore()
  await store.create({ username: 'owner', password: 'owner-pass', role: 'super_admin' })
  const admin = await store.create({ username: 'admin', password: 'admin-pass', role: 'super_admin', enabled: false })
  const imported = await store.bootstrapFromEnv({ username: 'admin', password: '123456' })
  assert.equal(imported.id, admin.id)
  assert.equal(imported.enabled, false)
  assert.equal(await store.authenticate('admin', '123456'), null)
  assert.equal(await store.bootstrapFromEnv({ username: 'empty', password: '' }), null)
  await assert.rejects(() => store.bootstrapFromEnv({ username: '1bad', password: '123456' }), /用户名/)
})

test('create / authenticate / change password / roles', async () => {
  const { store } = tmpStore()
  await store.bootstrapFromEnv({ username: 'admin', password: 'adminpass' })
  const viewer = await store.create({ username: 'reader', password: 'reader-pass', role: 'user' })
  const superu = await store.create({ username: 'ops', password: 'super-pass', role: 'admin' })
  assert.equal(viewer.role, 'user')
  assert.equal(superu.role, 'admin')
  assert.equal((await store.authenticate('reader', 'reader-pass')).role, 'user')
  assert.equal(await store.authenticate('ops', 'wrong-pass'), null)

  const updated = await store.update(viewer.id, { password: 'reader-next' })
  assert.equal(await store.authenticate('reader', 'reader-pass'), null)
  assert.ok(await store.authenticate('reader', 'reader-next'))
  assert.equal(publicUserView(updated).password_hash, undefined)
})

test('administrator branches share the root administrator data domain', async () => {
  const { store } = tmpStore()
  const root = await store.create({ username: 'root', password: 'root-pass', role: 'super_admin' })
  const first = await store.create({ username: 'first', password: 'first-pass', role: 'admin', actorId: root.id })
  const second = await store.create({ username: 'second', password: 'second-pass', role: 'admin', actorId: first.id })
  const child = await store.create({ username: 'child', password: 'child-pass', role: 'admin', actorId: first.id })
  const granduser = await store.create({
    username: 'granduser',
    password: 'granduser-pass',
    role: 'user',
    actorId: child.id,
  })
  const own = await store.create({ username: 'ownuser', password: 'ownuser-pass', role: 'user', actorId: first.id })
  const branchB = await store.create({ username: 'branchb', password: 'branchb-pass', role: 'admin', actorId: root.id })
  const foreign = await store.create({
    username: 'foreign',
    password: 'foreign-pass',
    role: 'user',
    actorId: branchB.id,
  })

  assert.deepEqual((await store.list({ actorId: first.id, role: 'admin' })).map((row) => row.username).sort(), [
    'child',
    'granduser',
    'ownuser',
    'second',
  ])
  assert.equal(await store.canAccess(granduser.id, { actorId: first.id, role: 'admin' }), true)
  assert.equal(await store.canAccess(foreign.id, { actorId: first.id, role: 'admin' }), false)
  assert.deepEqual((await store.list({ actorId: second.id, role: 'admin' })).map((row) => row.username).sort(), [
    'child',
    'first',
    'granduser',
    'ownuser',
  ])
})

test('cannot remove or demote the last admin', async () => {
  const { store } = tmpStore()
  const admin = await store.create({ username: 'admin', password: 'adminpass', role: 'super_admin' })
  await assert.rejects(() => store.update(admin.id, { role: 'user' }), /最后一个管理员/)
  await assert.rejects(() => store.update(admin.id, { enabled: false }), /最后一个管理员/)
  await assert.rejects(() => store.remove(admin.id), /最后一个管理员/)
})

test('rejects bad username / short password / unknown role', async () => {
  const { store } = tmpStore()
  await assert.rejects(() => store.create({ username: '1bad', password: 'longenough', role: 'user' }), /用户名/)
  await assert.rejects(() => store.create({ username: 'okuser', password: 'short', role: 'user' }), /密码/)
  await assert.rejects(() => store.create({ username: 'okuser', password: 'longenough', role: 'root' }), /角色/)
})

function seedOwnedVm(project, id, owner, extra = {}) {
  const dir = path.join(project, 'vms')
  fs.mkdirSync(dir, { recursive: true })
  const vm = {
    id,
    owner_user_id: owner,
    origin: 'admin_assigned',
    status: 'running',
    schedulable: false,
    schedule_disabled_reason: 'disabled',
    claude: { has_access: true, has_refresh: true },
    ...extra,
  }
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(vm))
  return vm
}

test('deleting a customer preserves infrastructure provenance and does not publish private slots', async (t) => {
  const { dir, db, store } = tmpStore()
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const user = await store.create({ username: 'tenant', password: 'tenant-pass' })
  const assigned = seedOwnedVm(dir, 'assigned', user.id)
  seedOwnedVm(dir, 'legacy', user.id, { origin: undefined })
  const privateVm = seedOwnedVm(dir, 'private', user.id, { origin: 'user_created' })
  const otherVm = seedOwnedVm(dir, 'other', 'another-tenant')
  const publicVm = seedOwnedVm(dir, 'public', null, { origin: 'platform' })

  assert.equal(await store.remove(user.id), true)
  assert.equal(await store.getById(user.id), null)
  const read = (id) => JSON.parse(fs.readFileSync(path.join(dir, 'vms', `${id}.json`), 'utf8'))
  const reclaimed = read('assigned')
  assert.deepEqual(reclaimed, assigned)
  assert.equal(read('legacy').owner_user_id, user.id)
  assert.deepEqual(read('private'), privateVm)
  assert.deepEqual(read('other'), otherVm)
  assert.deepEqual(read('public'), publicVm)
})

test('rejected user deletions leave assigned VMs with their owners', async (t) => {
  const { dir, db, store } = tmpStore()
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const admin = await store.create({ username: 'admin', password: 'admin-pass', role: 'super_admin' })
  const user = await store.create({ username: 'tenant', password: 'tenant-pass' })
  const assigned = seedOwnedVm(dir, 'assigned', user.id)
  const adminVm = seedOwnedVm(dir, 'admin-vm', admin.id)

  await assert.rejects(() => store.remove(user.id, { actorId: user.id }), /不能删除当前登录账号/)
  await assert.rejects(() => store.remove(admin.id), /最后一个管理员/)
  assert.equal(await store.remove('missing-user'), false)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'vms', 'assigned.json'), 'utf8')), assigned)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'vms', 'admin-vm.json'), 'utf8')), adminVm)
})

test('customer deletion never writes VM files', async (t) => {
  const { dir, db, store } = tmpStore()
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const user = await store.create({ username: 'tenant', password: 'tenant-pass' })
  const assigned = seedOwnedVm(dir, 'assigned', user.id)
  t.mock.method(fs, 'renameSync', () => {
    throw new Error('simulated VM write failure')
  })

  assert.equal(await store.remove(user.id), true)
  assert.equal(await store.getById(user.id), null)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'vms', 'assigned.json'), 'utf8')), assigned)
})

test('company is per user, inherited from administrator creators and listed with the creator', async (t) => {
  const { store, db, dir } = tmpStore()
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const root = await store.create({ username: 'root', password: 'root-pass', role: 'super_admin', company: 'Platform' })
  const admin = await store.create({
    username: 'acme-admin',
    password: 'admin-pass',
    role: 'admin',
    company: '  Acme  ',
    actorId: root.id,
  })
  const vendor = await store.create({ username: 'vendor1', password: 'vendor-pass', role: 'vendor', actorId: root.id })
  const staff = await store.create({ username: 'staff', password: 'staff-pass', company: '', actorId: admin.id })
  const client = await store.create({
    username: 'client',
    password: 'client-pass',
    company: 'Other',
    actorId: admin.id,
  })

  assert.equal(admin.company, 'Acme')
  assert.equal(vendor.company, '', 'super administrators do not pass their company down')
  assert.equal(staff.company, 'Acme')
  assert.equal(client.company, 'Other')
  assert.equal(publicUserView(staff).company, 'Acme')

  await store.update(client.id, { company: ' Renamed ' })
  assert.equal((await store.getById(client.id)).company, 'Renamed')
  await store.update(client.id, { password: 'client-next' })
  assert.equal((await store.getById(client.id)).company, 'Renamed', 'omitted company keeps the saved value')
  await assert.rejects(() => store.update(client.id, { company: 'x'.repeat(101) }), { code: 'invalid_company' })
  await assert.rejects(() => store.update(client.id, { company: 42 }), { code: 'invalid_company' })

  const rows = new Map((await store.list({ actorId: root.id, role: 'super_admin' })).map((u) => [u.username, u]))
  assert.equal(rows.get('root').parent_user_id, null)
  assert.equal(rows.get('root').parent_username, null)
  assert.equal(rows.get('acme-admin').parent_username, 'root')
  assert.equal(rows.get('client').parent_user_id, admin.id)
  assert.equal(rows.get('client').parent_username, 'acme-admin')
  assert.equal(rows.get('client').company, 'Renamed')

  const sub = await store.create({ username: 'acme-sub', password: 'sub-pass-1', role: 'admin', actorId: admin.id })
  const scoped = new Map((await store.list({ actorId: sub.id, role: 'admin' })).map((u) => [u.username, u]))
  assert.equal(scoped.get('acme-admin').parent_user_id, null, 'the domain creator stays hidden from domain admins')
  assert.equal(scoped.get('acme-admin').parent_username, null)
  assert.equal(scoped.get('client').parent_username, 'acme-admin')
  const own = new Map((await store.list({ actorId: admin.id, role: 'admin' })).map((u) => [u.username, u]))
  assert.equal(own.get('staff').parent_username, 'acme-admin', 'the acting admin is a visible parent')
})
