import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase, applyMigrations } from '../../src/lib/db/database.mjs'
import { PanelUserStore } from '../../src/lib/admin/panel-users.mjs'
import { GroupsRepo } from '../../src/lib/db/repos/groups-repo.mjs'
import { RelayBilling } from '../../src/lib/admin/relay-billing.mjs'

test('upgrade preserves actual charges and old records without holding funds or replaying debits', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'completed-usage-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const file of fs.readdirSync('src/lib/db/migrations'))
    if (file.endsWith('.sql') && file < '069')
      fs.copyFileSync(path.join('src/lib/db/migrations', file), path.join(root, file))
  const db = createDatabase({ dbPath: ':memory:', migrationsDir: root })
  t.after(() => db.close())
  const users = new PanelUserStore({ db })
  const user = users.create({ username: 'customer', password: 'testing-pass' })
  db.prepare('UPDATE users SET balance_micros=5000000 WHERE id=?').run(user.id)
  const now = new Date().toISOString()
  const insert = db.prepare(`INSERT INTO billing_reservations(request_id,user_id,api_key_id,group_id,
    subscription_id,rate_multiplier,group_version,reserved_micros,actual_micros,status,created_at,updated_at)
    VALUES(?,?, 'key',1,'sub',1,1,4000000,?,?,?,?)`)
  insert.run('completed', user.id, 200000, 'settled', now, now)
  for (const status of ['pending', 'pending_usage', 'pending_pricing', 'released'])
    insert.run(status, user.id, null, status, now, now)
  applyMigrations(db)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM billing_charges').get().n, 1)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM billing_reservations').get().n, 5)
  const billing = new RelayBilling(db)
  assert.equal(billing.balance(user.id).available, 5)
  assert.equal(billing.balance(user.id).reserved, undefined)
  const group = new GroupsRepo(db).getById(1)
  assert.equal(billing.subscriptionWindows('sub', group)[0].used, 0.2)
  assert.equal(
    billing.settle({ request_id: 'completed' }, {}, 'claude-sonnet-5', () => assert.fail('replay')).actual_micros,
    200000,
  )
  assert.equal(db.prepare('SELECT COUNT(*) n FROM wallet_ledger').get().n, 0)
  applyMigrations(db)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM billing_charges').get().n, 1)
  // The retired data can be archived independently: it is not an active dependency.
  db.exec('DROP TABLE billing_reservations')
  assert.equal(billing.balance(user.id).available, 5)
  assert.equal(billing.subscriptionWindows('sub', group)[0].used, 0.2)
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
})
