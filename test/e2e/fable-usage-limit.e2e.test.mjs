import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AccountQuota } from '../../src/lib/pool/account-quota.mjs'
import { startGateway, api, seedVm } from '../harness.mjs'

test('saved Fable percentage blocks only Fable and exposes the same per-account limit in the panel', async (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'fable-cap-http-'))
  const vm = seedVm({ project })
  vm.claude.account_tier = 'max'
  fs.writeFileSync(path.join(project, 'vms', vm.id + '.json'), JSON.stringify(vm))
  const gw = await startGateway({ project })
  const db = new DatabaseSync(path.join(project, 'data', 'kin.db'))
  t.after(async () => {
    db.close()
    await gw.stop()
    fs.rmSync(project, { recursive: true, force: true })
  })
  const saved = await api(gw, 'PUT', '/api/panel/routing', {
    body: {
      quota: { weekly_split: { enabled: true, fable_share: 0.5 } },
    },
  })
  assert.equal(saved.status, 200, saved.text)
  const quota = new AccountQuota({ db })
  quota.ensure({ account_id: 'acct-seed', vm_id: vm.id })
  quota.ingestHeaders('acct-seed', {
    'anthropic-ratelimit-unified-5h-utilization': '0.1',
    'anthropic-ratelimit-unified-7d-utilization': '0.2',
    'anthropic-ratelimit-unified-7d_oi-utilization': '0.5',
    'anthropic-ratelimit-unified-7d_oi-status': 'allowed',
    'anthropic-ratelimit-unified-7d_oi-reset': new Date(Date.now() + 3600000).toISOString(),
  })
  const request = (model) =>
    api(gw, 'POST', '/v1/messages', {
      body: {
        model,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hello' }],
      },
    })
  const blocked = await request('claude-fable-5-1')
  assert.equal(blocked.status, 529, blocked.text)
  assert.equal(blocked.json.error.code, 'pool_overloaded')
  const listed = await api(gw, 'GET', '/api/panel/vms')
  assert.equal(listed.status, 200, listed.text)
  const row = listed.json.data.items.find((item) => item.id === vm.id)
  assert.equal(row.weekly_split.fable_share, 0.5)
  assert.equal(row.weekly_split.fable_blocked, true)
  assert.equal(row.weekly_split.fable_utilization, 0.5)
  assert.equal(row.availability.accept, true)
  const regular = await request('claude-sonnet-5')
  assert.equal(regular.status, 200, regular.text)
  const disabled = await api(gw, 'PUT', '/api/panel/routing', {
    body: { quota: { weekly_split: { enabled: false, fable_share: 0.5 } } },
  })
  assert.equal(disabled.status, 200, disabled.text)
  const reopened = await request('claude-fable-5-1')
  assert.equal(reopened.status, 200, reopened.text)
})
