import test from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, api } from '../harness.mjs'
const data = (r) => r.json?.data || r.json
test('profile APIs isolate the signed-in user; password change revokes other sessions; branding writes are admin-only', async () => {
  const gw = await startGateway()
  try {
    const call = (method, path, body, headers) => api(gw, method, '/api/panel' + path, { body, headers })
    const user = data(await call('POST', '/users', { username: 'profile-user', password: 'profile-pass' })).item
    const login = async (password) => call('POST', '/login', { username: user.username, password })
    const first = await login('profile-pass'),
      second = await login('profile-pass')
    const own = { authorization: '', cookie: first.headers.get('set-cookie') },
      other = { authorization: '', cookie: second.headers.get('set-cookie') }
    assert.equal((await call('GET', '/site', undefined, { authorization: '' })).status, 200)
    assert.equal((await call('PUT', '/site', { name: 'Not allowed' }, own)).status, 403)
    assert.equal((await call('PATCH', '/me/profile', { role: 'super_admin' }, own)).status, 400)
    assert.equal(
      (await call('PATCH', '/me/profile', { display_name: 'Test reader', email: 'reader@example.com' }, own)).status,
      200,
    )
    assert.equal(data(await call('GET', '/me', undefined, own)).display_name, 'Test reader')
    assert.equal(data(await call('GET', '/me/profile', undefined, own)).username, user.username)
    assert.equal((await call('GET', '/users', undefined, own)).status, 403)
    assert.equal((await call('GET', '/update/check', undefined, own)).status, 403)
    assert.equal(
      (await call('POST', '/me/password', { current_password: 'wrong', new_password: 'changed-pass' }, own)).status,
      403,
    )
    assert.equal(
      (await call('POST', '/me/password', { current_password: 'profile-pass', new_password: 'changed-pass' }, own))
        .status,
      200,
    )
    assert.equal((await call('GET', '/me', undefined, own)).status, 200)
    assert.equal((await call('GET', '/me', undefined, other)).status, 401)
    assert.equal((await login('profile-pass')).status, 401)
    assert.equal((await login('changed-pass')).status, 200)
    assert.equal((await call('PUT', '/site', { name: 'Test brand' })).status, 200)
    assert.equal(data(await call('GET', '/site', undefined, { authorization: '' })).name, 'Test brand')
  } finally {
    await gw.stop()
  }
})
