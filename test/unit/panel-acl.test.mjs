import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { authorizePanelRoute, viewsForRole, hasCapability, canViewPage } from '../../src/lib/admin/panel-acl.mjs'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'

const serverSrc = [
  fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/lib/admin/panel-routes.mjs'),
    'utf8',
  ),
  fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/server.mjs'), 'utf8'),
].join('\n')

test('commercial role matrix denies infrastructure and finance escalation', () => {
  assert.deepEqual(viewsForRole('user'), [
    'profile',
    'groups',
    'keys',
    'billing',
    'logs',
    'statistics',
    'subscriptions',
  ])
  for (const path of ['/api/panel/vms', '/api/panel/proxies', '/api/panel/users', '/api/panel/ops'])
    assert.equal(authorizePanelRoute('GET', path, 'user').ok, false, path)
  for (const path of ['/api/panel/vms/create', '/api/panel/vms/import', '/api/panel/proxies/import']) {
    assert.equal(authorizePanelRoute('POST', path, 'user').ok, false)
    assert.equal(authorizePanelRoute('POST', path, 'super').ok, true)
  }
  assert.equal(authorizePanelRoute('PUT', '/api/panel/vms/vm-01/groups', 'super').ok, true)
  for (const path of ['/api/panel/users/u/balance', '/api/panel/subscriptions', '/api/panel/groups'])
    assert.equal(authorizePanelRoute('POST', path, 'super').ok, false)
  assert.equal(authorizePanelRoute('GET', '/api/panel/vms/vm-01/package', 'super').ok, false)
  assert.equal(hasCapability('super', 'vm.create'), true)
  assert.equal(hasCapability('user', 'vm.schedule'), false)
  assert.equal(canViewPage('user', 'vm'), false)
})

test('admin is unrestricted', () => {
  assert.equal(authorizePanelRoute('DELETE', '/api/panel/vms/vm-01', 'admin').ok, true)
  assert.equal(authorizePanelRoute('POST', '/api/panel/users', 'admin').ok, true)
  assert.equal(authorizePanelRoute('POST', '/api/panel/vms/import', 'admin').ok, true)
  assert.equal(authorizePanelRoute('GET', '/api/panel/database/metrics', 'admin').ok, true)
  assert.equal(authorizePanelRoute('GET', '/api/panel/version', 'admin').ok, true)
  assert.equal(authorizePanelRoute('POST', '/api/panel/update', 'admin').ok, true)
})

test('user and super can GET/PUT onboarding; POST is admin-only', () => {
  for (const role of ['user', 'super', 'admin']) {
    assert.equal(authorizePanelRoute('GET', '/api/panel/onboarding', role).ok, true, `${role} GET`)
    assert.equal(authorizePanelRoute('PUT', '/api/panel/onboarding', role).ok, true, `${role} PUT`)
  }
  assert.equal(authorizePanelRoute('POST', '/api/panel/onboarding', 'user').ok, false)
  assert.equal(authorizePanelRoute('POST', '/api/panel/onboarding', 'super').ok, false)
  assert.equal(authorizePanelRoute('DELETE', '/api/panel/onboarding', 'user').ok, false)
})

test('onboarding profile writes are admin-only', async () => {
  const { Readable } = await import('node:stream')
  const { readBody } = await import('../../src/lib/http/respond.mjs')
  for (const role of ['user', 'super']) {
    let routingWrites = 0
    const response = {}
    const handlePanel = createPanelHandler({
      cfg: { paths: {} },
      readBody,
      persistRoutingPatch() {
        routingWrites += 1
        return {}
      },
      requireAuth(req) {
        req.panelUser = 'alice'
        req.panelRole = role
        return true
      },
      json(_res, status, body) {
        response.status = status
        response.body = body
      },
    })
    const req = Readable.from([Buffer.from(JSON.stringify({ action: 'profile', mode: 'personal' }))])
    req.method = 'PUT'
    await handlePanel(req, {}, new URL('http://localhost/api/panel/onboarding'))
    assert.equal(response.status, 403, role)
    assert.equal(response.body.error.code, 'forbidden', role)
    assert.equal(routingWrites, 0, role)
  }
})

test('managed keys cannot bypass admin role checks through models refresh', async () => {
  let authCalls = 0
  const response = {}
  const handlePanel = createPanelHandler({
    cfg: {},
    requireAuth(req) {
      authCalls += 1
      req.apiKeyKind = 'managed'
      return true
    },
    json(_res, status, body) {
      response.status = status
      response.body = body
    },
  })

  const handled = await handlePanel({ method: 'POST' }, {}, new URL('http://localhost/admin/models/refresh'))
  assert.equal(authCalls, 1)
  assert.equal(handled, true)
  assert.equal(response.status, 403)
  assert.equal(response.body.error.code, 'forbidden')
})

test('admin models refresh stays delegated to the server route', async () => {
  let authCalls = 0
  const handlePanel = createPanelHandler({
    cfg: {},
    requireAuth(req) {
      authCalls += 1
      req.apiKeyKind = 'master'
      req.panelRole = 'admin'
      return true
    },
    json() {
      assert.fail('delegated admin refresh must not respond in the panel handler')
    },
  })

  const handled = await handlePanel({ method: 'POST' }, {}, new URL('http://localhost/admin/models/refresh'))
  assert.equal(authCalls, 1)
  assert.equal(handled, false)
})

test('ACL schedule POSTs have matching server handlers', () => {
  assert.match(serverSrc, /clearVmCooldown/)
  assert.match(serverSrc, /cooldown\\\/clear/)
  assert.match(serverSrc, /\/schedulable\$/)
})
