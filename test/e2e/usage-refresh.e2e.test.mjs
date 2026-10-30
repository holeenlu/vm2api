import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AccountQuota } from '../../src/lib/pool/account-quota.mjs'
import { startGateway, api } from '../harness.mjs'

test('VM list and completed inference refresh missing quota without a manual probe', async () => {
  const gw = await startGateway({ scenario: 'text' })
  const db = new DatabaseSync(path.join(gw.project, 'data', 'kin.db'))
  const quota = new AccountQuota({ db })
  const clearSample = () => {
    const rec = quota.ensure({ account_id: 'acct-seed', vm_id: 'vm-sim-01' })
    rec.unified = {}
    rec.last_probe = null
    quota.repo.save(rec)
  }
  const waitForSample = async () => {
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      const row = quota.repo.get('acct-seed')
      if (row?.unified?.last_probe?.ok) return row
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.fail('automatic quota refresh did not complete')
  }
  try {
    clearSample()
    const listed = await api(gw, 'GET', '/api/panel/vms')
    assert.equal(listed.status, 200, listed.text)
    assert.ok((await waitForSample()).unified.official['5h'])
    // New response has no quota headers in the mock transport. The normal
    // completion callback still fills the missing official snapshot.
    clearSample()
    const response = await api(gw, 'POST', '/v1/messages', {
      body: {
        model: 'claude-sonnet-5',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hello' }],
      },
    })
    assert.equal(response.status, 200, response.text)
    const sampled = await waitForSample()
    assert.ok(sampled.unified.official['7d'])
    assert.equal(sampled.unified.fable?.model, undefined, 'automatic path must not run a Fable inference probe')
    assert.ok(sampled.unified['7d_oi'], 'Fable window can come directly from official usage')
    const updated = await api(gw, 'GET', '/api/panel/vms')
    const vm = updated.json.data.items.find((row) => row.id === 'vm-sim-01')
    assert.ok(vm.total_cost > 0, JSON.stringify(vm))
  } finally {
    db.close()
    await gw.stop()
    fs.rmSync(gw.project, { recursive: true, force: true })
  }
})
