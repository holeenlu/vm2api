import test from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, api } from '../harness.mjs'

const data = (r) => r.json?.data || r.json
test('admin overrides, endpoint assignment, user Key connection and secret ownership work through HTTP', async () => {
  const gw = await startGateway()
  try {
    const call = (method, path, body, headers) => api(gw, method, '/api/panel' + path, { body, headers })
    const group = data(
      await call('POST', '/groups', { name: 'API group', platform: 'openai', rpm_limit: 60, is_exclusive: true }),
    ).item
    const user = data(
      await call('POST', '/users', { username: 'refine-user', password: 'refine-pass', rpm_limit: 100 }),
    ).item
    const login = await call('POST', '/login', { username: 'refine-user', password: 'refine-pass' })
    const headers = { authorization: '', cookie: login.headers.get('set-cookie') }
    const denied = await call('PATCH', `/groups/${group.id}/user-overrides/${user.id}`, { rpm_limit: 999 }, headers)
    assert.equal(denied.status, 403)
    assert.equal(
      (await call('PATCH', `/groups/${group.id}/user-overrides/${user.id}`, { rate_multiplier: 0.5, rpm_limit: 90 }))
        .status,
      200,
    )
    assert.equal(
      data(await call('GET', '/groups', undefined, headers)).items.length,
      0,
      'override is not authorization',
    )
    await call('PUT', `/users/${user.id}/groups`, { groups: [{ group_id: group.id }] })
    assert.equal(data(await call('GET', `/groups?available_to=${user.id}`)).items[0].rate_multiplier, 0.5)
    assert.equal((await call('GET', `/groups?available_to=${user.id}`, undefined, headers)).status, 403)
    const epResp = await call('POST', '/api-endpoints', {
      name: 'test upstream',
      kind: 'openai',
      base_url: 'http://127.0.0.1:1/v1',
      models: [{ name: 'gpt-6.1-sol', alias: 'gpt-6.1-sol' }],
      api_key: 'fixture-upstream-key',
    })
    assert.equal(epResp.status, 201, epResp.text)
    const ep = data(epResp).item
    assert.equal(
      (await call('PUT', `/api-endpoints/${ep.id}/groups`, { group_ids: [group.id], expected_version: 0 })).status,
      200,
    )
    const listing = data(await call('GET', '/api-endpoints')).items.find((r) => r.id === ep.id)
    assert.equal(listing.groups[0].id, group.id)
    const created = await call('POST', '/api-keys', { name: 'refine-key', group_id: group.id, rpm: 20 }, headers)
    assert.equal(created.status, 201, created.text)
    const key = data(created).item
    assert.equal(key.rpm, 20)
    const reveal = data(await call('POST', `/api-keys/${key.id}/reveal`, undefined, headers))
    assert.equal(reveal.key, key.key)
    const connection = await call('GET', `/api-keys/${key.id}/connection`, undefined, headers)
    assert.equal(connection.status, 200, connection.text)
    assert.equal(data(connection).platform, 'openai')
    assert.deepEqual(
      data(connection).models.map((m) => m.id),
      ['gpt-6.1-sol'],
    )
    const other = data(await call('POST', '/users', { username: 'refine-other', password: 'refine-pass' })).item
    const second = await call('POST', '/login', { username: other.username, password: 'refine-pass' })
    assert.equal(
      (
        await call('POST', `/api-keys/${key.id}/reveal`, undefined, {
          authorization: '',
          cookie: second.headers.get('set-cookie'),
        })
      ).status,
      404,
    )
    assert.equal(
      (
        await call('GET', `/api-keys/${key.id}/connection`, undefined, {
          authorization: '',
          cookie: second.headers.get('set-cookie'),
        })
      ).status,
      404,
    )
    assert.equal(
      (await call('PUT', `/api-endpoints/${ep.id}/groups`, { group_ids: [], expected_version: 0 })).status,
      409,
    )
    await call('PUT', `/api-endpoints/${ep.id}/groups`, { group_ids: [], expected_version: listing.groups_version })
    assert.deepEqual(data(await call('GET', `/api-keys/${key.id}/connection`, undefined, headers)).models, [])
  } finally {
    await gw.stop()
  }
})
