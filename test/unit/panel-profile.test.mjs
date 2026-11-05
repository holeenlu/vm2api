import test from 'node:test'
import assert from 'node:assert/strict'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { PanelUserStore } from '../../src/lib/admin/panel-users.mjs'
import { profileView, updateOwnProfile, changeOwnPassword } from '../../src/lib/admin/panel-profile.mjs'

test('self profile changes cannot mutate identity, role, balances or grants', async (t) => {
  const db = createDatabase({ dbPath: ':memory:' })
  t.after(() => db.close())
  const store = new PanelUserStore({ db })
  const user = await store.create({ username: 'reader', password: 'reader-pass', role: 'user' })
  assert.equal(profileView(await store.getById(user.id)).email, '')
  for (const key of ['id', 'user_id', 'role', 'balance', 'groups', 'password'])
    await assert.rejects(() => updateOwnProfile(store, user.id, { [key]: 'admin' }), { code: 'invalid_profile_fields' })
  await assert.rejects(() => updateOwnProfile(store, user.id, { email: 'bad-address' }), { code: 'invalid_email' })
  const changed = await updateOwnProfile(store, user.id, { display_name: ' My name ', email: 'Reader@Example.com' })
  assert.equal(changed.display_name, 'My name')
  assert.equal(changed.email, 'reader@example.com')
  assert.equal(changed.username, 'reader')
  assert.equal(changed.role, 'user')
  assert.equal(changed.password_hash, undefined)
  const other = await store.create({ username: 'another', password: 'another-pass' })
  await assert.rejects(() => updateOwnProfile(store, other.id, { email: 'reader@example.com' }), {
    code: 'email_in_use',
  })
  assert.equal((await updateOwnProfile(store, user.id, { email: '' })).email, '')
})

test('password change requires current password, preserves authorization and never audits secrets', async (t) => {
  const db = createDatabase({ dbPath: ':memory:' })
  t.after(() => db.close())
  const store = new PanelUserStore({ db })
  const user = await store.create({ username: 'reader', password: 'reader-pass', role: 'user' })
  await assert.rejects(
    () => changeOwnPassword(store, user.id, { current_password: 'wrong', new_password: 'updated-pass' }),
    {
      code: 'current_password_incorrect',
    },
  )
  await assert.rejects(
    () => changeOwnPassword(store, user.id, { current_password: 'reader-pass', new_password: 'short' }),
    {
      code: 'invalid_password',
    },
  )
  await changeOwnPassword(store, user.id, { current_password: 'reader-pass', new_password: 'updated-pass' })
  assert.equal(await store.authenticate('reader', 'reader-pass'), null)
  assert.equal((await store.authenticate('reader', 'updated-pass')).role, 'user')
  const audit = JSON.stringify(db.prepare("SELECT * FROM operation_audit WHERE action='profile.password'").all())
  assert.doesNotMatch(audit, /reader-pass|updated-pass|scrypt/)
})
