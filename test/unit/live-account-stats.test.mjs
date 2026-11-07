import assert from 'node:assert/strict'
import test from 'node:test'
import { LiveAccountStats, liveAccountKey } from '../../src/lib/admin/live-account-stats.mjs'

test('live stats key gateway accounts by resource id and skip rows without an account', () => {
  assert.equal(liveAccountKey('gateway:acc-1'), 'acc-1')
  assert.equal(liveAccountKey('vm-08'), 'vm-08')
  let now = 0
  const stats = new LiveAccountStats({ now: () => now })
  stats.record({ status: 503 })
  stats.record({ vm_id: 'gateway:acc-1', status: 200, input_tokens: 10, output_tokens: 5 })
  assert.deepEqual(Object.keys(stats.snapshot().accounts), ['acc-1'])
})

test('live stats split the 1 minute rate from the 5 minute quality window', () => {
  let now = 1_000_000
  const stats = new LiveAccountStats({ now: () => now })
  stats.record({
    vm_id: 'vm-1',
    status: 200,
    input_tokens: 100,
    output_tokens: 20,
    cache_read_tokens: 300,
    cache_creation_tokens: 0,
    first_token_ms: 2000,
    duration_ms: 9000,
  })
  now += 2 * 60 * 1000
  stats.record({ vm_id: 'vm-1', status: 429, input_tokens: 50, output_tokens: 0, duration_ms: 1000 })
  const vm = stats.snapshot().accounts['vm-1']
  // 最近 1 分钟只有第二条
  assert.equal(vm.requests_1m, 1)
  assert.equal(vm.tokens_1m, 50)
  assert.equal(vm.io_tokens_1m, 50)
  // 5 分钟窗口两条都在
  assert.equal(vm.requests, 2)
  assert.equal(vm.success, 1)
  assert.equal(vm.prompt_tokens, 450)
  assert.equal(vm.cache_read_tokens, 300)
  assert.deepEqual([vm.ttft_sum, vm.ttft_n], [2000, 1])
  assert.deepEqual([vm.latency_sum, vm.latency_n], [10000, 2])
  // 超过 5 分钟后过期
  now += 4 * 60 * 1000
  const later = stats.snapshot()
  assert.equal(later.accounts['vm-1'].requests, 1)
  now += 2 * 60 * 1000
  assert.deepEqual(stats.snapshot().accounts, {})
  assert.equal(stats.snapshot().total.requests, 0)
})

test('live stats cap memory by dropping the oldest rows', () => {
  const stats = new LiveAccountStats({ now: () => 0, maxEntries: 3 })
  for (let i = 0; i < 5; i += 1) stats.record({ vm_id: `vm-${i}`, status: 200 })
  assert.deepEqual(Object.keys(stats.snapshot().accounts), ['vm-2', 'vm-3', 'vm-4'])
})
