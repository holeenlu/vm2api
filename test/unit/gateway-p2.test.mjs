import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { GroupsRepo } from '../../src/lib/db/repos/groups-repo.mjs'
import { GatewayWorkerRepo } from '../../src/lib/gateway-worker/gateway-repo.mjs'
import { gatewayHeartbeatPolicy } from '../../src/lib/gateway-worker/gateway-routes.mjs'
import { DEFAULT_CODEX_SETTINGS, normalizeCodexWarmup } from '../../src/lib/executor/codex-settings.mjs'
import { saveCodexSettings } from '../../src/lib/executor/settings-store.mjs'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'

test('codex warmup normalizes local times and requires a model', () => {
  assert.deepEqual(
    normalizeCodexWarmup({ enabled: true, times: ['08:30', '8:30', '25:00', '08:30', '00:05'], model: ' gpt-5.5 ' }),
    {
      enabled: true,
      times: ['00:05', '08:30'],
      model: 'gpt-5.5',
    },
  )
  assert.equal(normalizeCodexWarmup({ enabled: true, times: ['08:00'] }).enabled, false)
  assert.equal(normalizeCodexWarmup({ enabled: true, model: 'm' }).enabled, false)
  assert.deepEqual(DEFAULT_CODEX_SETTINGS.warmup, { enabled: false, times: [], model: '' })
})

test('heartbeat policy ships protection to every instance and warmup to one', async () => {
  const db = createDatabase({ dbPath: ':memory:' })
  try {
    const repo = new GatewayWorkerRepo(db)
    const now = new Date().toISOString()
    for (const id of ['gw_b', 'gw_a', 'gw_c'])
      await repo.upsertInstance({
        id,
        name: id,
        base_url: 'http://127.0.0.1:1',
        health_state: 'healthy',
        drain_state: id === 'gw_a' ? 'draining' : 'accepting',
        last_heartbeat_at: now,
      })
    await saveCodexSettings(db, { warmup: { enabled: true, times: ['08:00'], model: 'gpt-5.5' } }, 'test')
    const designated = await gatewayHeartbeatPolicy(repo, 'gw_b')
    const other = await gatewayHeartbeatPolicy(repo, 'gw_c')
    assert.equal(designated.warmup.enabled, true)
    assert.equal(other.warmup.enabled, false, 'only one accepting instance warms accounts')
    assert.match(designated.account_protection.fingerprint, /^[0-9a-f]{64}$/)
    assert.equal(other.account_protection.fingerprint, designated.account_protection.fingerprint)
  } finally {
    db.close()
  }
})

test('groups store the Codex fast mode and reject unknown values', async () => {
  const db = createDatabase({ dbPath: ':memory:' })
  try {
    const groups = new GroupsRepo(db)
    const group = await groups.create({ name: 'Fast', platform: 'openai' })
    assert.equal((await groups.getById(group.id)).codex_fast_mode, 'default')
    await groups.update(group.id, { codex_fast_mode: 'enabled' })
    assert.equal((await groups.getById(group.id)).codex_fast_mode, 'enabled')
    await assert.rejects(() => groups.update(group.id, { codex_fast_mode: 'turbo' }), /Fast 策略/)
  } finally {
    db.close()
  }
})

test('proxy pool persists the per-proxy WebSocket connection limit', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-px-ws-'))
  const pool = new ProxyPool({ dataDir })
  pool.stopScheduler()
  pool.importLines('socks5://alice:s3cret@1.2.3.4:1080')
  const proxy = pool.state.proxies[0]
  assert.equal(pool.update(proxy.id, { max_websocket_connections: 12 }).ok, true)
  assert.equal(pool.publicProxy(proxy).max_websocket_connections, 12)
  assert.equal(pool.update(proxy.id, { max_websocket_connections: -1 }).error, 'invalid_max_websocket_connections')
  assert.equal(pool.update(proxy.id, { port: 1081 }).ok, true)
  assert.equal(proxy.max_websocket_connections, 12, 'connection edits keep the limit')
})
