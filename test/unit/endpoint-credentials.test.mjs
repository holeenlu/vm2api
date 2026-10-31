import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { ApiEndpointStore } from '../../src/lib/admin/api-endpoints.mjs'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { readBody } from '../../src/lib/http/respond.mjs'

function fixture(t) {
  const db = createDatabase({ dbPath: ':memory:' })
  t.after(() => db.close())
  const store = new ApiEndpointStore({ db })
  const ep = store.create({
    name: 'trusted',
    kind: 'custom',
    protocol: 'anthropic',
    base_url: 'https://trusted.invalid',
    headers: { 'x-private-token': 'fixture-header-secret' },
    api_key_entries: [
      {
        api_key: 'fixture-upstream-secret',
        proxy_url: 'http://fixture-user:fixture-proxy-secret@proxy.invalid:8000',
        proxy_id: 'proxy-1',
      },
    ],
    models: [{ name: 'claude-sonnet-5', alias: 'claude-sonnet-5' }],
  })
  const forwarded = []
  async function request(method, suffix, body, role = 'admin') {
    const response = {}
    const handler = createPanelHandler({
      cfg: { paths: { project: '/tmp' } },
      apiKeyStore: { db },
      apiEndpointStore: store,
      apiScheduler: { reload() {} },
      readBody,
      proxyPool: { getProxyByIdWithAuth: () => ({ url: 'http://new-proxy.invalid:8000' }) },
      requireAuth(req) {
        req.panelUser = 'ops'
        req.panelRole = role
        return true
      },
      forwardApi: async (value) => {
        forwarded.push(value)
        return {
          statusCode: 200,
          async *[Symbol.asyncIterator]() {
            yield Buffer.from('{"data":[{"id":"claude-sonnet-5"}]}')
          },
        }
      },
      json(_res, status, body) {
        Object.assign(response, { status, body })
      },
    })
    const req = Readable.from([Buffer.from(JSON.stringify(body || {}))])
    req.method = method
    await handler(req, {}, new URL('http://localhost/api/panel/api-endpoints' + suffix))
    return response
  }
  return { db, store, ep, forwarded, request, key: ep.api_key_entries[0] }
}
test('super cannot redirect saved credentials through global model fetch or endpoint mutation', async (t) => {
  const { store, ep, request, key, forwarded } = fixture(t)
  for (const override of [
    { base_url: 'https://untrusted.invalid' },
    { kind: 'openai' },
    { protocol: 'openai' },
    { proxy_id: 'proxy-2' },
    { proxy_id: 'proxy-1' }, // Same ID must not rebind a saved key through an edited proxy pool entry.
    { proxy_url: 'http://untrusted.invalid' },
    { headers: { host: 'untrusted.invalid' } },
    { auth_scheme: 'authorization_bearer' },
  ]) {
    assert.equal((await request('POST', '/fetch-models', { key_id: key.id, ...override })).status, 403)
    assert.equal((await request('PATCH', '/' + ep.id, { key_id: key.id, ...override })).status, 403)
    assert.deepEqual(store.getRaw(ep.id), ep, 'denied patches are atomic')
  }
  assert.equal(forwarded.length, 0)
  assert.equal((await request('PATCH', '/' + ep.id, { name: 'renamed', priority: 9, disabled: true })).status, 403)
  assert.equal(store.getRaw(ep.id).name, 'trusted')
  assert.equal(store.getRaw(ep.id).api_key_entries[0].proxy_url, key.proxy_url)
})
test('both model-fetch routes keep saved destination, auth headers and proxy; admin can retarget', async (t) => {
  const { ep, key, request, forwarded } = fixture(t)
  assert.equal((await request('POST', '/fetch-models', { key_id: key.id }, 'super_admin')).status, 200)
  assert.equal((await request('POST', '/' + ep.id + '/fetch-models', { apply: false }, 'super_admin')).status, 200)
  for (const value of forwarded) {
    assert.equal(value.url, 'https://trusted.invalid/v1/models')
    assert.equal(value.headers['x-api-key'], key.api_key)
    assert.equal(value.headers['x-private-token'], 'fixture-header-secret')
    assert.equal(value.proxyUrl, key.proxy_url)
  }
  assert.equal(
    (await request('PATCH', '/' + ep.id, { base_url: 'https://new-trusted.invalid' }, 'super_admin')).status,
    200,
  )
})
test('super DTO hides proxy credentials and custom headers on list/create/update/fetch responses', async (t) => {
  const { ep, key, request, store } = fixture(t)
  for (const response of [
    await request('GET', ''),
    await request('PATCH', '/' + ep.id, { priority: 2 }),
    await request('POST', '/' + ep.id + '/fetch-models', {}),
    await request('POST', '', {
      kind: 'custom',
      base_url: 'https://created.invalid',
      headers: { token: 'fixture-header-secret' },
      api_key_entries: [{ api_key: key.api_key, proxy_url: key.proxy_url }],
    }),
  ]) {
    assert.equal(response.status, 403)
    assert.doesNotMatch(JSON.stringify(response.body), /fixture-(?:upstream|proxy|header)-secret|fixture-user/)
  }
  assert.equal(store.getRaw(ep.id).api_key_entries[0].proxy_url, key.proxy_url)
  const listed = store.list({ role: 'admin' })[0]
  assert.equal(listed.api_key_entries[0].has_proxy, true)
  assert.equal(listed.connection_editable, false)
})
test('endpoint PATCH cannot modify a key belonging to another endpoint', async (t) => {
  const { ep, store, key, request } = fixture(t)
  const other = store.create({ kind: 'custom', base_url: 'https://another.invalid' })
  assert.equal(
    (
      await request(
        'PATCH',
        '/' + other.id,
        { name: 'must-not-save', key_id: key.id, api_key: 'replacement' },
        'super_admin',
      )
    ).status,
    404,
  )
  assert.equal(store.getRaw(ep.id).api_key_entries[0].api_key, key.api_key)
  assert.notEqual(store.getRaw(other.id).name, 'must-not-save')
})
