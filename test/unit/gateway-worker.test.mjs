import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase, openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { bodyHash, buildGatewayHeaders, verifyGatewayHeaders } from '../../src/lib/gateway-worker/gateway-auth.mjs'
import { GatewayWorkerRepo } from '../../src/lib/gateway-worker/gateway-repo.mjs'
import { createGatewayInternalReceiptRoute } from '../../src/lib/gateway-worker/gateway-routes.mjs'
import { RequestAttemptsRepo } from '../../src/lib/db/repos/request-attempts-repo.mjs'

test('gateway request signatures reject tampered bodies', () => {
  const body = JSON.stringify({ version: 1, request_id: 'req_1' })
  const headers = buildGatewayHeaders({ secret: 'test-secret', body })
  assert.equal(verifyGatewayHeaders({ secret: 'test-secret', headers, body }).ok, true)
  assert.equal(verifyGatewayHeaders({ secret: 'test-secret', headers, body: body + ' ' }).ok, false)
})

test('Go receipt fixture uses the same canonical payload hash and raw-byte signature contract', () => {
  const fixturePath = path.join(process.cwd(), 'worker', 'internal', 'codexgateway', 'testdata', 'receipt.json')
  const raw = fs.readFileSync(fixturePath)
  const parsed = JSON.parse(raw.toString('utf8'))
  const claimedHash = parsed.payload_hash
  delete parsed.payload_hash
  assert.equal(bodyHash(parsed), claimedHash)
  const now = new Date('2026-11-02T00:00:00.000Z')
  const headers = buildGatewayHeaders({ secret: 'fixture-secret', body: raw, now, nonce: 'fixture-nonce' })
  assert.equal(verifyGatewayHeaders({ secret: 'fixture-secret', headers, body: raw, now }).ok, true)
  assert.notEqual(bodyHash(raw), bodyHash(parsed))
})

test('internal receipt route verifies the signed raw JSON before parsing and rejects nonce replay', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-worker-route-test-'))
  const db = openDatabase({ dataDir: dir })
  const repo = new GatewayWorkerRepo(db)
  repo.upsertInstance({ id: 'gw_fixture', name: 'fixture', base_url: 'http://127.0.0.1:8790', health_state: 'healthy' })
  const previousToken = process.env.KIN_CODEX_GATEWAY_INTERNAL_TOKEN
  process.env.KIN_CODEX_GATEWAY_INTERNAL_TOKEN = 'fixture-secret'
  try {
    const responses = []
    const handler = createGatewayInternalReceiptRoute({
      json: (_res, status, payload) => {
        responses.push({ status, payload })
      },
      readBody: async () => {
        throw new Error('raw reader must be used')
      },
      readRawBody: async () =>
        fs.readFileSync(path.join(process.cwd(), 'worker', 'internal', 'codexgateway', 'testdata', 'receipt.json')),
    })
    const raw = fs.readFileSync(
      path.join(process.cwd(), 'worker', 'internal', 'codexgateway', 'testdata', 'receipt.json'),
    )
    const headers = buildGatewayHeaders({
      secret: 'fixture-secret',
      body: raw,
      now: new Date(),
      nonce: 'route-fixture-nonce',
    })
    const req = { method: 'POST', headers: { ...headers, 'x-kin-gateway-token': 'fixture-secret' } }
    const res = {}
    const url = { pathname: '/internal/v1/gateway/receipts' }
    const first = await handler(req, res, url)
    assert.equal(first, true)
    assert.equal(responses.at(-1).status, 200)
    const replay = await handler(req, res, url)
    assert.equal(replay, undefined)
    assert.equal(responses.at(-1).status, 409)
    assert.equal(responses.at(-1).payload.error.code, 'dispatch_replayed')
  } finally {
    if (previousToken == null) delete process.env.KIN_CODEX_GATEWAY_INTERNAL_TOKEN
    else process.env.KIN_CODEX_GATEWAY_INTERNAL_TOKEN = previousToken
    closeDatabase()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('gateway receipt ingestion is idempotent per instance and dispatch', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-worker-test-'))
  const db = createDatabase({ dataDir: dir })
  const repo = new GatewayWorkerRepo(db)
  repo.upsertInstance({ id: 'gw_test', name: 'test', base_url: 'http://127.0.0.1:8790', health_state: 'healthy' })
  const dispatch = repo.createDispatch({
    requestId: 'req_1',
    instanceId: 'gw_test',
    protocol: 'openai.responses',
    model: 'gpt-test',
    scope: { group_ids: [1] },
    nonce: 'nonce_1',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  })
  const receipt = {
    receipt_id: 'receipt_1',
    dispatch_id: dispatch,
    request_id: 'req_1',
    gateway_instance_id: 'gw_test',
    terminal_state: 'completed',
  }
  assert.equal(repo.ingestReceipt(receipt).duplicate, false)
  assert.equal(repo.ingestReceipt(receipt).duplicate, true)
  assert.equal(repo.listReceipts('req_1').length, 1)
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('stale Worker admission recovers on heartbeat and projection revisions are monotonic', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-worker-cas-test-'))
  const db = createDatabase({ dataDir: dir })
  const repo = new GatewayWorkerRepo(db)
  const heartbeat = new Date().toISOString()
  repo.upsertInstance({
    id: 'gw_cas',
    name: 'cas',
    base_url: 'http://127.0.0.1:8790',
    health_state: 'healthy',
    last_heartbeat_at: heartbeat,
  })
  db.prepare("UPDATE gateway_worker_instances SET last_heartbeat_at=datetime('now','-2 minutes') WHERE id=?").run(
    'gw_cas',
  )
  repo.markStaleInstances()
  assert.equal(repo.getInstance('gw_cas').admission_state, 'expired')
  repo.upsertInstance({
    id: 'gw_cas',
    health_state: 'healthy',
    boot_id: 'boot_recovered',
    last_heartbeat_at: heartbeat,
  })
  assert.equal(repo.getInstance('gw_cas').admission_state, 'admitted')

  db.prepare(
    "INSERT INTO vendors (id,name,external_code,email,tier,root_id,created_by,created_at,updated_at) VALUES ('vendor_cas','CAS','vendor_cas','cas@example.test',1,'vendor_cas','test',?,?)",
  ).run(heartbeat, heartbeat)
  db.prepare(
    "INSERT INTO vendor_resources (id,vendor_id,resource_type,name,status,config_json,created_by,created_at,updated_at) VALUES ('account_cas','vendor_cas','account','Codex CAS','active',?,'test',?,?)",
  ).run(JSON.stringify({ platform: 'codex', execution_kind: 'gateway_worker' }), heartbeat, heartbeat)
  repo.recordProjection({
    accountResourceId: 'account_cas',
    instanceId: 'gw_cas',
    runtimeAccountId: 'runtime_cas',
    projectionRevision: 5,
    credentialRevision: 2,
    status: 'synced',
  })
  repo.recordProjection({
    accountResourceId: 'account_cas',
    instanceId: 'gw_cas',
    runtimeAccountId: 'runtime_old',
    projectionRevision: 4,
    credentialRevision: 1,
    status: 'drifted',
    error: 'stale',
  })
  const binding = repo.getAccountBinding('account_cas', 'gw_cas')
  assert.equal(binding.runtime_account_id, 'runtime_cas')
  assert.equal(binding.projection_revision, 5)
  assert.equal(binding.projection_status, 'synced')

  const dispatch = repo.createDispatch({
    requestId: 'request_cas',
    instanceId: 'gw_cas',
    protocol: 'openai.responses',
    model: 'gpt-test',
    nonce: 'nonce_cas',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  })
  const unsignedReceipt = {
    receipt_id: 'receipt_cas',
    dispatch_id: dispatch,
    request_id: 'request_cas',
    gateway_instance_id: 'gw_cas',
    runtime_account_id: 'runtime_cas',
    credential_revision: 3,
    projection_revision: 6,
    send_state: 'sent',
    terminal_state: 'completed',
    usage_confidence: 'unknown',
  }
  assert.equal(repo.ingestReceipt({ ...unsignedReceipt, payload_hash: bodyHash(unsignedReceipt) }).duplicate, false)
  assert.equal(repo.getAccountBinding('account_cas', 'gw_cas').projection_revision, 6)
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('gateway receipt rejects a tampered payload hash before applying facts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-worker-integrity-test-'))
  const db = createDatabase({ dataDir: dir })
  const repo = new GatewayWorkerRepo(db)
  repo.upsertInstance({
    id: 'gw_integrity',
    name: 'integrity',
    base_url: 'http://127.0.0.1:8790',
    health_state: 'healthy',
  })
  const result = repo.ingestReceipt({
    receipt_id: 'receipt_bad',
    dispatch_id: 'dispatch_bad',
    request_id: 'req_bad',
    gateway_instance_id: 'gw_integrity',
    payload_hash: 'bad-hash',
  })
  assert.equal(result.rejected, true)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM gateway_worker_receipts').get().n, 0)
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})
