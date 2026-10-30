import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { RequestLogStore } from '../../src/lib/admin/request-log.mjs'
import { relayOps } from '../../src/lib/admin/relay-ops.mjs'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'

test('commercial search rejection is logged and visible without reading the body or reducing SLA', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-search-rejection-'))
  const requestLog = new RequestLogStore({ dataDir, mode: 'normal', jsonlMirror: false })
  t.after(() => {
    requestLog.db.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  const stats = { errors: 0, requests: 0, by_route: {} }
  const { handleSearch } = createHandleProtocol({
    cfg: {
      limits: { max_body_bytes: 1 << 20 },
      paths: {
        get project() {
          assert.fail('rejected search must not reach VM or upstream selection')
        },
      },
    },
    requireAuth(req) {
      req.apiKeyKind = 'managed'
      req.apiKeyRecord = { id: 'commercial-key', user_id: 'customer', group_id: 2 }
      return true
    },
    readBody() {
      assert.fail('rejected search must not read the request body')
    },
    json(res, status, body) {
      res.statusCode = status
      res.body = body
      res.emit('finish')
    },
    requestLog,
    groupsRepo: { rateMultiplier: () => 1 },
    stats,
    routingConfig: {},
  })
  const res = new EventEmitter()
  await handleSearch({ headers: {}, method: 'POST' }, res, '/v1/alpha/search')

  assert.equal(res.statusCode, 403)
  assert.deepEqual(res.body, {
    error: {
      code: 'commercial_search_unpriced',
      message: '独立搜索尚无可核验计量，商业 Key 请使用模型内搜索',
    },
  })
  assert.deepEqual(stats, { errors: 1, requests: 0, by_route: {} })
  assert.deepEqual(requestLog.snapshot().muted_error_classes, ['auth'])
  const { items, total } = requestLog.queryNormal({ status: 'error' })
  assert.equal(total, 1)
  const row = items[0]
  assert.equal(row.status, 403)
  assert.equal(row.error_code, res.body.error.code)
  assert.equal(row.error_message, res.body.error.message)
  assert.equal(row.final_state, 'rejected')
  assert.equal(row.error_class, 'request')
  assert.equal(row.error_owner, 'client')
  assert.equal(row.model, null)
  assert.equal(row.vm_id, null)
  assert.equal(row.account_id, null)
  assert.equal(row.attempt_count, null)

  requestLog.finish(
    requestLog.start({ headers: {}, method: 'POST' }, { protocol: 'openai.responses', pathName: '/v1/responses' }),
    { status: 200, final_state: 'verified', model: 'gpt-6.1-sol', vm_id: 'test-vm' },
  )
  const window = requestLog.windowStats({ since: new Date(Date.now() - 60_000).toISOString() })
  assert.equal(window.requests, 2)
  assert.equal(window.errors, 0)
  assert.equal(window.sla, 1)
  assert.equal(window.error_collection.total, 1)
  assert.equal(window.error_collection.by_class[0].id, 'request')

  const ops = relayOps(requestLog.db, {}, [{ id: 'test-vm', status: 'running', schedulable: true, has_token: true }])
  assert.equal(ops.traffic.requests, 2)
  assert.equal(ops.traffic.client_rejections, 1)
  assert.equal(ops.traffic.server_errors, 0)
  assert.equal(ops.traffic.sla, 1)
  assert.equal(
    ops.alerts.some((alert) => alert.code === 'service_failures'),
    false,
  )
})
