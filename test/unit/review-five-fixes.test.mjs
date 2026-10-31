import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { PanelUserStore } from '../../src/lib/admin/panel-users.mjs'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
import { GroupsRepo } from '../../src/lib/db/repos/groups-repo.mjs'
import { keyScopeFromRequest } from '../../src/lib/admin/key-scope.mjs'
import { PoolScheduler } from '../../src/lib/pool/pool-scheduler.mjs'
import { pickCodexCandidates } from '../../src/lib/protocol/handle-codex.mjs'
import { runApiInference } from '../../src/lib/pool/api-protocol.mjs'
function setup(t, platform = 'anthropic') {
  const db = openDatabase({ dbPath: ':memory:' })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'five-fixes-'))
  t.after(() => {
    closeDatabase()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const users = new PanelUserStore({ db }),
    groups = new GroupsRepo(db),
    keys = new ApiKeyStore({ db })
  const user = users.create({ username: 'review', password: 'testpass' }),
    group = groups.create({ name: 'review', platform })
  groups.setGrants(user.id, [group.id])
  const key = keys.create({ user_id: user.id, group_id: group.id })
  const req = { headers: {}, apiKeyKind: 'managed', apiKeyRecord: key, socket: { remoteAddress: '127.0.0.1' } }
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  const vm = {
    id: 'review-vm',
    platform,
    status: 'running',
    schedulable: true,
    has_token: true,
    proxy_cli_enabled: true,
    proxy: { id: 'proxy', url: 'socks5h://127.0.0.1:10001' },
    policy: { maxConcurrency: 2, concurrencyOverride: true },
    runtime: { worker_socket: path.join(root, 'worker.sock') },
    claude: {
      account_uuid: 'account',
      account_tier: 'max',
      access_token: 'synthetic',
      refresh_token: 'synthetic',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    },
  }
  fs.writeFileSync(path.join(root, 'vms', vm.id + '.json'), JSON.stringify(vm))
  groups.assignResource('vm', vm.id, [group.id], 0)
  return { db, root, users, groups, keys, user, group, key, req, vm }
}
test('revocation during asynchronous eligibility never reserves the slot', async (t) => {
  const s = setup(t)
  let checks = 0
  const pool = new PoolScheduler({
    projectRoot: s.root,
    accountQuota: { canAccept: () => ({ ok: true }) },
    workerHealth: async () => {
      checks++
      s.keys.update(s.key.id, { status: 'disabled' })
      return { ok: true, credential: { has_access: true, generation: 1 } }
    },
  })
  const result = await pool.selectAndReserve({
    model: 'claude-sonnet-5',
    allowWait: false,
    ownerScope: { type: 'any' },
    keyScope: keyScopeFromRequest(s.req),
  })
  assert.ok(checks)
  assert.equal(result.ok, false)
  assert.equal(pool.inflight.size, 0)
})
test('cached queue candidates cannot claim capacity after resource removal', (t) => {
  const s = setup(t)
  const pool = new PoolScheduler({ projectRoot: s.root })
  const candidate = {
    vm: s.vm,
    vmId: s.vm.id,
    accountId: 'account',
    model: 'claude-sonnet-5',
    maxConcurrency: 2,
    seatCap: 2,
    keyScope: keyScopeFromRequest(s.req),
  }
  s.groups.assignResource('vm', s.vm.id, [], 1)
  assert.equal(pool.reserve(candidate), null)
  assert.equal(pool.claimSeat('waiting-device', candidate, 'queued'), null)
  assert.equal(pool.inflight.size, 0)
})
test('Codex re-selection rejects a model removed from the group', (t) => {
  const s = setup(t, 'openai')
  s.groups.update(s.group.id, { models: ['gpt-6-astra'] })
  assert.equal(pickCodexCandidates(s.root, s.req, { body: { model: 'gpt-6.1-sol' } }).error, 'group_unavailable')
})
test('API rejects revoked models before touching endpoint selection', async (t) => {
  const s = setup(t)
  s.groups.update(s.group.id, { models: ['claude-opus-5'] })
  let picked = false
  const result = await runApiInference({
    req: s.req,
    inbound: { model: 'claude-sonnet-5' },
    convertedBody: { model: 'claude-sonnet-5' },
    scheduler: {
      pick: () => {
        picked = true
      },
    },
  })
  assert.equal(result.status, 403)
  assert.equal(picked, false)
})
test('explicit null detaches a key; omitted group leaves it unchanged', (t) => {
  const s = setup(t)
  assert.equal(s.keys.update(s.key.id, { name: 'rename' }).group_id, s.group.id)
  assert.equal(s.keys.update(s.key.id, { group_id: null }).group_id, null)
})
test('a waiting seat is not granted after key revocation when existing capacity releases', async (t) => {
  const s = setup(t)
  s.vm.policy.maxConcurrency = 1
  fs.writeFileSync(path.join(s.root, 'vms', s.vm.id + '.json'), JSON.stringify(s.vm))
  const pool = new PoolScheduler({
    projectRoot: s.root,
    accountQuota: { canAccept: () => ({ ok: true }) },
    workerHealth: async () => ({ ok: true, credential: { has_access: true, generation: 1 } }),
  })
  const args = { model: 'claude-sonnet-5', ownerScope: { type: 'any' }, keyScope: keyScopeFromRequest(s.req) }
  const first = await pool.selectAndReserve({ ...args, seatKey: 'first', allowWait: false })
  assert.equal(first.ok, true)
  let entered
  const waiting = new Promise((resolve) => {
    entered = resolve
  })
  const wait = pool.waitTicket.bind(pool)
  pool.waitTicket = (ticket, options) => {
    entered()
    return wait(ticket, options)
  }
  const next = pool.selectAndReserve({ ...args, seatKey: 'second', deadline: Date.now() + 100 })
  await waiting
  s.keys.update(s.key.id, { status: 'disabled' })
  first.release()
  const result = await next
  assert.equal(result.ok, false)
  assert.equal(pool.inflight.size, 0)
})

test('revocation during asynchronous attempt preparation prevents supplier dispatch and releases capacity', async (t) => {
  const { FailoverRunner } = await import('../../src/lib/pool/failover-runner.mjs')
  const s = setup(t)
  const pool = new PoolScheduler({
    projectRoot: s.root,
    accountQuota: { canAccept: () => ({ ok: true }) },
    workerHealth: async () => ({ ok: true, credential: { has_access: true, generation: 1 } }),
  })
  let calls = 0
  const runner = new FailoverRunner({ scheduler: pool })
  const result = await runner.run({
    requestId: 'revoked-before-hop',
    model: 'claude-sonnet-5',
    canonicalBody: { model: 'claude-sonnet-5' },
    ownerScope: { type: 'any' },
    keyScope: keyScopeFromRequest(s.req),
    applyAttempt: async (body) => {
      s.keys.update(s.key.id, { status: 'disabled' })
      return body
    },
    callAttempt: () => {
      calls++
      throw new Error('must not dispatch')
    },
  })
  assert.equal(result.status, 403)
  assert.equal(calls, 0)
  assert.equal(pool.inflight.size, 0)
})
