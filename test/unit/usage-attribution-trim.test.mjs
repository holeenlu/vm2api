import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase, openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { RequestAttemptsRepo } from '../../src/lib/db/repos/request-attempts-repo.mjs'
import { RelayBilling } from '../../src/lib/admin/relay-billing.mjs'
import { PanelUserStore } from '../../src/lib/admin/panel-users.mjs'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
import { GroupsRepo } from '../../src/lib/db/repos/groups-repo.mjs'
import { usageForStorage } from '../../src/lib/core/usage-persist.mjs'

/** Upstream shape: one attribution entry per assistant message, unbounded. */
function upstreamUsage(messages = 400) {
  const items = {}
  for (let i = 0; i < messages; i++) {
    items[`amsg_01a18a89-0386-7a00-95b9-${String(i).padStart(12, '0')}`] = {
      input_tokens: i,
      cached_tokens: i * 2,
      cache_write_tokens: 0,
      output_tokens: i + 1,
    }
  }
  return {
    input_tokens: 1200,
    output_tokens: 34,
    cache_read_input_tokens: 204800,
    output_tokens_details: { reasoning_tokens: 12 },
    total_tokens: 1234,
    attribution: { items },
  }
}

test('usageForStorage drops attribution and keeps every counter', () => {
  const usage = upstreamUsage(5)
  const stored = usageForStorage(usage)
  assert.equal('attribution' in stored, false)
  assert.equal(stored.input_tokens, 1200)
  assert.equal(stored.output_tokens, 34)
  assert.equal(stored.cache_read_input_tokens, 204800)
  assert.equal(stored.total_tokens, 1234)
  assert.deepEqual(stored.output_tokens_details, { reasoning_tokens: 12 })
  // The caller's object is left alone: billing and key accounting read it after
  // the row is written.
  assert.ok(usage.attribution)
})

test('usageForStorage passes through values it has nothing to trim', () => {
  const plain = { input_tokens: 1, output_tokens: 2 }
  // Same reference, not a copy — this runs per request.
  assert.equal(usageForStorage(plain), plain)
  assert.equal(usageForStorage(null), null)
  assert.equal(usageForStorage(undefined), undefined)
  assert.equal(usageForStorage(0), 0)
  assert.equal(usageForStorage('usage'), 'usage')
  const list = [{ attribution: 1 }]
  assert.equal(usageForStorage(list), list)
})

test('billing_charges stores usage without attribution', (t) => {
  closeDatabase()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-trim-billing-'))
  const db = openDatabase({ dataDir: dir })
  t.after(() => {
    closeDatabase()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const users = new PanelUserStore({ db })
  const user = users.create({ username: 'customer', password: 'customer-pass' })
  const groups = new GroupsRepo(db)
  const group = groups.create({ name: 'service', platform: 'anthropic' })
  groups.setGrants(user.id, [group.id])
  const keys = new ApiKeyStore({ db })
  const key = keys.create({ user_id: user.id, group_id: group.id })
  const billing = new RelayBilling(db)
  billing.adjust(user.id, { amount: 1, reason: 'test credit', idempotency_key: 'credit-1' }, 'test-admin')

  const model = 'claude-sonnet-5'
  const body = { model, max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] }
  const context = billing.authorize(key, 'request-attribution', model, body)
  const usage = upstreamUsage()
  const item = billing.settle(context, usage, model)
  assert.equal(item.status, 'settled')

  const row = db.prepare('SELECT usage_json FROM billing_charges WHERE request_id=?').get('request-attribution')
  const stored = JSON.parse(row.usage_json)
  assert.equal('attribution' in stored, false)
  assert.equal(stored.input_tokens, 1200)
  assert.equal(stored.cache_read_input_tokens, 204800)
  // 400 attribution entries are ~30 KB of JSON; the counters are a few hundred bytes.
  assert.ok(row.usage_json.length < 1000, `usage_json stayed large: ${row.usage_json.length} bytes`)
  // Cost still comes from the counters, so the charge is unchanged.
  assert.ok(item.actual_micros > 0)
})

test('request_attempts stores usage without attribution and still reads back', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-trim-attempts-'))
  const db = createDatabase({ dataDir: dir })
  try {
    const repo = new RequestAttemptsRepo(db)
    repo.begin({ requestId: 'req-attribution', attemptNo: 1, vmId: 'vm-01', accountId: 'account-1' })
    repo.complete('req-attribution', 1, {
      upstreamStatus: 200,
      terminalState: 'verified',
      usage: upstreamUsage(),
    })
    const row = db
      .prepare('SELECT usage_json FROM request_attempts WHERE request_id=? AND attempt_no=1')
      .get('req-attribution')
    assert.equal('attribution' in JSON.parse(row.usage_json), false)
    assert.ok(row.usage_json.length < 1000, `usage_json stayed large: ${row.usage_json.length} bytes`)

    const [attempt] = repo.list('req-attribution')
    assert.equal(attempt.usage.input_tokens, 1200)
    assert.equal(attempt.usage.total_tokens, 1234)
    assert.equal(attempt.usage.attribution, undefined)

    // A completion carrying no usage still clears the column rather than storing "{}".
    repo.complete('req-attribution', 1, { upstreamStatus: 500, terminalState: 'rejected' })
    const cleared = db
      .prepare('SELECT usage_json FROM request_attempts WHERE request_id=? AND attempt_no=1')
      .get('req-attribution')
    assert.equal(cleared.usage_json, null)
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
