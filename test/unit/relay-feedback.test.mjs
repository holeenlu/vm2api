import test from 'node:test'
import assert from 'node:assert/strict'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { PanelUserStore } from '../../src/lib/admin/panel-users.mjs'
import { GroupsRepo } from '../../src/lib/db/repos/groups-repo.mjs'
import { RelayBilling } from '../../src/lib/admin/relay-billing.mjs'
import { SettingsRepo } from '../../src/lib/db/repos/settings-repo.mjs'
import { seedGptPolicy, loadGptModelPolicy } from '../../src/lib/protocol/gpt-model-policy.mjs'
import { seedDefaultPolicy, normalizePolicy } from '../../src/lib/protocol/model-policy.mjs'
import { SLOT_LOCALES } from '../../src/lib/identity/workstation-fingerprint.mjs'
import { modelMatchesAllowlist } from '../../src/lib/pool/slot-model-gate.mjs'

test('user and group grants save atomically; exclusive rate overrides and ledger keeps a human name', (t) => {
  const db = openDatabase({ dbPath: ':memory:' })
  t.after(closeDatabase)
  const users = new PanelUserStore({ db }),
    groups = new GroupsRepo(db)
  const group = groups.create({ name: '授权服务', rate_multiplier: 2 })
  assert.throws(() => users.create({ username: 'baduser', password: 'testpass', groups: [{ group_id: 999 }] }))
  assert.equal(users.getByUsername('baduser'), null)
  const user = users.create({
    username: 'normaluser',
    password: 'testpass',
    groups: [{ group_id: group.id, rate_multiplier: 0.5 }],
  })
  assert.equal(groups.access(user, group.id).rate, 0.5)
  assert.throws(() => users.update(user.id, { concurrency: 100, groups: [{ group_id: 999 }] }))
  assert.equal(users.getById(user.id).concurrency, user.concurrency)
  assert.equal(users.list()[0].groups[0].rate_multiplier, 0.5)
  const billing = new RelayBilling(db)
  billing.adjust(user.id, { amount: 1, reason: 'test', idempotency_key: 'feedback-credit' }, 'admin')
  users.remove(user.id)
  assert.equal(billing.ledger(null)[0].user_name, 'normaluser')
})

test('current factory catalogs include official releases without replacing live or manual catalogs', (t) => {
  const db = openDatabase({ dbPath: ':memory:' })
  t.after(closeDatabase)
  const seed = seedGptPolicy()
  for (const id of ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna']) assert.ok(seed.models[id])
  assert.equal(seed.models['gpt-6.1-sol'].capabilities.context_window, 500000)
  const settings = new SettingsRepo(db)
  settings.set('gpt_model_policy', { source: 'codex', models: { 'gpt-6-sol': { enabled: false } } })
  assert.deepEqual(Object.keys(loadGptModelPolicy({ force: true }).models), ['gpt-6-sol'])
  settings.set('gpt_model_policy', { source: 'panel', models: { 'gpt-6-sol': { enabled: false } } })
  assert.equal(loadGptModelPolicy({ force: true }).models['gpt-6-sol'].enabled, false)
  const claude = seedDefaultPolicy()
  assert.equal(claude.aliases.opus, 'claude-opus-5-5')
  assert.equal(claude.aliases.haiku, 'claude-haiku-5-5')
  assert.equal(claude.aliases.fable, 'claude-fable-5-1')
  const oldFactory = normalizePolicy({
    source: 'seed',
    aliases: { fable: 'claude-fable-5' },
    models: { 'claude-fable-5': { aliases: ['fable'] } },
  })
  assert.ok(!oldFactory.models['claude-fable-5'].aliases.includes('fable'))
  assert.equal(modelMatchesAllowlist('claude-fable-5', ['fable']), false)
  assert.equal(normalizePolicy({ source: 'panel', aliases: { opus: 'claude-opus-5' } }).aliases.opus, 'claude-opus-5')
})

test('Taiwan Traditional Chinese extends the upstream slot locales', () => {
  assert.deepEqual(SLOT_LOCALES, ['en_US.UTF-8', 'zh_CN.UTF-8', 'zh_TW.UTF-8', 'ja_JP.UTF-8', 'C.UTF-8'])
})
