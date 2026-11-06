// 数据访问分层 R6 B7b：Claude 调度异步化后的竞态修复（R9–R13）与调度链的异步接口
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { AccountQuota } from '../../src/lib/pool/account-quota.mjs'
import { AccountsRepo } from '../../src/lib/db/repos/accounts-repo.mjs'
import { AccountRuntimeRepo } from '../../src/lib/db/repos/account-runtime-repo.mjs'
import { StickyRepo } from '../../src/lib/db/repos/sticky-repo.mjs'
import { RequestAttemptsRepo } from '../../src/lib/db/repos/request-attempts-repo.mjs'
import { StickyRouter } from '../../src/lib/pool/sticky-router.mjs'
import { PoolScheduler } from '../../src/lib/pool/pool-scheduler.mjs'
import { UnitCircuit } from '../../src/lib/pool/unit-circuit.mjs'
import { RateLimitService } from '../../src/lib/pool/rate-limit-service.mjs'
import { FailoverRunner } from '../../src/lib/pool/failover-runner.mjs'
import { evaluateSlotGate } from '../../src/lib/pool/schedule-eligibility.mjs'
import { isVmScheduleReady } from '../../src/lib/vm/vm-registry.mjs'
import { refreshKeyScope } from '../../src/lib/admin/key-scope.mjs'
import { filterThinkingForAccount, recordThinkingOwners } from '../../src/lib/pool/thinking-owner.mjs'
import { countSqlSites } from '../../scripts/sql-boundary.mjs'

const MODEL = 'claude-sonnet-5-5'

/**
 * 并发注入：前 `n` 次调用都读到旧值后才一起放行（只用微任务，不让出事件循环，事务内也安全）。
 * 模拟“查之后、写之前”被另一个请求插进来。
 */
function barrier(n) {
  let waiting = 0
  let open
  const gate = new Promise((resolve) => (open = resolve))
  return async (value) => {
    waiting += 1
    if (waiting >= n) open()
    if (waiting <= n) await gate
    return value
  }
}

function writeVm(root, id, accountId, concurrency) {
  fs.writeFileSync(
    path.join(root, 'vms', `${id}.json`),
    JSON.stringify({
      id,
      name: id,
      status: 'running',
      schedulable: true,
      proxy_cli_enabled: true,
      proxy: { id: `proxy-${id}`, url: 'socks5h://127.0.0.1:10001' },
      policy: { maxConcurrency: concurrency, concurrencyOverride: true },
      claude: {
        account_uuid: accountId,
        account_tier: 'max',
        access_token: `synthetic-${id}`,
        refresh_token: `synthetic-refresh-${id}`,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      },
    }),
  )
}

async function fixture(t, { vms = 1, concurrency = 2, sticky = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r6-b7b-'))
  const db = createDatabase({ dataDir: path.join(root, 'data') })
  fs.mkdirSync(path.join(root, 'vms'))
  const quota = new AccountQuota({ db, config: { concurrency: { default_max_per_account: concurrency } } })
  const runtime = new AccountRuntimeRepo(db)
  quota.attachRuntimeRepo(runtime)
  for (let n = 1; n <= vms; n++) {
    const id = `vm-0${n}`
    const accountId = `r6-account-${n}`
    await quota.ensure({ account_id: accountId, vm_id: id, max_concurrency: concurrency, concurrency_override: true })
    writeVm(root, id, accountId, concurrency)
  }
  const stickyRouter = sticky
    ? await StickyRouter.create({ db, config: { sticky: { enabled: true, ttl_seconds: 600 } } })
    : null
  const pool = new PoolScheduler({
    projectRoot: root,
    runtimeRepo: runtime,
    accountQuota: quota,
    stickyRouter,
    workerHealth: async () => ({ ok: true, healthy: true }),
    config: { worker_health_ttl_ms: 60_000, default_session_slots: 20, fallback_wait_timeout_ms: 500 },
  })
  pool.unitCircuit = new UnitCircuit({ repo: runtime })
  t.after(async () => {
    pool.stopMaintenance()
    await pool.maintenanceFlight
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { root, db, quota, runtime, pool, stickyRouter }
}

test('R9: concurrent reserves on one account never exceed max_concurrency', async (t) => {
  const { pool, runtime } = await fixture(t, { concurrency: 2 })
  const [candidate] = await pool.eligibleCandidates({ model: MODEL })
  // 注入：每个 reserve 都在读快照（复核所需的数据）之后停住，直到 10 个都读完，再各自进入同步段
  const read = runtime.schedulingSnapshot.bind(runtime)
  const hold = barrier(10)
  runtime.schedulingSnapshot = async (ids) => hold(await read(ids))
  const leases = await Promise.all(Array.from({ length: 10 }, () => pool.reserve(candidate)))
  assert.equal(leases.filter(Boolean).length, 2)
  assert.equal(pool.inflight.get(candidate.accountId), 2)
  assert.equal(pool.accountQuota.inflight.get(candidate.accountId), 2)
  for (const lease of leases) lease?.release()
  assert.equal(pool.inflight.size, 0)
})

test('R9: concurrent selections (direct and seat path) admit at most max_concurrency per account', async (t) => {
  const { pool } = await fixture(t, { concurrency: 2 })
  const direct = await Promise.all(
    Array.from({ length: 6 }, () => pool.selectAndReserve({ model: MODEL, allowWait: false })),
  )
  assert.equal(direct.filter((r) => r.ok).length, 2)
  assert.equal(pool.inflight.get('r6-account-1'), 2)
  for (const r of direct) if (r.ok) r.release()
  const seats = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      pool.selectAndReserve({ model: MODEL, allowWait: false, seatKey: `seat:sess:r9-${i}` }),
    ),
  )
  assert.equal(seats.filter((r) => r.ok).length, 2)
  assert.ok((pool.inflight.get('r6-account-1') || 0) <= 2)
  for (const r of seats) if (r.ok) r.release()
  assert.equal(pool.inflight.size, 0)
})

test('R10: concurrent first ensure of one account does not collide on the primary key', async (t) => {
  const db = createDatabase({ dbPath: ':memory:' })
  t.after(() => db.close())
  const quota = new AccountQuota({ db, config: {} })
  // 注入：8 个 ensure 都先读到“不存在”，再一起插入
  const get = quota.repo.get.bind(quota.repo)
  const hold = barrier(8)
  quota.repo.get = async (id) => hold(await get(id))
  const rows = await Promise.all(
    Array.from({ length: 8 }, () => quota.ensure({ account_id: 'r10-new', vm_id: 'vm-r10', email: 'a@x' })),
  )
  assert.ok(rows.every((row) => row?.account_id === 'r10-new' && row.vm_id === 'vm-r10'))
  assert.equal(db.prepare("SELECT COUNT(*) n FROM accounts WHERE id='r10-new'").get().n, 1)
})

test('R10: tryAcquire checks and increments in one synchronous step', async (t) => {
  const db = createDatabase({ dbPath: ':memory:' })
  t.after(() => db.close())
  const quota = new AccountQuota({ db, config: {} })
  const account = await quota.ensure({ account_id: 'r10-cap', max_concurrency: 2, concurrency_override: 1 })
  const results = Array.from({ length: 5 }, () => quota.tryAcquire('r10-cap', { account }))
  assert.ok(
    results.every((r) => typeof r?.then !== 'function'),
    'tryAcquire must not return a Promise',
  )
  assert.equal(results.filter((r) => r.ok).length, 2)
  assert.equal(quota.inflight.get('r10-cap'), 2)
})

test('R11/R12: concurrent cooldown, window, circuit and model updates keep every field', async (t) => {
  const db = createDatabase({ dbPath: ':memory:' })
  t.after(() => db.close())
  const repo = new AccountRuntimeRepo(db)
  await repo.upsert({ account_id: 'r12', vm_id: 'vm-r12', status: 'ready', priority: 3, weight: 5 })
  const circuit = new UnitCircuit({ repo, failureThreshold: 1, openMs: 60_000 })
  await circuit.load('r12')
  const until = Date.now() + 600_000
  // 注入：5 个更新都先读完行，再各自写入（原整行读改写会互相覆盖）
  const get = repo.get.bind(repo)
  const hold = barrier(5)
  repo.get = async (id) => hold(await get(id))
  await Promise.all([
    repo.markCooldown('r12', { vmId: 'vm-r12', until, reason: 'model_rate_limit', model: 'claude-a' }),
    repo.markCooldown('r12', { vmId: 'vm-r12', until, reason: 'model_rate_limit', model: 'claude-b' }),
    repo.markCooldown('r12', { vmId: 'vm-r12', until, reason: 'rpm_limited' }),
    repo.updateWindow('r12', { vmId: 'vm-r12', overloadUntil: until, sessionWindowStatus: 'allowed' }),
    circuit.recordFailure('r12'),
  ])
  repo.get = get
  const state = await repo.get('r12')
  assert.equal(state.model_states['claude-a'].reason, 'model_rate_limit')
  assert.equal(state.model_states['claude-b'].reason, 'model_rate_limit')
  assert.equal(state.model_states.__circuit.state, 'open')
  assert.equal(state.cooldown_reason, 'rpm_limited')
  assert.equal(state.cooldown_until, until)
  assert.equal(state.overload_until, until)
  assert.equal(state.session_window_status, 'allowed')
  assert.equal(state.priority, 3)
  assert.equal(state.weight, 5)
})

test('R11: the circuit admit runs in memory and persists only its own model_states key', async (t) => {
  const db = createDatabase({ dbPath: ':memory:' })
  t.after(() => db.close())
  const repo = new AccountRuntimeRepo(db)
  await repo.upsert({ account_id: 'r11', vm_id: 'vm-r11', status: 'ready' })
  const circuit = new UnitCircuit({ repo, failureThreshold: 1, openMs: 1 })
  await circuit.recordFailure('r11')
  await new Promise((resolve) => setTimeout(resolve, 5))
  await repo.markCooldown('r11', { vmId: 'vm-r11', until: Date.now() + 60_000, reason: 'x', model: 'claude-c' })
  const admitted = circuit.admit('r11')
  assert.equal(typeof admitted?.then, 'undefined', 'admit must stay synchronous')
  assert.equal(admitted.probe, true)
  assert.equal(circuit.admit('r11').ok, false, 'a second caller stays out while the probe is held')
  await new Promise((resolve) => setImmediate(resolve))
  const state = await repo.get('r11')
  assert.equal(state.model_states.__circuit.state, 'half_open')
  assert.equal(state.model_states['claude-c'].reason, 'x')
})

test('R13: concurrent binds of one session from no row end on one VM', async (t) => {
  const db = createDatabase({ dbPath: ':memory:' })
  t.after(() => db.close())
  const router = await StickyRouter.create({ db, config: { sticky: { enabled: true, ttl_seconds: 600 } } })
  // 注入：两个请求都先读到“没有绑定”，再各自写入
  const get = router.repo.get.bind(router.repo)
  const hold = barrier(2)
  router.repo.get = async (key) => hold(await get(key))
  await Promise.all([
    router.bind('sess:r13', { accountId: 'acc-a', vmId: 'vm-a' }),
    router.bind('sess:r13', { accountId: 'acc-b', vmId: 'vm-b' }),
  ])
  router.repo.get = get
  const bound = await router.resolve('sess:r13')
  assert.ok(bound.vmId === 'vm-a' || bound.vmId === 'vm-b')
  const loser = bound.vmId === 'vm-a' ? { accountId: 'acc-b', vmId: 'vm-b' } : { accountId: 'acc-a', vmId: 'vm-a' }
  // 后来的写入按胜者锁定（VM 与账号都不同），不把会话挪走
  await router.bind('sess:r13', loser)
  assert.equal((await router.resolve('sess:r13')).vmId, bound.vmId)
  assert.equal((await router.claim('sess:r13', loser)).vmId, bound.vmId)
})

test('R13: concurrent first requests of one session resolve to the same VM', async (t) => {
  const { pool, stickyRouter } = await fixture(t, { vms: 2, concurrency: 4, sticky: true })
  // 两个请求按设备偏好各自先选了不同的 VM；注入：两边的首次绑定都先读到“没有绑定”
  const get = stickyRouter.repo.get.bind(stickyRouter.repo)
  let gate = null
  stickyRouter.repo.get = async (key) => {
    const row = await get(key)
    if (key === 'sess:r13-pool' && !row) {
      gate ||= barrier(2)
      return gate(row)
    }
    return row
  }
  const [first, second] = await Promise.all([
    pool.selectAndReserve({ model: MODEL, allowWait: false, stickyKey: 'sess:r13-pool', deviceVmId: 'vm-01' }),
    pool.selectAndReserve({ model: MODEL, allowWait: false, stickyKey: 'sess:r13-pool', deviceVmId: 'vm-02' }),
  ])
  stickyRouter.repo.get = get
  assert.ok(first.ok && second.ok)
  const bound = await stickyRouter.resolve('sess:r13-pool')
  assert.equal(first.vmId, bound.vmId)
  assert.equal(second.vmId, bound.vmId)
  // 换到胜者的一方交回了自己的预占
  assert.equal(pool.inflight.get(bound.accountId), 2)
  assert.equal(pool.inflight.size, 1)
  first.release()
  second.release()
  assert.equal(pool.inflight.size, 0)
})

test('B7b: the Claude scheduling chain reads the database asynchronously', () => {
  const isAsync = (fn) => fn?.constructor?.name === 'AsyncFunction'
  for (const [owner, names] of [
    [AccountsRepo.prototype, ['get', 'list', 'insert', 'insertIfAbsent', 'save', 'setLastBlocked', 'addAllocation']],
    [AccountRuntimeRepo.prototype, ['schedulingSnapshot', 'get', 'list', 'upsert', 'markCooldown', 'updateWindow']],
    [AccountRuntimeRepo.prototype, ['clearAuthCooldown', 'clearGrantRevokeCooldown', 'clearExpired']],
    [AccountRuntimeRepo.prototype, ['getProtectionState', 'compareAndSwapProtectionState', 'setModelState']],
    [StickyRepo.prototype, ['get', 'upsert', 'compareAndSet', 'remove', 'all', 'purgeExpired', 'dropAliasKeys']],
    [RequestAttemptsRepo.prototype, ['begin', 'record', 'complete', 'list', 'cleanup']],
    [StickyRouter.prototype, ['resolve', 'bind', 'claim', 'extractPoolKey', 'sessionPoolKeys', 'familyPoolKey']],
    [AccountQuota.prototype, ['ensure', 'canAccept', 'ingestHeaders', 'ingestOAuthUsage', 'snapshot']],
    [UnitCircuit.prototype, ['inspect', 'recordFailure', 'recordSuccess', 'view', 'reset']],
    [RateLimitService.prototype, ['handleUpstreamError', 'handle429', 'handle529', 'updateSessionWindow']],
    [PoolScheduler.prototype, ['reserve', 'prepareAdmission', 'reconcileSticky', 'markSuccess', 'markCooldown']],
    [FailoverRunner.prototype, ['accountProtection', 'noteUnitHealth']],
  ])
    for (const name of names) assert.ok(isAsync(owner[name]), `${owner.constructor.name}.${name} is async`)
  for (const fn of [
    refreshKeyScope,
    evaluateSlotGate,
    isVmScheduleReady,
    filterThinkingForAccount,
    recordThinkingOwners,
  ])
    assert.ok(isAsync(fn), `${fn.name} is async`)
  // 同步段只剩纯内存：预占与熔断放行不返回 Promise（见 R9/R11 用例）
  for (const name of ['reserveNow', 'claimSeat', 'pick', 'admissionSnapshot'])
    assert.equal(isAsync(PoolScheduler.prototype[name]), false, `PoolScheduler.${name} stays synchronous`)
  assert.equal(isAsync(AccountQuota.prototype.tryAcquire), false)
  assert.equal(isAsync(UnitCircuit.prototype.admit), false)
  // thinking-owner 的 SQL 移进仓储（db/repos/thinking-owners-repo.mjs）
  const source = fs.readFileSync(new URL('../../src/lib/pool/thinking-owner.mjs', import.meta.url), 'utf8')
  assert.equal(countSqlSites(source), 0)
})
