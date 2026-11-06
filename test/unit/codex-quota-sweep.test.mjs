import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { pickCodexCandidates } from '../../src/lib/protocol/handle-codex.mjs'
import {
  requestCodexQuotaSweep,
  resetCodexQuotaSweeps,
  syncAllCodexQuotaSchedules,
} from '../../src/lib/pool/codex-quota-sweep.mjs'

beforeEach(() => resetCodexQuotaSweeps())

const WEEK_RESET = () => new Date(Date.now() + 3 * 86_400_000).toISOString()

function project(t, slots) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-quota-sweep-'))
  t.after(() => {
    resetCodexQuotaSweeps()
    fs.rmSync(root, { recursive: true, force: true })
  })
  for (const [id, extra] of Object.entries(slots)) {
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
        codex: { extra },
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

const record = (root, id) => JSON.parse(fs.readFileSync(path.join(root, 'vms', `${id}.json`), 'utf8'))
const spent = () => ({ codex_7d_used_percent: 100, codex_7d_reset_at: WEEK_RESET(), codex_7d_window_minutes: 10080 })

function countVmFs(t, root) {
  const counts = { readdir: 0, read: 0 }
  const vmDir = path.join(root, 'vms')
  const { readdirSync, readFileSync } = fs
  fs.readdirSync = function (dir, ...rest) {
    if (String(dir) === vmDir) counts.readdir++
    return readdirSync.call(this, dir, ...rest)
  }
  fs.readFileSync = function (file, ...rest) {
    if (String(file).startsWith(vmDir + path.sep) && String(file).endsWith('.json')) counts.read++
    return readFileSync.call(this, file, ...rest)
  }
  t.after(() => Object.assign(fs, { readdirSync, readFileSync }))
  return counts
}

test('#737 admission no longer rereads and rewrites every slot record per pick', async (t) => {
  const root = project(t, { 'gpt-spent': spent(), 'gpt-a': {}, 'gpt-b': {} })
  const counts = countVmFs(t, root)
  const req = { headers: {}, apiKeyKind: 'master' }
  const PICKS = 20
  for (let i = 0; i < PICKS; i++) {
    const picked = await pickCodexCandidates(root, req, { body: { model: 'gpt-5.5' } })
    // Ordering never waited for the write-back: the spent slot is parked on every pick.
    assert.deepEqual([...picked.ids].sort(), ['gpt-a', 'gpt-b'])
  }
  await sleep(20)
  // One listVms scan per pick, plus at most one coalesced sweep (was two scans per pick).
  assert.ok(counts.readdir <= PICKS + 1, `readdir ${counts.readdir}`)
  // markVmRestriction re-read the restricted slot's record on every pick before (>= PICKS reads);
  // now only cache misses and the one sweep read records, independent of the pick count.
  assert.ok(counts.read < PICKS / 2, `slot record reads ${counts.read}`)
  // The panel-facing restriction is still written back, off the request.
  assert.equal(record(root, 'gpt-spent').temp_unschedulable_reason, 'quota_7d_header')
  assert.equal(record(root, 'gpt-a').temp_unschedulable_reason, undefined)
})

test('requestCodexQuotaSweep coalesces a burst and waits out the gap', async (t) => {
  const root = project(t, { 'gpt-spent': spent() })
  assert.equal(requestCodexQuotaSweep(root, null, { minGapMs: 200 }), true)
  for (let i = 0; i < 50; i++) assert.equal(requestCodexQuotaSweep(root, null, { minGapMs: 200 }), false)
  // Never runs inside the caller.
  assert.equal(record(root, 'gpt-spent').temp_unschedulable_reason, undefined)
  await sleep(20)
  assert.equal(record(root, 'gpt-spent').temp_unschedulable_reason, 'quota_7d_header')
  // Operator drops the restriction; the next sweep is held until the gap ends.
  const file = path.join(root, 'vms', 'gpt-spent.json')
  const cleared = record(root, 'gpt-spent')
  delete cleared.temp_unschedulable_reason
  delete cleared.temp_unschedulable_until
  delete cleared.claude
  fs.writeFileSync(file, JSON.stringify(cleared))
  assert.equal(requestCodexQuotaSweep(root, null, { minGapMs: 200 }), true)
  await sleep(40)
  assert.equal(record(root, 'gpt-spent').temp_unschedulable_reason, undefined)
  await sleep(250)
  assert.equal(record(root, 'gpt-spent').temp_unschedulable_reason, 'quota_7d_header')
})

test('the sweep applies the latest policy and skips non-Codex records', async (t) => {
  const root = project(t, { 'gpt-hot': { codex_5h_used_percent: 95, codex_5h_window_minutes: 300 } })
  fs.writeFileSync(path.join(root, 'vms', 'claude-a.json'), JSON.stringify({ id: 'claude-a', status: 'running' }))
  requestCodexQuotaSweep(root, { limit_5h: 1, limit_7d: 1 })
  requestCodexQuotaSweep(root, { limit_5h: 0.9, limit_7d: 1 })
  await sleep(20)
  assert.equal(record(root, 'gpt-hot').temp_unschedulable_reason, 'quota_5h_local')
  assert.equal(record(root, 'claude-a').temp_unschedulable_reason, undefined)
  assert.equal(syncAllCodexQuotaSchedules(root, { policy: { limit_5h: 0.9, limit_7d: 1 } }), 1)
})
