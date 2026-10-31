import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startGateway, api, seedVm } from '../harness.mjs'

const data = (r) => r.json?.data || r.json
test('mixed API group keeps its full model list but exposes only authorized OpenAI models to Codex', async () => {
  const gw = await startGateway()
  try {
    const call = (method, path, body, headers) => api(gw, method, '/api/panel' + path, { body, headers })
    const user = data(await call('POST', '/users', { username: 'catalog-user', password: 'catalog-pass' })).item
    const group = data(await call('POST', '/groups', { name: 'Catalog A', platform: 'mixed', is_exclusive: true })).item
    const other = data(
      await call('POST', '/groups', { name: 'Catalog B', platform: 'openai', is_exclusive: true }),
    ).item
    await call('PUT', `/users/${user.id}/groups`, { groups: [{ group_id: group.id }] })
    for (const [g, ids] of [
      [group, ['claude-sonnet-5-5', 'gpt-6.1-sol', 'vendor/gpt-6-astra', 'custom-model', 'gpt-image-1']],
      [other, ['gpt-private-model']],
    ]) {
      const ep = data(
        await call('POST', '/api-endpoints', {
          name: g.name,
          kind: 'openai',
          base_url: 'http://127.0.0.1:1/v1',
          api_key: 'fixture-upstream-secret',
          models: ids.map((id) => ({ name: id, alias: id })),
        }),
      ).item
      await call('PUT', `/api-endpoints/${ep.id}/groups`, { group_ids: [g.id], expected_version: 0 })
    }
    const key = data(
      await call('POST', '/api-keys', { name: 'Catalog Key', user_id: user.id, group_id: group.id }),
    ).item
    const headers = { authorization: `Bearer ${key.key}` }
    const ordinary = await api(gw, 'GET', '/v1/models', { headers })
    const catalog = await api(gw, 'GET', '/v1/models?client_version=0.156.0', { headers })
    assert.equal(ordinary.status, 200, ordinary.text)
    assert.equal(catalog.status, 200, catalog.text)
    assert.deepEqual(
      ordinary.json.data.map((m) => m.id),
      ['claude-sonnet-5-5', 'gpt-6.1-sol', 'vendor/gpt-6-astra', 'custom-model', 'gpt-image-1'],
    )
    assert.deepEqual(
      catalog.json.models.map((m) => m.slug),
      ['gpt-6.1-sol', 'vendor/gpt-6-astra'],
    )
    const m = catalog.json.models[0]
    for (const model of catalog.json.models) {
      assert.equal(model.context_window, 500000)
      assert.equal(model.max_context_window, 872000)
      assert.deepEqual(Object.keys(model), Object.keys(m))
      assert.deepEqual(Object.keys(model.model_messages), Object.keys(m.model_messages))
    }
    assert.equal(m.supported_in_api, true)
    assert.equal(m.visibility, 'list')
    assert.ok(m.model_messages.instructions_template.length > 0)
    assert.deepEqual(
      m.supported_reasoning_levels.map((r) => r.effort),
      ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    )
    assert.ok(Object.hasOwn(m.model_messages.approvals, 'on_request'))
    assert.ok(m.model_messages.confirmation_policies.browser_use)
    assert.ok(m.service_tiers.some((tier) => tier.id === 'priority'))
    assert.equal(m.comp_hash, '3000')
    assert.equal(m.use_responses_lite, false)
    assert.ok(catalog.headers.get('cache-control').includes('no-store'))
    for (const secret of [
      key.key,
      'fixture-upstream-secret',
      'gpt-private-model',
      'claude-',
      'custom-model',
      'gpt-image-1',
    ])
      assert.ok(!catalog.text.includes(secret))
    const connection = data(await call('GET', `/api-keys/${key.id}/connection`))
    assert.deepEqual(
      connection.models.map((m) => m.id),
      ordinary.json.data.map((m) => m.id),
    )
    assert.equal(connection.websocket, false, 'HTTP API endpoints must not advertise native WS')
    const update = await call('PATCH', `/groups/${group.id}`, { models: ['gpt-6.1-sol'] })
    assert.equal(update.status, 200, update.text)
    const filtered = await api(gw, 'GET', '/v1/models?client_version=0.156.0', { headers })
    assert.deepEqual(
      filtered.json.models.map((m) => m.slug),
      ['gpt-6.1-sol'],
    )
    assert.equal((await call('PATCH', `/groups/${group.id}`, { models: ['claude-sonnet-5-5'] })).status, 200)
    const claudeOnly = await api(gw, 'GET', '/v1/models?client_version=0.156.0', { headers })
    assert.equal(claudeOnly.status, 200, claudeOnly.text)
    assert.deepEqual(claudeOnly.json.models, [])
    assert.deepEqual(
      (await api(gw, 'GET', '/v1/models', { headers })).json.data.map((m) => m.id),
      ['claude-sonnet-5-5'],
    )
    await call('PUT', `/users/${user.id}/groups`, { groups: [] })
    assert.equal((await api(gw, 'GET', '/v1/models?client_version=0.156.0', { headers })).status, 403)
    assert.equal(
      (await api(gw, 'GET', '/v1/models?client_version=0.156.0', { headers: { authorization: '' } })).status,
      401,
    )
  } finally {
    await gw.stop()
  }
})

test('mixed VM group shares an OpenAI-only Codex catalog for HTTP and WebSocket clients', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mixed-catalog-'))
  seedVm({ project })
  const gpt = seedVm({ project, id: 'vm-codex-catalog', oauth: false })
  gpt.platform = 'openai'
  gpt.family = 'codex'
  gpt.codex = {}
  delete gpt.claude
  fs.writeFileSync(path.join(project, 'vms', `${gpt.id}.json`), JSON.stringify(gpt))
  const gw = await startGateway({ project })
  try {
    const call = (method, route, body) => api(gw, method, '/api/panel' + route, { body })
    const user = data(await call('POST', '/users', { username: 'vm-catalog-user', password: 'catalog-pass' })).item
    const ids = ['claude-sonnet-5-5', 'gpt-6.1-sol']
    const group = data(await call('POST', '/groups', { name: 'Mixed VM', platform: 'mixed', models: ids })).item
    await call('PUT', `/users/${user.id}/groups`, { groups: [{ group_id: group.id }] })
    for (const id of ['vm-sim-01', gpt.id]) {
      const assigned = await call('PUT', `/vms/${id}/groups`, { group_ids: [group.id], expected_version: 0 })
      assert.equal(assigned.status, 200, assigned.text)
    }
    const key = data(
      await call('POST', '/api-keys', { name: 'Mixed VM Key', user_id: user.id, group_id: group.id }),
    ).item
    const headers = { authorization: `Bearer ${key.key}` }
    const ordinary = await api(gw, 'GET', '/v1/models', { headers })
    assert.equal(ordinary.status, 200, ordinary.text)
    assert.deepEqual(ordinary.json.data.map((m) => m.id).sort(), ids)
    const catalog = await api(gw, 'GET', '/v1/models?client_version=0.156.0', { headers })
    assert.equal(catalog.status, 200, catalog.text)
    assert.deepEqual(
      catalog.json.models.map((m) => m.slug),
      ['gpt-6.1-sol'],
    )
    assert.equal(data(await call('GET', `/api-keys/${key.id}/connection`)).websocket, true)
    const removed = await call('PUT', `/vms/${gpt.id}/groups`, { group_ids: [], expected_version: 1 })
    assert.equal(removed.status, 200, removed.text)
    assert.deepEqual((await api(gw, 'GET', '/v1/models?client_version=0.156.0', { headers })).json.models, [])
    assert.deepEqual(
      (await api(gw, 'GET', '/v1/models', { headers })).json.data.map((m) => m.id),
      [ids[0]],
    )
  } finally {
    await gw.stop()
    fs.rmSync(project, { recursive: true, force: true })
  }
})
