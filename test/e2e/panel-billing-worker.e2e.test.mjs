import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { once } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import { startGateway, api } from '../harness.mjs'

test('panel routes await worker billing and observe externally committed usage', async (t) => {
  const gw = await startGateway()
  t.after(async () => {
    await gw.stop()
    if (gw.child.exitCode == null && gw.child.signalCode == null) await once(gw.child, 'exit')
    fs.rmSync(gw.project, { recursive: true, force: true })
  })
  const db = new DatabaseSync(path.join(gw.project, 'data/kin.db'))
  try {
    db.exec(`INSERT INTO usage_logs(id, request_id, created_at, status, account_id, vm_id,
      input_tokens, total_cost, pricing_model) VALUES
      ('usage-1', 'usage-1', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 200,
       'acct-seed', 'vm-sim-01', 1000, 0.005, 'claude-opus-5')`)
    for (const endpoint of ['/api/panel/usage', '/api/panel/dashboard']) {
      const result = await api(gw, 'GET', endpoint)
      assert.equal(result.status, 200)
      assert.equal(result.json?.data?.billing?.total.requests, 1, endpoint)
      assert.equal(result.json.data.billing.total.total_cost, 0.005)
    }
    db.exec(`UPDATE usage_logs SET total_cost = 0.01 WHERE id = 'usage-1'`)
    const updated = await api(gw, 'GET', '/api/panel/usage')
    assert.equal(updated.json.data.billing.total.total_cost, 0.01)
    const vms = await api(gw, 'GET', '/api/panel/vms')
    assert.equal(vms.status, 200)
    assert.equal(vms.json.data.items.find((vm) => vm.id === 'vm-sim-01').total_cost, 0.01)
  } finally {
    db.close()
  }
})
