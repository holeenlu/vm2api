// 数据访问分层 R6 B7c：Codex 热路径与 VM 汇总异步化后的竞态（R13 的 Codex 部分）、诊断写入与删除的临时同步出口
import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase, openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { handleCodexProtocol, pickCodexCandidates } from '../../src/lib/protocol/handle-codex.mjs'
import { resetOpenAIAccountRuntime } from '../../src/lib/pool/openai-account-runtime.mjs'
import { StickyRouter } from '../../src/lib/pool/sticky-router.mjs'
import { StickyRepo } from '../../src/lib/db/repos/sticky-repo.mjs'
import { AccountRuntimeRepo } from '../../src/lib/db/repos/account-runtime-repo.mjs'
import { ApiKeysRepo } from '../../src/lib/db/repos/api-keys-repo.mjs'
import { UsersRepo } from '../../src/lib/db/repos/users-repo.mjs'
import { GroupsRepo } from '../../src/lib/db/repos/groups-repo.mjs'
import { SettingsRepo } from '../../src/lib/db/repos/settings-repo.mjs'
import { CodexAccountProtection } from '../../src/lib/pool/codex-account-protection.mjs'
import { listVms, summarizeVm } from '../../src/lib/vm/vm-registry.mjs'
import * as keyScope from '../../src/lib/admin/key-scope.mjs'
import * as resourceScope from '../../src/lib/admin/resource-scope.mjs'
import * as resourceOwner from '../../src/lib/admin/resource-owner.mjs'
import * as runtimePolicy from '../../src/lib/vendor/vendor-runtime-policy.mjs'
import * as runtimePolicyRepo from '../../src/lib/vendor/repos/runtime-policy-repo.mjs'
import * as vendorsRepo from '../../src/lib/vendor/repos/vendors-repo.mjs'
import * as resourcesRepo from '../../src/lib/vendor/repos/resources-repo.mjs'
import * as accountName from '../../src/lib/vendor/vendor-account-name.mjs'

beforeEach(() => resetOpenAIAccountRuntime())

const response = {
  id: 'resp_r6',
  object: 'response',
  model: 'gpt-5.5',
  status: 'completed',
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
  usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
}

/** 前 n 次调用都到齐后一起放行（只用微任务）；之后的调用直接通过。 */
function barrier(n) {
  let arrived = 0
  let open
  const gate = new Promise((resolve) => (open = resolve))
  return {
    get arrived() {
      return arrived
    },
    async arrive() {
      arrived += 1
      if (arrived >= n) open()
      if (arrived <= n) await gate
    },
  }
}

function project(t, ids, { concurrency = 1 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-r6-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const id of ids) {
    fs.mkdirSync(path.join(root, 'vms', id), { recursive: true })
    fs.writeFileSync(
      path.join(root, 'vms', `${id}.json`),
      JSON.stringify({
        id,
        platform: 'openai',
        family: 'codex',
        schedulable: true,
        status: 'running',
        has_token: true,
        policy: { maxConcurrency: concurrency, concurrencyOverride: true },
      }),
    )
    fs.writeFileSync(
      path.join(root, 'vms', id, 'codex-credentials.json'),
      JSON.stringify({
        accounts: [{ id, access_token: 'test-only', refresh_token: 'test-only', chatgpt_account_id: id }],
      }),
    )
  }
  return root
}

function request(root, { hop, headers = {}, body = {}, stickyRouter = null, ops = {} } = {}) {
  const inbound = { model: 'gpt-5.5', input: 'hi', stream: false, ...body }
  const res = { headersSent: false, statusCode: 0, body: null, write() {}, end() {} }
  return {
    res,
    args: {
      req: { headers, apiKeyKind: 'user' },
      res,
      protocol: 'openai.responses',
      ctx: { body: inbound },
      inbound,
      logBag: {},
      stats: { errors: 0, requests: 0, by_route: {} },
      json(_res, status, value) {
        res.statusCode = status
        res.body = value
      },
      writeSSEHeaders() {
        res.statusCode = 200
        res.headersSent = true
      },
      projectRoot: root,
      routing: {},
      stickyRouter,
      ops: {
        writeCodexKernelConfig() {},
        ensureCodexKernel: async () => ({ ok: true }),
        streamCodexKernel: hop,
        ...ops,
      },
    },
  }
}

/** 账号保护替身：候选准入最后一次读库（frozenUntil）处放栅栏，读完的请求一起进入同步占座。 */
function protectionWithBarrier(gate) {
  return {
    async frozenUntil() {
      await gate.arrive()
      return new Map()
    },
    async capture() {
      return { compiled: { policy: { enabled: false } }, epoch: 0 }
    },
    async until() {
      return 0
    },
    async observe() {
      return null
    },
  }
}

test('R13 (Codex): concurrent admissions on one account never exceed its concurrency', async (t) => {
  const N = 6
  const CAP = 2
  const root = project(t, ['gpt-a'], { concurrency: CAP })
  const gate = barrier(N)
  let inFlight = 0
  let peak = 0
  let arrivedAtFirstHop = null
  const hop = async ({ onEvent }) => {
    arrivedAtFirstHop ??= gate.arrived
    inFlight += 1
    peak = Math.max(peak, inFlight)
    await new Promise((resolve) => setTimeout(resolve, 15))
    inFlight -= 1
    await onEvent(`data: ${JSON.stringify({ type: 'response.completed', response })}\n\n`)
    return { ok: true, status: 200, body: response, usage: response.usage, terminalState: 'verified' }
  }
  const protection = protectionWithBarrier(gate)
  const runs = Array.from({ length: N }, () => request(root, { hop, ops: { accountProtection: protection } }))
  await Promise.all(runs.map((run) => handleCodexProtocol(run.args)))
  // 所有请求都读完候选后才有第一个占座：同步占座段确实面对并发
  assert.equal(arrivedAtFirstHop, N)
  assert.equal(peak, CAP)
  assert.deepEqual(
    runs.map((run) => run.res.statusCode),
    Array(N).fill(200),
  )
})

test('R13 (Codex): concurrent requests of one session end with one binding (first winner kept)', async (t) => {
  const root = project(t, ['gpt-a', 'gpt-b'], { concurrency: 1 })
  const stickyRouter = new StickyRouter({ dataDir: path.join(root, 'data'), config: { sticky: { enabled: true } } })
  t.after(() => stickyRouter.db?.close?.())
  const gate = barrier(2)
  const served = []
  let finish
  const finished = new Promise((resolve) => (finish = resolve))
  const hop = async ({ exec, onEvent }) => {
    served.push(exec.vmId)
    if (served.length === 2) finish()
    // 两个 hop 在同一时刻完成：之后的 bind 在微任务层面交错（条件写，竞态 R13）
    await finished
    await onEvent(`data: ${JSON.stringify({ type: 'response.completed', response })}\n\n`)
    return { ok: true, status: 200, body: response, usage: response.usage, terminalState: 'verified' }
  }
  const headers = { 'x-session-id': 'r6-b7c-session' }
  const protection = protectionWithBarrier(gate)
  const runs = [1, 2].map(() => request(root, { hop, headers, stickyRouter, ops: { accountProtection: protection } }))
  await Promise.all(runs.map((run) => handleCodexProtocol(run.args)))
  assert.deepEqual(
    runs.map((run) => run.res.statusCode),
    [200, 200],
  )
  // 两个请求都没读到绑定：一个座位只卖一次，第二个请求借另一个 VM
  assert.deepEqual([...served].sort(), ['gpt-a', 'gpt-b'])
  const keys = stickyRouter.collectPoolKeys(runs[0].args.req, runs[0].args.inbound, { platform: 'openai' })
  assert.equal(keys.length, 1)
  const row = await new StickyRepo(stickyRouter.db).get(keys[0])
  assert.ok(['gpt-a', 'gpt-b'].includes(row.vm_id))
  // 后到的绑定被锁在胜者上（VM 与账号都不同），不迁移
  assert.equal(row.generation, 1)
  // 同一会话的下一个请求回到绑定的 VM
  const next = []
  const third = request(root, {
    headers,
    stickyRouter,
    hop: async ({ exec, onEvent }) => {
      next.push(exec.vmId)
      await onEvent(`data: ${JSON.stringify({ type: 'response.completed', response })}\n\n`)
      return { ok: true, status: 200, body: response, usage: response.usage, terminalState: 'verified' }
    },
  })
  await handleCodexProtocol(third.args)
  assert.deepEqual(next, [row.vm_id])
})

test('diagnostic writes are awaited; a failed write only logs', async (t) => {
  const root = project(t, ['gpt-a'])
  const order = []
  const attemptsRepo = {
    async begin() {
      await Promise.resolve()
      order.push('begin')
    },
    async complete() {
      order.push('complete')
      throw new Error('disk full')
    },
  }
  const warnings = []
  const warn = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  t.after(() => {
    console.warn = warn
  })
  const run = request(root, {
    ops: { attemptsRepo },
    hop: async ({ onEvent }) => {
      order.push('hop')
      await onEvent(`data: ${JSON.stringify({ type: 'response.completed', response })}\n\n`)
      return { ok: true, status: 200, body: response, usage: response.usage, terminalState: 'verified' }
    },
  })
  await handleCodexProtocol(run.args)
  assert.equal(run.res.statusCode, 200)
  assert.deepEqual(order, ['begin', 'hop', 'complete'])
  assert.ok(warnings.some((line) => line.includes('[codex] diagnostic persistence failed')))
})

test('pickCodexCandidates is async and orders summaries read in one pass', async (t) => {
  const root = project(t, ['gpt-a', 'gpt-b'])
  const pending = pickCodexCandidates(root, { headers: {}, apiKeyKind: 'master' }, { body: { model: 'gpt-5.5' } })
  assert.equal(typeof pending.then, 'function')
  const picked = await pending
  assert.deepEqual([...picked.ids].sort(), ['gpt-a', 'gpt-b'])
})

test('listVms / summarizeVm are async; list group fields equal per-VM summaries', async (t) => {
  const root = project(t, ['gpt-a', 'gpt-b'])
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-r6-db-'))
  t.after(async () => {
    await closeDatabase()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  const db = openDatabase({ dataDir })
  const groups = new GroupsRepo(db)
  const g1 = await groups.create({ name: 'r6-a', platform: 'openai' })
  const g2 = await groups.create({ name: 'r6-b', platform: 'openai' })
  await groups.assignResource('vm', 'gpt-a', [g1.id, g2.id], 0)
  const listedPending = listVms(root)
  assert.equal(typeof listedPending.then, 'function')
  const listed = await listedPending
  assert.equal(Array.isArray(listed), true)
  for (const vm of listed) {
    const raw = JSON.parse(fs.readFileSync(path.join(root, 'vms', `${vm.id}.json`), 'utf8'))
    const one = await summarizeVm(raw, root)
    assert.deepEqual(vm.groups, one.groups)
    assert.equal(vm.groups_version, one.groups_version)
  }
  assert.deepEqual(
    listed.find((vm) => vm.id === 'gpt-a').groups.map((g) => g.name),
    ['r6-a', 'r6-b'],
  )
  assert.equal(listed.find((vm) => vm.id === 'gpt-a').groups_version, 1)
  assert.deepEqual(listed.find((vm) => vm.id === 'gpt-b').groups, [])
})

test('CodexAccountProtection.frozenUntil matches until() for every account', async (t) => {
  const db = createDatabase({ dbPath: ':memory:' })
  t.after(() => db.close())
  await new SettingsRepo(db).set('account_error_protection', {
    enabled: true,
    threshold: 2,
    windowMs: 60000,
    durationMs: 300000,
    rules: [
      {
        id: 'auth',
        name: 'auth',
        conditions: [
          { field: 'provider', operator: 'equals', values: ['openai'] },
          { field: 'status', operator: 'equals', values: ['401'] },
        ],
      },
    ],
  })
  const service = new CodexAccountProtection(db)
  const failure = { ok: false, status: 401, sendState: 'sent' }
  await service.observe('a', failure, await service.capture('a', 1))
  await service.observe('a', failure, await service.capture('a', 1))
  const generation = (id) => ({ a: 1, b: 1, c: 2 })[id]
  const frozen = await service.frozenUntil(['a', 'b', 'c'], generation)
  for (const id of ['a', 'b', 'c']) assert.equal(frozen.get(id) || 0, await service.until(id, generation(id)), id)
  assert.ok(frozen.get('a') > Date.now())
})

test('B7c removed every temporary sync exit of the Codex path and VM summaries', () => {
  for (const name of ['keyScopeFromRequestSync', 'keyScopeFromRecordSync', 'refreshAuthenticatedKeySync'])
    assert.equal(keyScope[name], undefined, name)
  assert.equal(resourceScope.ownerScopeFromRequestSync, undefined)
  assert.equal(resourceOwner.ownerScopeFromRequestSync, undefined)
  assert.equal(UsersRepo.prototype.getByIdSync, undefined)
  assert.equal(ApiKeysRepo.prototype.getByIdSync, undefined)
  for (const name of [
    'getByIdSync',
    'resourcesSync',
    'forResourceSync',
    'resourceVersionSync',
    'overrideSync',
    'accessSync',
  ])
    assert.equal(GroupsRepo.prototype[name], undefined, name)
  for (const name of ['resolveSync', 'extractPoolKeySync', 'bindSync', 'unbindSync'])
    assert.equal(StickyRouter.prototype[name], undefined, name)
  for (const name of ['getSync', 'upsertSync', 'removeSync']) assert.equal(StickyRepo.prototype[name], undefined, name)
  for (const name of ['getProtectionStateSync', 'compareAndSwapProtectionStateSync', 'ensureRowSync'])
    assert.equal(AccountRuntimeRepo.prototype[name], undefined, name)
  assert.equal(runtimePolicy.vendorRuntimeBlockSync, undefined)
  for (const name of ['accountResourceSync', 'vmGroupMembershipsSync', 'activeGroupNamesSync', 'proxyStatusSync'])
    assert.equal(runtimePolicyRepo[name], undefined, name)
  assert.equal(vendorsRepo.getVendorRowSync, undefined)
  for (const name of [
    'getVendorVmResourceSync',
    'findAuthorizationNamedAccountSync',
    'setResourceNameConfigStampedSync',
  ])
    assert.equal(resourcesRepo[name], undefined, name)
  assert.equal(accountName.resolveVendorAccountNameSync, undefined)
  // 源码里也不再有这些名字（B8 的出口除外）
  const root = new URL('../../src/', import.meta.url)
  const removed =
    /\b(keyScopeFromRequestSync|keyScopeFromRecordSync|ownerScopeFromRequestSync|vendorRuntimeBlockSync|resolveVendorAccountNameSync|extractPoolKeySync|getProtectionStateSync|compareAndSwapProtectionStateSync|ensureRowSync|forResourceSync|resourceVersionSync|resolveSync|bindSync|unbindSync)\b/
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) return walk(full)
      return entry.name.endsWith('.mjs') ? [full] : []
    })
  const hits = walk(root.pathname).filter((file) => removed.test(fs.readFileSync(file, 'utf8')))
  assert.deepEqual(hits, [])
})
