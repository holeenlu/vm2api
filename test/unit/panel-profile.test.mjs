import test from 'node:test'
import assert from 'node:assert/strict'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { PanelUserStore } from '../../src/lib/admin/panel-users.mjs'
import { profileView, updateOwnProfile, changeOwnPassword } from '../../src/lib/admin/panel-profile.mjs'

test('self profile changes cannot mutate identity, role, balances or grants', (t) => {
  const db = createDatabase({ dbPath: ':memory:' })
  t.after(() => db.close())
  const store = new PanelUserStore({ db })
  const user = store.create({ username: 'reader', password: 'reader-pass', role: 'user' })
  assert.equal(profileView(store.getById(user.id)).email, '')
  for (const key of ['id', 'user_id', 'role', 'balance', 'groups', 'password'])
    assert.throws(() => updateOwnProfile(store, user.id, { [key]: 'admin' }), { code: 'invalid_profile_fields' })
  assert.throws(() => updateOwnProfile(store, user.id, { email: 'bad-address' }), { code: 'invalid_email' })
  const changed = updateOwnProfile(store, user.id, { display_name: ' My name ', email: 'Reader@Example.com' })
  assert.equal(changed.display_name, 'My name')
  assert.equal(changed.email, 'reader@example.com')
  assert.equal(changed.username, 'reader')
  assert.equal(changed.role, 'user')
  assert.equal(changed.password_hash, undefined)
  const other = store.create({ username: 'another', password: 'another-pass' })
  assert.throws(() => updateOwnProfile(store, other.id, { email: 'reader@example.com' }), { code: 'email_in_use' })
  assert.equal(updateOwnProfile(store, user.id, { email: '' }).email, '')
})

test('password change requires current password, preserves authorization and never audits secrets', (t) => {
  const db = createDatabase({ dbPath: ':memory:' })
  t.after(() => db.close())
  const store = new PanelUserStore({ db })
  const user = store.create({ username: 'reader', password: 'reader-pass', role: 'user' })
  assert.throws(() => changeOwnPassword(store, user.id, { current_password: 'wrong', new_password: 'updated-pass' }), {
    code: 'current_password_incorrect',
  })
  assert.throws(() => changeOwnPassword(store, user.id, { current_password: 'reader-pass', new_password: 'short' }), {
    code: 'invalid_password',
  })
  changeOwnPassword(store, user.id, { current_password: 'reader-pass', new_password: 'updated-pass' })
  assert.equal(store.authenticate('reader', 'reader-pass'), null)
  assert.equal(store.authenticate('reader', 'updated-pass').role, 'user')
  const audit = JSON.stringify(db.prepare("SELECT * FROM operation_audit WHERE action='profile.password'").all())
  assert.doesNotMatch(audit, /reader-pass|updated-pass|scrypt/)
})
