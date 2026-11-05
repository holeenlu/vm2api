import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { markVmRestriction } from '../../src/lib/oauth/oauth-credentials.mjs'
import { syncCodexQuotaSchedule } from '../../src/lib/vm/vm-registry.mjs'

function slotRoot(t, record) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-vm-restriction-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  const file = path.join(root, 'vms', `${record.id}.json`)
  fs.writeFileSync(file, JSON.stringify(record))
  return { root, file }
}

const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))

test('re-marking an unchanged restriction leaves the slot file untouched', (t) => {
  const { file } = slotRoot(t, { id: 'vm-a', platform: 'openai', family: 'codex' })
  const until = Date.now() + 3_600_000
  const first = markVmRestriction(file, { until, reason: 'quota_7d_header' })
  assert.equal(first.temp_unschedulable_until, until)
  const stamped = read(file).updated_at
  const inode = fs.statSync(file).ino
  const again = markVmRestriction(file, { until, reason: 'quota_7d_header' })
  assert.equal(again.temp_unschedulable_reason, 'quota_7d_header')
  assert.equal(read(file).updated_at, stamped)
  // atomicWriteJson renames a new file into place; the same inode means no write.
  assert.equal(fs.statSync(file).ino, inode)
  // A later until or another reason is still written.
  markVmRestriction(file, { until: until + 60_000, reason: 'quota_7d_header' })
  assert.equal(read(file).temp_unschedulable_until, until + 60_000)
  markVmRestriction(file, { until: until + 60_000, reason: 'quota_5h_header' })
  assert.equal(read(file).claude.temp_unschedulable_reason, 'quota_5h_header')
})

test('a local quota restriction without an until is not cleared and rewritten on every sync', (t) => {
  const record = {
    id: 'vm-local',
    platform: 'openai',
    family: 'codex',
    schedulable: true,
    codex: { extra: { codex_5h_used_percent: 95 } },
  }
  const { root, file } = slotRoot(t, record)
  const policy = { limit_5h: 0.9, limit_7d: 1 }
  const first = syncCodexQuotaSchedule(root, read(file), { policy })
  assert.equal(first.action, 'restrict')
  assert.equal(first.reason, 'quota_5h_local')
  assert.equal(read(file).temp_unschedulable_reason, 'quota_5h_local')
  const inode = fs.statSync(file).ino
  for (let n = 0; n < 3; n++) syncCodexQuotaSchedule(root, read(file), { policy })
  assert.equal(fs.statSync(file).ino, inode)
  assert.equal(read(file).temp_unschedulable_reason, 'quota_5h_local')
})
