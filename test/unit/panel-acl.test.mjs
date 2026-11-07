import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { authorizePanelRoute, viewsForRole, hasCapability, canViewPage } from '../../src/lib/admin/panel-acl.mjs'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'

test('SA retains custom commercial views; AD and U cannot manage infrastructure', () => {
  for (const view of ['profile', 'groups', 'subscriptions', 'keys', 'billing'])
    assert.ok(viewsForRole('super_admin').includes(view), view)
  for (const view of ['profile', 'subscriptions', 'keys', 'logs']) assert.ok(viewsForRole('user').includes(view), view)
  for (const role of ['admin', 'user']) {
    for (const path of [
      '/api/panel/vms/create',
      '/api/panel/vms/import',
      '/api/panel/vms/x/start',
      '/api/panel/proxies/import',
    ])
      assert.equal(authorizePanelRoute('POST', path, role).ok, false, role + path)
    for (const path of ['/api/panel/subscriptions', '/api/panel/groups'])
      assert.equal(authorizePanelRoute('POST', path, role).ok, false, role + path)
    assert.equal(authorizePanelRoute('GET', '/api/panel/database/metrics', role).ok, false)
  }
  assert.equal(authorizePanelRoute('POST', '/api/panel/users', 'admin').ok, true)
  assert.equal(authorizePanelRoute('POST', '/api/panel/users/u/balance', 'admin').ok, true)
  assert.equal(authorizePanelRoute('GET', '/api/panel/users/u/balance-history', 'admin').ok, true)
  assert.equal(authorizePanelRoute('GET', '/api/panel/me', 'admin').ok, true)
  assert.equal(authorizePanelRoute('GET', '/api/panel/groups', 'user').ok, true)
  assert.equal(authorizePanelRoute('POST', '/api/panel/redeem', 'user').ok, false)
  assert.equal(authorizePanelRoute('GET', '/api/panel/api-keys/x/connection', 'user').ok, true)
  assert.equal(hasCapability('user', 'vm.schedule'), false)
  assert.equal(canViewPage('admin', 'vm'), false)
  for (const role of ['super_admin', 'admin', 'user', 'vendor']) {
    assert.equal(canViewPage(role, 'home'), false)
    assert.equal(canViewPage(role, 'ops'), false)
  }
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

test('ACL schedule POSTs reach their delegated handlers only for super admins', async (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-acl-routes-'))
  t.after(() => fs.rmSync(project, { recursive: true, force: true }))
  for (const role of ['super_admin', 'admin', 'user', 'vendor']) {
    const response = {}
    const handlePanel = createPanelHandler({
      cfg: { paths: { project } },
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
    for (const action of ['schedulable', 'cooldown/clear']) {
      const route = `/api/panel/vms/missing/${action}`
      await handlePanel({ method: 'POST' }, {}, new URL(`http://localhost${route}`))
      const expected = role === 'super_admin' ? 404 : 403
      assert.equal(response.status, expected, `${role} ${route}`)
      if (expected === 404) assert.equal(response.body.error.code, 'vm_not_found')
    }
  }
})

test('onboarding profile waits for the routing write and reports its failure', async (t) => {
  const { Readable } = await import('node:stream')
  const { readBody } = await import('../../src/lib/http/respond.mjs')
  const { openDatabase, closeDatabase } = await import('../../src/lib/db/database.mjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onboarding-profile-'))
  openDatabase({ dataDir: dir })
  fs.mkdirSync(path.join(dir, 'config'))
  t.after(() => {
    closeDatabase()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const unhandled = []
  const onUnhandled = (error) => unhandled.push(error)
  process.on('unhandledRejection', onUnhandled)
  t.after(() => process.off('unhandledRejection', onUnhandled))
  const call = async (body, persistRoutingPatch) => {
    const response = {}
    const handlePanel = createPanelHandler({
      cfg: { paths: { project: dir, root: dir } },
      readBody,
      persistRoutingPatch,
      requireAuth(req) {
        req.panelUser = 'root'
        req.panelRole = 'super_admin'
        return true
      },
      json(_res, status, payload) {
        Object.assign(response, { status, body: payload })
      },
    })
    const req = Readable.from([Buffer.from(JSON.stringify(body))])
    req.method = 'PUT'
    await handlePanel(req, {}, new URL('http://localhost/api/panel/onboarding'))
    return response
  }
  const invalid = await call({ action: 'profile', mode: 'bogus' }, async () => ({}))
  assert.deepEqual([invalid.status, invalid.body?.error?.code], [400, 'invalid_profile'])
  // 写路由配置失败：错误交给服务器的统一处理（500），不能先回 200
  await assert.rejects(
    call({ action: 'profile', mode: 'personal' }, async () => {
      throw new Error('routing write failed')
    }),
    /routing write failed/,
  )
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(unhandled, [])
})

test('dataplane switch waits for the routing write and reports its failure', async (t) => {
  const { Readable } = await import('node:stream')
  const { readBody } = await import('../../src/lib/http/respond.mjs')
  const unhandled = []
  const onUnhandled = (error) => unhandled.push(error)
  process.on('unhandledRejection', onUnhandled)
  t.after(() => process.off('unhandledRejection', onUnhandled))
  const response = {}
  const handlePanel = createPanelHandler({
    cfg: { paths: { project: os.tmpdir() } },
    routingConfig: { inference: {} },
    readBody,
    async persistRoutingPatch() {
      throw new Error('routing write failed')
    },
    requireAuth(req) {
      req.panelUser = 'root'
      req.panelRole = 'super_admin'
      return true
    },
    json(_res, status, body) {
      Object.assign(response, { status, body })
    },
  })
  const req = Readable.from([Buffer.from(JSON.stringify({ dataplane: 'wrap', all: true }))])
  req.method = 'POST'
  await handlePanel(req, {}, new URL('http://localhost/api/panel/dataplane'))
  assert.deepEqual([response.status, response.body?.error?.code], [503, 'dataplane_persist_failed'])
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(unhandled, [])
})
