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

test('SA retains custom commercial views; AD and U cannot manage infrastructure', () => {
  for (const view of ['profile', 'groups', 'ops', 'subscriptions', 'keys', 'billing'])
    assert.ok(viewsForRole('super_admin').includes(view), view)
  for (const view of ['profile', 'groups', 'subscriptions', 'keys', 'logs'])
    assert.ok(viewsForRole('user').includes(view), view)
  for (const role of ['admin', 'user']) {
    for (const path of [
      '/api/panel/vms/create',
      '/api/panel/vms/import',
      '/api/panel/vms/x/start',
      '/api/panel/proxies/import',
    ])
      assert.equal(authorizePanelRoute('POST', path, role).ok, false, role + path)
    for (const path of ['/api/panel/users/u/balance', '/api/panel/subscriptions', '/api/panel/groups'])
      assert.equal(authorizePanelRoute('POST', path, role).ok, false, role + path)
    assert.equal(authorizePanelRoute('GET', '/api/panel/database/metrics', role).ok, false)
  }
  assert.equal(authorizePanelRoute('POST', '/api/panel/users', 'admin').ok, true)
  assert.equal(authorizePanelRoute('GET', '/api/panel/me', 'admin').ok, true)
  assert.equal(authorizePanelRoute('GET', '/api/panel/groups', 'user').ok, true)
  assert.equal(authorizePanelRoute('GET', '/api/panel/api-keys/x/connection', 'user').ok, true)
  assert.equal(hasCapability('user', 'vm.schedule'), false)
  assert.equal(canViewPage('admin', 'vm'), false)
  for (const role of ['super_admin', 'admin', 'user']) assert.equal(canViewPage(role, 'home'), false)
})

test('SA is unrestricted', () => {
  for (const [method, path] of [
    ['DELETE', '/api/panel/vms/x'],
    ['POST', '/api/panel/users'],
    ['POST', '/api/panel/vms/import'],
    ['GET', '/api/panel/database/metrics'],
    ['POST', '/api/panel/update'],
  ])
    assert.equal(authorizePanelRoute(method, path, 'super_admin').ok, true, path)
})

test('all roles can read and update onboarding progress', () => {
  for (const role of ['super_admin', 'admin', 'user']) {
    assert.equal(authorizePanelRoute('GET', '/api/panel/onboarding', role).ok, true)
    assert.equal(authorizePanelRoute('PUT', '/api/panel/onboarding', role).ok, true)
  }
})

test('onboarding profile writes are admin-only', async () => {
  const { Readable } = await import('node:stream')
  const { readBody } = await import('../../src/lib/http/respond.mjs')
  for (const role of ['user', 'admin']) {
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
      req.panelRole = 'super_admin'
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
