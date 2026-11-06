import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, openDatabase } from '../../src/lib/db/database.mjs'
import { rememberBodyFields, routeAuditEntry, watchRouteAudit } from '../../src/lib/admin/route-audit.mjs'

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-audit-'))
  const db = openDatabase({ dataDir: dir })
  t.after(() => {
    closeDatabase()
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
