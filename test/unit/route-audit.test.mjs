import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, openDatabase } from '../../src/lib/db/database.mjs'
import {
  auditSensitiveAction,
  rememberBodyFields,
  routeAuditEntry,
  watchRouteAudit,
} from '../../src/lib/admin/route-audit.mjs'

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-audit-'))
  const db = openDatabase({ dataDir: dir })
  t.after(async () => {
    await closeDatabase()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return db
}

const response = (statusCode) => Object.assign(new EventEmitter(), { statusCode })

test('a successful write without its own audit is recorded with field names only', (t) => {
  const db = setup(t)
  const req = { method: 'PUT', panelUserId: 'u_root' }
  rememberBodyFields(req, { password: 'secret-value', bind_limit: 2 })
  const res = response(200)
  watchRouteAudit(req, res, '/api/panel/proxies/config', { db: () => db })
  res.emit('finish')
  const rows = db.prepare('SELECT actor,action,target,before_json,after_json FROM operation_audit').all()
  assert.equal(rows.length, 1)
  assert.deepEqual(
    { ...rows[0], after_json: JSON.parse(rows[0].after_json) },
    {
      actor: 'u_root',
      action: 'route:PUT /api/panel/proxies/config',
      target: '/api/panel/proxies/config',
      before_json: null,
      after_json: { status: 200, fields: ['bind_limit', 'password'] },
    },
  )
  assert.equal(rows[0].after_json.includes('secret-value'), false)
})

test('failed writes, reads, handler-audited routes and unregistered paths are not recorded', (t) => {
  const db = setup(t)
  const cases = [
    [{ method: 'PUT' }, '/api/panel/proxies/config', 400],
    [{ method: 'GET' }, '/api/panel/proxies/config', 200],
    // 分组写入由 GroupsRepo 自己写审计
    [{ method: 'POST' }, '/api/panel/groups', 200],
    [{ method: 'POST' }, '/api/panel/no-such-route', 200],
  ]
  for (const [req, p, status] of cases) {
    assert.equal(routeAuditEntry(req, p, status), null, `${req.method} ${p}`)
    const res = response(status)
    watchRouteAudit(req, res, p, { db: () => db })
    res.emit('finish')
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM operation_audit').get().n, 0)
})

test('the master key is recorded as master and audit failures do not throw', () => {
  assert.equal(
    routeAuditEntry({ method: 'PUT', apiKeyKind: 'master' }, '/api/panel/proxies/config', 200).actor,
    'master',
  )
  const warnings = []
  const res = response(200)
  watchRouteAudit({ method: 'PUT' }, res, '/api/panel/proxies/config', {
    db: () => {
      throw new Error('database is not open')
    },
    log: { warn: (message) => warnings.push(message) },
  })
  assert.doesNotThrow(() => res.emit('finish'))
  assert.equal(warnings.length, 1)
})

test('high-risk routes named by the audit are recorded by route after success', (t) => {
  const db = setup(t)
  for (const [method, p] of [
    ['POST', '/api/panel/vms/vm-01/circuit/reset'],
    ['POST', '/api/panel/update'],
    ['POST', '/api/panel/vms/fleet-update'],
    ['POST', '/api/panel/cluster/nodes/node-a/docker/containers/c1/stop'],
    ['DELETE', '/api/panel/cluster/nodes/node-a/docker/containers/c1'],
  ]) {
    const res = response(200)
    watchRouteAudit({ method, panelUserId: 'u_root' }, res, p, { db: () => db })
    res.emit('finish')
  }
  assert.deepEqual(
    db
      .prepare('SELECT action FROM operation_audit ORDER BY id')
      .all()
      .map((row) => row.action),
    [
      'route:POST /api/panel/vms/:id/circuit/reset',
      'route:POST /api/panel/update',
      'route:POST /api/panel/vms/fleet-update',
      'route:POST /api/panel/cluster/nodes/:nodeId/docker/containers/:containerId/stop',
      'route:DELETE /api/panel/cluster/nodes/:nodeId/docker/containers/:containerId',
    ],
  )
})

test('sensitive actions record operator, source IP, target and time, and fail closed', async (t) => {
  const db = setup(t)
  const req = {
    panelUserId: 'u_ops',
    headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' },
    socket: { remoteAddress: '::ffff:10.0.0.1' },
  }
  await auditSensitiveAction(
    req,
    'vm.shell_ticket',
    'vm-01',
    { login: false },
    {
      db: () => db,
      now: () => Date.parse('2026-11-07T08:00:00.000Z'),
    },
  )
  const row = db.prepare('SELECT actor,action,target,after_json FROM operation_audit').get()
  assert.deepEqual(
    { ...row, after_json: JSON.parse(row.after_json) },
    {
      actor: 'u_ops',
      action: 'vm.shell_ticket',
      target: 'vm-01',
      after_json: { ip: '203.0.113.9', peer: '10.0.0.1', at: '2026-11-07T08:00:00.000Z', login: false },
    },
  )
  await assert.rejects(
    auditSensitiveAction(
      req,
      'proxy.reveal',
      'p1',
      {},
      {
        db: () => {
          throw new Error('database is not open')
        },
      },
    ),
    /database is not open/,
  )
})
