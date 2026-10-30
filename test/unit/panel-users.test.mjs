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

test('email usernames preserve login, duplicate, password-change and disable behavior', (t) => {
  const { store, db, dir } = tmpStore()
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const username = '123.customer+tag@long-example-domain.test'
  const user = store.create({ username: ` ${username} `, password: 'email-user-pass' })
  assert.equal(user.username, username)
  assert.equal(store.authenticate(username.toUpperCase(), 'email-user-pass').id, user.id)
  assert.throws(() => store.create({ username: username.toUpperCase(), password: 'another-pass' }), {
    code: 'username_exists',
  })
  store.update(user.id, { password: 'email-user-next' })
  assert.equal(store.authenticate(username, 'email-user-pass'), null)
  assert.equal(store.authenticate(username, 'email-user-next').id, user.id)
  store.update(user.id, { enabled: false })
  assert.equal(store.authenticate(username, 'email-user-next'), null)
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

test('bootstrap seeds env admin once', () => {
  const { store } = tmpStore()
  const first = store.bootstrapFromEnv({ username: 'admin', password: 'testpass1' })
  const second = store.bootstrapFromEnv({ username: 'admin', password: 'otherpass' })
  assert.equal(first.username, 'admin')
  assert.equal(first.role, 'super_admin')
  assert.equal(second.id, first.id)
  assert.ok(store.authenticate('admin', 'testpass1'))
  assert.equal(store.authenticate('admin', 'otherpass'), null)
})

test('bootstrap imports legacy env passwords without relaxing user password validation', () => {
  const { store } = tmpStore()
  for (const [username, password] of [
    ['admin', '123456'],
    ['legacy', 'short'],
  ]) {
    const admin = store.bootstrapFromEnv({ username, password })
    assert.equal(admin.role, 'super_admin')
    assert.equal(admin.enabled, true)
    assert.equal(admin.password_hash, undefined)
    assert.ok(store.list().some((user) => user.id === admin.id))
    assert.ok(store.authenticate(username, password))
    assert.notEqual(store.getById(admin.id).password_hash, password)
    assert.throws(() => store.update(admin.id, { password: 'short' }), /密码至少 8 位/)

    store.update(admin.id, { password: 'changed-admin-pass' })
    const again = store.bootstrapFromEnv({ username, password })
    assert.equal(again.id, admin.id)
    assert.equal(store.authenticate(username, password), null)
    assert.ok(store.authenticate(username, 'changed-admin-pass'))
  }
  assert.throws(() => store.create({ username: 'reader', password: '123456' }), /密码至少 8 位/)
})

test('bootstrap preserves disabled admins and validates usernames', () => {
  const { store } = tmpStore()
  store.create({ username: 'owner', password: 'owner-pass', role: 'super_admin' })
  const admin = store.create({ username: 'admin', password: 'admin-pass', role: 'super_admin', enabled: false })
  const imported = store.bootstrapFromEnv({ username: 'admin', password: '123456' })
  assert.equal(imported.id, admin.id)
  assert.equal(imported.enabled, false)
  assert.equal(store.authenticate('admin', '123456'), null)
  assert.equal(store.bootstrapFromEnv({ username: 'empty', password: '' }), null)
  assert.throws(() => store.bootstrapFromEnv({ username: '1bad', password: '123456' }), /用户名/)
})

test('create / authenticate / change password / roles', () => {
  const { store } = tmpStore()
  store.bootstrapFromEnv({ username: 'admin', password: 'adminpass' })
  const viewer = store.create({ username: 'reader', password: 'reader-pass', role: 'user' })
  const superu = store.create({ username: 'ops', password: 'super-pass', role: 'admin' })
  assert.equal(viewer.role, 'user')
  assert.equal(superu.role, 'admin')
  assert.equal(store.authenticate('reader', 'reader-pass').role, 'user')
  assert.equal(store.authenticate('ops', 'wrong-pass'), null)

  const updated = store.update(viewer.id, { password: 'reader-next' })
  assert.equal(store.authenticate('reader', 'reader-pass'), null)
  assert.ok(store.authenticate('reader', 'reader-next'))
  assert.equal(publicUserView(updated).password_hash, undefined)
})

test('administrator branches share the root administrator data domain', () => {
  const { store } = tmpStore()
  const root = store.create({ username: 'root', password: 'root-pass', role: 'super_admin' })
  const first = store.create({ username: 'first', password: 'first-pass', role: 'admin', actorId: root.id })
  const second = store.create({ username: 'second', password: 'second-pass', role: 'admin', actorId: first.id })
  const child = store.create({ username: 'child', password: 'child-pass', role: 'admin', actorId: first.id })
  const granduser = store.create({ username: 'granduser', password: 'granduser-pass', role: 'user', actorId: child.id })
  const own = store.create({ username: 'ownuser', password: 'ownuser-pass', role: 'user', actorId: first.id })
  const branchB = store.create({ username: 'branchb', password: 'branchb-pass', role: 'admin', actorId: root.id })
  const foreign = store.create({ username: 'foreign', password: 'foreign-pass', role: 'user', actorId: branchB.id })

  assert.deepEqual(
    store
      .list({ actorId: first.id, role: 'admin' })
      .map((row) => row.username)
      .sort(),
    ['child', 'granduser', 'ownuser', 'second'],
  )
  assert.equal(store.canAccess(granduser.id, { actorId: first.id, role: 'admin' }), true)
  assert.equal(store.canAccess(foreign.id, { actorId: first.id, role: 'admin' }), false)
  assert.deepEqual(
    store
      .list({ actorId: second.id, role: 'admin' })
      .map((row) => row.username)
      .sort(),
    ['child', 'first', 'granduser', 'ownuser'],
  )
})

test('cannot remove or demote the last admin', () => {
  const { store } = tmpStore()
  const admin = store.create({ username: 'admin', password: 'adminpass', role: 'super_admin' })
  assert.throws(() => store.update(admin.id, { role: 'user' }), /最后一个管理员/)
  assert.throws(() => store.update(admin.id, { enabled: false }), /最后一个管理员/)
  assert.throws(() => store.remove(admin.id), /最后一个管理员/)
})

test('rejects bad username / short password / unknown role', () => {
  const { store } = tmpStore()
  assert.throws(() => store.create({ username: '1bad', password: 'longenough', role: 'user' }), /用户名/)
  assert.throws(() => store.create({ username: 'okuser', password: 'short', role: 'user' }), /密码/)
  assert.throws(() => store.create({ username: 'okuser', password: 'longenough', role: 'root' }), /角色/)
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

test('deleting a customer preserves infrastructure provenance and does not publish private slots', (t) => {
  const { dir, db, store } = tmpStore()
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const user = store.create({ username: 'tenant', password: 'tenant-pass' })
  const assigned = seedOwnedVm(dir, 'assigned', user.id)
  seedOwnedVm(dir, 'legacy', user.id, { origin: undefined })
  const privateVm = seedOwnedVm(dir, 'private', user.id, { origin: 'user_created' })
  const otherVm = seedOwnedVm(dir, 'other', 'another-tenant')
  const publicVm = seedOwnedVm(dir, 'public', null, { origin: 'platform' })

  assert.equal(store.remove(user.id), true)
  assert.equal(store.getById(user.id), null)
  const read = (id) => JSON.parse(fs.readFileSync(path.join(dir, 'vms', `${id}.json`), 'utf8'))
  const reclaimed = read('assigned')
  assert.deepEqual(reclaimed, assigned)
  assert.equal(read('legacy').owner_user_id, user.id)
  assert.deepEqual(read('private'), privateVm)
  assert.deepEqual(read('other'), otherVm)
  assert.deepEqual(read('public'), publicVm)
})

test('rejected user deletions leave assigned VMs with their owners', (t) => {
  const { dir, db, store } = tmpStore()
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const admin = store.create({ username: 'admin', password: 'admin-pass', role: 'super_admin' })
  const user = store.create({ username: 'tenant', password: 'tenant-pass' })
  const assigned = seedOwnedVm(dir, 'assigned', user.id)
  const adminVm = seedOwnedVm(dir, 'admin-vm', admin.id)

  assert.throws(() => store.remove(user.id, { actorId: user.id }), /不能删除当前登录账号/)
  assert.throws(() => store.remove(admin.id), /最后一个管理员/)
  assert.equal(store.remove('missing-user'), false)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'vms', 'assigned.json'), 'utf8')), assigned)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'vms', 'admin-vm.json'), 'utf8')), adminVm)
})

test('customer deletion never writes VM files', (t) => {
  const { dir, db, store } = tmpStore()
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const user = store.create({ username: 'tenant', password: 'tenant-pass' })
  const assigned = seedOwnedVm(dir, 'assigned', user.id)
  t.mock.method(fs, 'renameSync', () => {
    throw new Error('simulated VM write failure')
  })

  assert.equal(store.remove(user.id), true)
  assert.equal(store.getById(user.id), null)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'vms', 'assigned.json'), 'utf8')), assigned)
})
