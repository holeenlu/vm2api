import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startGateway, api } from '../harness.mjs'

test('deleting a grouped slot removes it from HTTP resource lists', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-delete-groups-'))
  const gw = await startGateway({ disableWatchdog: true, project })
  try {
    const login = await api(gw, 'POST', '/api/panel/login', { body: { username: 'admin', password: 'testpass' } })
    assert.equal(login.status, 200, login.text)
    const headers = { authorization: '', cookie: login.headers.get('set-cookie') }
    const call = (method, path, body) => api(gw, method, '/api/panel' + path, { headers, body })
    const created = await call('POST', '/groups', { name: 'deletion regression', platform: 'anthropic' })
    assert.equal(created.status, 201, created.text)
    const group = created.json.data.item
    const assigned = await call('PUT', '/vms/vm-sim-01/groups', { group_ids: [group.id], expected_version: 0 })
    assert.equal(assigned.status, 200, assigned.text)
    const before = await call('GET', '/groups/' + group.id)
    assert.equal(before.json.data.item.resources.length, 1)
    const deleted = await call('DELETE', '/vms/vm-sim-01')
    assert.equal(deleted.status, 200, deleted.text)
    const view = await call('GET', '/groups/' + group.id)
    assert.equal(view.status, 200, view.text)
    assert.deepEqual(view.json.data.item.resources, [])
    assert.equal(view.json.data.item.capacity.resources, 0)
    const slots = await call('GET', '/vms')
    assert.equal(slots.status, 200, slots.text)
    assert.ok(!slots.json.data.items.some((vm) => vm.id === 'vm-sim-01'))
    const stale = await call('PUT', '/groups/' + group.id + '/resources', {
      expected_version: before.json.data.item.version,
      resources: before.json.data.item.resources,
    })
    assert.equal(stale.status, 409, stale.text)
  } finally {
    await gw.stop()
    fs.rmSync(project, { recursive: true, force: true })
  }
})
