import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { GatewayWorkerRepo } from '../../src/lib/gateway-worker/gateway-repo.mjs'

// 统一控制面重构 P5：Worker 心跳上报的共享运行态只保存已知字段，实例列表展示
test('heartbeat shared state is stored with known fields only and listed per instance', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-shared-state-'))
  const db = createDatabase({ dataDir: dir })
  try {
    const repo = new GatewayWorkerRepo(db)
    repo.upsertInstance({ id: 'gw-1', base_url: 'http://127.0.0.1:1', health_state: 'healthy' })
    repo.recordSharedState('gw-1', {
      backend: 'redis',
      healthy: false,
      encrypted: true,
      last_error: 'dial tcp: refused',
      leases: { held: 2, lost_renewed: 1 },
      remote_holds: 3,
      secret: 'must not be stored',
    })
    const [item] = repo.listInstances()
    assert.equal(item.shared_state.backend, 'redis')
    assert.equal(item.shared_state.healthy, false)
    assert.equal(item.shared_state.leases_held, 2)
    assert.equal(item.shared_state.remote_holds, 3)
    assert.equal(item.shared_state.secret, undefined)
    assert.equal(item.shared_state_json, undefined)
    repo.recordSharedState('gw-1', { backend: 'local' })
    assert.deepEqual(Object.keys(repo.listInstances()[0].shared_state).sort(), ['backend', 'reported_at'])
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
