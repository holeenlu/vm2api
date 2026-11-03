import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { startGateway, api } from '../harness.mjs'

test('bulk save persists through HTTP and gateway restart, with version and privilege protection', async () => {
  let gw = await startGateway({ disableWatchdog: true })
  const project = gw.project
  const call = (method, suffix, body) => api(gw, method, '/api/panel' + suffix, { body })
  try {
    const snap = await call('POST', '/vms/bulk-edit/snapshot', { ids: ['vm-sim-01'] })
    assert.equal(snap.status, 200, snap.text)
    const groupResponse = await call('POST', '/groups', { name: 'Bulk HTTP', platform: 'anthropic' })
    assert.equal(groupResponse.status, 201, groupResponse.text)
    const group = groupResponse.json.data.item
    const command = {
      operation_id: randomUUID(),
      items: snap.json.data.items,
      patch: { max_concurrency: 5, max_rpm: 45, schedule_level: 4, groups: { operation: 'add', ids: [group.id] } },
    }
    const saved = await call('POST', '/vms/bulk-edit', command)
    assert.equal(saved.status, 200, saved.text)
    assert.equal(saved.json.data.status, 'complete', saved.text)
    let listed = await call('GET', '/vms')
    assert.equal(listed.status, 200, listed.text)
    const vm = listed.json.data.items.find((v) => v.id === 'vm-sim-01')
    assert.equal(vm.max_concurrency, 5)
    assert.equal(vm.max_rpm, 45)
    assert.equal(vm.schedule_level, 4)
    assert.ok(vm.groups.some((g) => g.id === group.id))
    const stale = await call('POST', '/vms/bulk-edit', {
      ...command,
      operation_id: randomUUID(),
      patch: { max_concurrency: 7 },
    })
    assert.equal(stale.status, 409, stale.text)
    const login = await call('POST', '/login', { username: 'admin', password: 'testpass' })
    assert.equal(login.status, 200)
    const customer = await call('POST', '/users', {
      username: 'bulk-customer',
      password: 'bulk-test-password',
      role: 'user',
    })
    assert.equal(customer.status, 201, customer.text)
    const userLogin = await call('POST', '/login', { username: 'bulk-customer', password: 'bulk-test-password' })
    const denied = await api(gw, 'POST', '/api/panel/vms/bulk-edit/snapshot', {
      headers: { authorization: '', cookie: userLogin.headers.get('set-cookie') },
      body: { ids: ['vm-sim-01'] },
    })
    assert.equal(denied.status, 403, denied.text)
    await gw.stop()
    gw = await startGateway({ project, disableWatchdog: true })
    const receipt = await call('GET', `/vms/bulk-edit/operations/${command.operation_id}`)
    assert.equal(receipt.status, 200, receipt.text)
    assert.equal(receipt.json.data.status, 'complete')
    listed = await call('GET', '/vms')
    assert.equal(listed.json.data.items.find((v) => v.id === 'vm-sim-01').max_concurrency, 5)
    const replay = await call('POST', '/vms/bulk-edit', command)
    assert.equal(replay.json.data.status, 'complete')
  } finally {
    await gw.stop()
    fs.rmSync(project, { recursive: true, force: true })
  }
})
