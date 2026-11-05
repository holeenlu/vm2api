import test from 'node:test'
import assert from 'node:assert/strict'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { GatewayWorkerRepo } from '../../src/lib/gateway-worker/gateway-repo.mjs'
import { gatewayMultiWorkerEnabled, singleWorkerConflict } from '../../src/lib/gateway-worker/gateway-routes.mjs'

test('single-Worker mode admits one accepting Worker and lets a replacement take over', () => {
  const db = createDatabase({ dbPath: ':memory:' })
  try {
    const repo = new GatewayWorkerRepo(db)
    const now = new Date().toISOString()
    const single = {}
    const accepting = (id) => ({ id, health_state: 'healthy', drain_state: 'accepting', last_heartbeat_at: now })
    assert.equal(singleWorkerConflict(repo, accepting('gw-01'), single), null, 'the first Worker registers')
    repo.upsertInstance({ ...accepting('gw-01'), base_url: 'http://127.0.0.1:8790' })
    assert.equal(singleWorkerConflict(repo, accepting('gw-01'), single), null, 'the same Worker keeps heartbeating')
    const conflict = singleWorkerConflict(repo, accepting('gw-02'), single)
    assert.equal(conflict.error.code, 'gateway_single_worker')
    assert.match(conflict.error.message, /gw-01/)
    assert.equal(
      singleWorkerConflict(repo, { ...accepting('gw-02'), drain_state: 'draining' }, single),
      null,
      'a draining Worker never blocks',
    )
    assert.equal(
      singleWorkerConflict(repo, accepting('gw-02'), { KIN_CODEX_GATEWAY_MULTI_WORKER: '1' }),
      null,
      'multi-Worker mode admits more',
    )

    // 原实例 Drain 后替换实例可以接单
    repo.upsertInstance({ ...accepting('gw-01'), drain_state: 'draining' })
    assert.equal(singleWorkerConflict(repo, accepting('gw-02'), single), null)
    // 原实例失联超过 45 秒同样释放
    repo.upsertInstance({ ...accepting('gw-01'), drain_state: 'accepting' })
    db.prepare("UPDATE gateway_worker_instances SET last_heartbeat_at=? WHERE id='gw-01'").run(
      new Date(Date.now() - 120_000).toISOString(),
    )
    assert.equal(singleWorkerConflict(repo, accepting('gw-02'), single), null)

    assert.equal(gatewayMultiWorkerEnabled({ KIN_CODEX_GATEWAY_MULTI_WORKER: 'on' }), true)
    assert.equal(gatewayMultiWorkerEnabled({}), false)
  } finally {
    db.close()
  }
})
