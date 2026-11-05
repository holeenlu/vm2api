import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ApiScheduler,
  stripPrefix,
  resolveUpstreamPool,
  modelIdsForEndpoint,
} from '../../src/lib/pool/api-scheduler.mjs'

const ep = (over = {}) => ({
  id: 'ep1',
  name: 'one',
  disabled: false,
  prefix: 'team',
  priority: 0,
  disable_cooling: false,
  models: [
    { name: 'claude-sonnet-4-6', alias: 'sonnet' },
    { name: 'claude-opus-4-6', alias: 'opus' },
    { name: 'upstream-a', alias: 'pool' },
    { name: 'upstream-b', alias: 'pool' },
  ],
  api_key_entries: [
    { id: 'k1', api_key: 'aaaa', disabled: false },
    { id: 'k2', api_key: 'bbbb', disabled: false },
  ],
  ...over,
})

test('prefix strip and catalog ids', () => {
  assert.equal(stripPrefix('team/sonnet', 'team'), 'sonnet')
  const ids = modelIdsForEndpoint(ep())
  assert.ok(ids.includes('sonnet'))
  assert.ok(ids.includes('team/sonnet'))
})

test('same alias builds upstream name pool', () => {
  assert.deepEqual(resolveUpstreamPool(ep(), 'pool'), ['upstream-a', 'upstream-b'])
  assert.deepEqual(resolveUpstreamPool(ep(), 'team/pool'), ['upstream-a', 'upstream-b'])
})

test('grouped round-robin walks keys then endpoints', () => {
  const s = new ApiScheduler()
  const a = ep({
    id: 'a',
    prefix: '',
    models: [{ name: 'u1', alias: 'm' }],
    api_key_entries: [{ id: 'a1', api_key: '1', disabled: false }],
  })
  const b = ep({
    id: 'b',
    prefix: '',
    models: [{ name: 'u2', alias: 'm' }],
    api_key_entries: [{ id: 'b1', api_key: '2', disabled: false }],
  })
  s.reload([a, b])
  const first = s.pick('m')
  const second = s.pick('m')
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.notEqual(first.endpoint.id, second.endpoint.id)
})

test('catalog is unique aliases', () => {
  const s = new ApiScheduler()
  s.reload([ep({ prefix: '' }), ep({ id: 'ep2', prefix: '', name: 'two' })])
  const cat = s.catalog()
  const ids = cat.data.map((x) => x.id)
  assert.equal(ids.filter((id) => id === 'sonnet').length, 1)
})

test('group scoping preserves upstream rotation, prefix routing and cooldown without exposing other addresses', () => {
  const s = new ApiScheduler()
  const now = Date.now()
  const a = ep({ id: 'a', prefix: 'team-a', priority: 10 })
  const b = ep({ id: 'b', prefix: 'team-b', priority: 0 })
  const excluded = ep({ id: 'excluded', prefix: 'secret', priority: 100 })
  s.reload([excluded, b, a])
  const allowed = ['a', 'b']
  assert.deepEqual(
    Array.from({ length: 4 }, () => s.pick('sonnet', now, allowed).endpoint.id),
    ['a', 'b', 'a', 'b'],
  )
  assert.equal(s.pick('team-b/sonnet', now, allowed).endpoint.id, 'b')
  assert.equal(s.pick('secret/sonnet', now, allowed).ok, false)
  assert.equal(s.pick('sonnet', now, []).ok, false)
  assert.ok(s.catalog(allowed).data.every((model) => !model.id.startsWith('secret/')))
  for (const key of a.api_key_entries) key.cooldown_until = new Date(now + 60_000).toISOString()
  assert.equal(s.pick('sonnet', now, allowed).endpoint.id, 'b')
  b.disabled = true
  assert.equal(s.pick('sonnet', now, allowed).code, 'api_pool_exhausted')
  a.disable_cooling = true
  assert.equal(s.pick('sonnet', now, allowed).endpoint.id, 'a')
})
