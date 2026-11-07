import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PoolScheduler } from '../../src/lib/pool/pool-scheduler.mjs'
import { SeatPlanner } from '../../src/lib/pool/seat-planner.mjs'

// 审计阶段 2 W14：名额账本巡检、VM 队列队头阻塞

function scheduler(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w14-sched-'))
  fs.mkdirSync(path.join(root, 'vms'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const pool = new PoolScheduler({
    projectRoot: root,
    runtimeRepo: {},
    accountQuota: { canAccept: () => ({ ok: true }) },
    workerHealth: async () => ({ ok: true }),
    config: { fallback_wait_timeout_ms: 5, sticky_wait_timeout_ms: 5 },
  })
  t.after(() => pool.stopMaintenance())
  return pool
}

const candidate = (accountId) => ({ accountId, vmId: `vm-${accountId}`, vm: {}, model: 'claude-x', maxConcurrency: 4 })

test('every reservation is on the lease ledger until released, and drift from inflight is reported', (t) => {
  const pool = scheduler(t)
  const a1 = pool.reserveNow(candidate('a'))
  const a2 = pool.reserveNow(candidate('a'))
  const b1 = pool.reserveNow(candidate('b'))
  assert.ok(a1 && a2 && b1)
  assert.deepEqual(pool.auditLeases(), { leases: 3, drift: [], reclaimed: [] })
  a1.release()
  a1.release()
  assert.deepEqual(pool.auditLeases().drift, [])
  // 模拟某条路径只改了计数、没有走租约（泄漏的反面）：账本与 inflight 不一致时报告偏差
  pool.inflight.set('b', 3)
  const warnings = []
  t.mock.method(console, 'warn', (message) => warnings.push(String(message)))
  assert.deepEqual(pool.auditLeases().drift, [{ accountId: 'b', ledger: 1, inflight: 3 }])
  pool.auditLeases()
  assert.equal(warnings.length, 1, 'the same drift is reported once')
  pool.inflight.set('b', 1)
  a2.release()
  b1.release()
  assert.deepEqual(pool.auditLeases(), { leases: 0, drift: [], reclaimed: [] })
  assert.equal(pool.inflight.size, 0)
})

test('a lease held past the maximum is reclaimed through its own idempotent release', (t) => {
  const pool = scheduler(t)
  const lease = pool.reserveNow(candidate('a'))
  t.mock.method(console, 'warn', () => {})
  const [entry] = pool.leases.values()
  entry.acquiredAt -= 7 * 60 * 60 * 1000
  const audit = pool.auditLeases()
  assert.equal(audit.reclaimed.length, 1)
  assert.equal(audit.leases, 0)
  assert.equal(pool.inflight.get('a') || 0, 0)
  // 请求随后正常结束：release 幂等，不会把计数扣成负数或影响其他名额
  const other = pool.reserveNow(candidate('a'))
  lease.release()
  assert.equal(pool.inflight.get('a'), 1)
  other.release()
  assert.equal(pool.inflight.get('a') || 0, 0)
})

test('a VM queue head refused for its own reason does not block the tickets behind it', () => {
  const planner = new SeatPlanner({})
  const ticket = (id, grant) => ({ id, kind: 'conc', vmId: 'vm-1', queued: true, tryGrant: () => grant, wake() {} })
  const head = ticket('head', false)
  const next = ticket('next', true)
  planner.vmQueues.set('vm-1', [head, next])
  planner.pumpOne('vm-1')
  assert.equal(next.queued, false, 'the ticket behind a refused head is granted')
  assert.equal(head.queued, true, 'the refused head keeps its place')
  assert.deepEqual(planner.vmQueues.get('vm-1'), [head])
})

async function singleSlotPool(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w16-wake-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'vms'))
  fs.writeFileSync(
    path.join(root, 'vms', 'vm-01.json'),
    JSON.stringify({
      id: 'vm-01',
      name: 'vm-01',
      status: 'running',
      schedulable: true,
      proxy_cli_enabled: true,
      proxy: { id: 'proxy-vm-01', url: 'socks5h://127.0.0.1:10001' },
      runtime: { worker_socket: path.join(root, 'vms', 'vm-01', 'run', 'worker.sock') },
      policy: { maxConcurrency: 1, concurrencyOverride: true, weight: 1, priority: 0 },
      claude: {
        account_uuid: 'account-1',
        account_tier: 'max',
        access_token: 'access-account-1',
        refresh_token: 'refresh-account-1',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      },
    }),
  )
  fs.writeFileSync(path.join(root, 'vms', 'active.json'), JSON.stringify({ active_vm: 'vm-01' }))
  const states = new Map()
  const pool = new PoolScheduler({
    projectRoot: root,
    runtimeRepo: {
      get: (id) => states.get(id) || null,
      upsert: (state) => states.set(state.account_id, { ...(states.get(state.account_id) || {}), ...state }),
      schedulingSnapshot: async (ids) =>
        new Map(ids.map((id) => [id, { state: states.get(id) || null, account: null }])),
      clearExpired() {},
    },
    accountQuota: { canAccept: () => ({ ok: true }) },
    workerHealth: async () => ({ ok: true, credential: { generation: 1, has_access: true } }),
    config: { fallback_wait_timeout_ms: 8000, sticky_wait_timeout_ms: 8000 },
  })
  t.after(() => pool.stopMaintenance())
  return pool
}

test('a release while the wait plan is being resolved is not lost (no sleep until the wait deadline)', async (t) => {
  const pool = await singleSlotPool(t)
  const first = await pool.selectAndReserve({ model: 'claude-test', allowWait: false })
  assert.equal(first.ok, true)
  // 名额恰好在第二个请求读完资格（判定为忙）之后、登记等待之前释放：释放的唤醒只发给已登记的等待者
  const resolveWaitPlan = pool.resolveWaitPlan.bind(pool)
  t.mock.method(pool, 'resolveWaitPlan', async (args) => {
    first.release()
    return resolveWaitPlan(args)
  })
  const startedAt = Date.now()
  const second = await pool.selectAndReserve({ model: 'claude-test', allowWait: true })
  assert.equal(second.ok, true, `expected a seat, got ${second.code} ${second.reason || ''}`)
  assert.ok(Date.now() - startedAt < 1000, `waited ${Date.now() - startedAt}ms for a seat that was already free`)
  second.release()
})

test('a reserve miss that clears without a capacity notice is retried within the queue refresh, not at the deadline', async (t) => {
  const pool = await singleSlotPool(t)
  // 健康缓存刷新、代理同步、内核故障恢复都不会 notifyCapacity：第一次占位落空后只能靠定期重读
  const reserveNow = pool.reserveNow.bind(pool)
  let misses = 1
  t.mock.method(pool, 'reserveNow', (...args) => (misses-- > 0 ? null : reserveNow(...args)))
  const startedAt = Date.now()
  const selected = await pool.selectAndReserve({ model: 'claude-test', allowWait: true })
  assert.equal(selected.ok, true, `expected a seat, got ${selected.code} ${selected.reason || ''}`)
  const waited = Date.now() - startedAt
  assert.ok(waited < 4000, `waited ${waited}ms; the 8s wait deadline should not be reached`)
  selected.release()
})
