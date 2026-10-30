import test from 'node:test'
import assert from 'node:assert/strict'
import { filterAccountRows, canReauthorizeAccount } from '../../src/shared/vendor-account-filters.mjs'
const now = Date.parse('2026-10-30T06:00:00Z')
const make = (id, telemetry = {}, extra = {}) => ({
  id,
  name: 'vm-' + id,
  status: 'active',
  created_at: '2026-10-29T16:00:00Z',
  config: { platform: 'anthropic', auth_method: 'oauth' },
  groups: [{ id: 1 }],
  telemetry: { state: 'available', schedulable: true, email: id + '@example.test', ...telemetry },
  ...extra,
})
const rows = [
  make('normal', { total_cost: 8, fable_cost: 2 }),
  make('limit', {
    state: 'cooling',
    schedulable: false,
    total_cost: 3,
    fable_cost: 1,
    utilization_7d: 1,
    reset_7d: '2026-11-01T00:00:00Z',
  }),
  make(
    'error',
    { state: 'error', schedulable: false, failure_category: 'authentication' },
    { config: { platform: 'openai', auth_method: 'oauth' }, groups: [{ id: 2 }] },
  ),
  make('paused', { state: 'paused', schedulable: false }, { status: 'paused' }),
  make('archive', { state: 'archived' }, { status: 'archived' }),
]
const ids = (q) =>
  filterAccountRows(rows, q, now)
    .map((r) => r.id)
    .sort()
test('account filters distinguish health, quota cooldown, scheduling and archived data', () => {
  assert.deepEqual(ids({ status: 'normal' }), ['limit', 'normal'])
  assert.deepEqual(ids({ status: 'error' }), ['error'])
  assert.deepEqual(ids({ status: 'paused' }), ['paused'])
  assert.deepEqual(ids({ cooldown: '7d' }), ['limit'])
  assert.deepEqual(ids({ cooldown: 'fable' }), [])
  assert.deepEqual(ids({ schedulable: 'yes' }), ['normal'])
  assert.deepEqual(ids({ archived: 'only' }), ['archive'])
  assert.equal(ids({ archived: 'all' }).length, 5)
})
test('combined search/platform/group/method/date/failure filters apply and use Shanghai day boundaries', () => {
  assert.deepEqual(
    ids({
      search: '  ERROR@EXAMPLE.TEST ',
      platform: 'openai',
      group: '2',
      method: 'oauth',
      failure: 'authentication',
      from: '2026-10-30',
      to: '2026-10-30',
    }),
    ['error'],
  )
  assert.deepEqual(ids({ platform: 'openai', group: '1' }), [])
  assert.deepEqual(ids({ to: '2026-10-29' }), [])
  assert.deepEqual(ids({ method: 'apikey' }), [])
  assert.deepEqual(ids({ from: 'invalid' }), [])
})
test('cost sorting puts unknown last in both directions and never changes the input', () => {
  assert.deepEqual(
    filterAccountRows(rows, { sort: 'cost_asc' }, now)
      .slice(0, 2)
      .map((r) => r.id),
    ['limit', 'normal'],
  )
  assert.deepEqual(
    filterAccountRows(rows, { sort: 'fable_desc' }, now)
      .slice(0, 2)
      .map((r) => r.id),
    ['normal', 'limit'],
  )
  assert.equal(rows[0].id, 'normal')
})
test('only abnormal or unauthorised live accounts expose reauthorisation', () => {
  for (const row of rows) assert.equal(canReauthorizeAccount(row), row.id === 'error')
  assert.equal(canReauthorizeAccount(make('new', { state: 'unauthorized' })), true)
  assert.equal(canReauthorizeAccount(make('archived', { requires_authorization: true }, { status: 'archived' })), false)
})
