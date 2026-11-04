import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { SettingsRepo } from '../../src/lib/db/repos/settings-repo.mjs'

function makeHandler(db, body, runtimeRepo, failoverRunner = {}) {
  const response = {}
  const handlePanel = createPanelHandler({
    db,
    cfg: { paths: { project: os.tmpdir(), data: os.tmpdir() }, limits: { max_body_bytes: 128 * 1024 } },
    readBody: async () => body,
    requireAuth(req) {
      req.apiKeyKind = 'master'
      req.panelRole = 'super_admin'
      return true
    },
    json(_res, status, payload) {
      response.status = status
      response.body = payload
      return true
    },
    runtimeRepo,
    failoverRunner,
  })
  return { handlePanel, response }
}

test('account error protection panel endpoint validates, persists, and reloads policy', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-panel-protection-'))
  const db = createDatabase({ dataDir: dir })
  try {
    const runner = {}
    const { handlePanel, response } = makeHandler(db, {}, null, runner)
    await handlePanel({ method: 'GET' }, {}, new URL('http://localhost/api/panel/account-error-protection'))
    assert.equal(response.status, 200)
    assert.equal(response.body.enabled, false)

    const policy = {
      enabled: true,
      threshold: 2,
      windowSeconds: 60,
      durationSeconds: 300,
      rules: [
        {
          id: 'auth-expired',
          name: '凭据失效',
          conditions: [
            { field: 'provider', operator: 'equals', values: ['anthropic'] },
            { field: 'status', operator: 'equals', values: ['401'] },
          ],
        },
      ],
    }
    const put = makeHandler(db, { account_error_protection: policy }, null, runner)
    await put.handlePanel({ method: 'PUT' }, {}, new URL('http://localhost/api/panel/account-error-protection'))
    assert.equal(put.response.status, 200, JSON.stringify(put.response.body))
    assert.equal(put.response.body.policy.windowMs, 60_000)
    assert.equal(runner.accountErrorProtection.policy.threshold, 2)
    assert.equal(new SettingsRepo(db).get('account_error_protection').enabled, true)

    const bad = makeHandler(db, { enabled: true, rules: [] }, null, runner)
    await bad.handlePanel({ method: 'PUT' }, {}, new URL('http://localhost/api/panel/account-error-protection'))
    assert.equal(bad.response.status, 400)
    assert.equal(bad.response.body.error.code, 'rules_required')
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('manual protection clear uses DB generation CAS and only clears its cooldown', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-panel-protection-clear-'))
  const db = createDatabase({ dataDir: dir })
  try {
    let snapshot = {
      generation: 4,
      state: { generation: 2, frozenUntil: Date.now() + 60_000, count: 0 },
    }
    let account = {
      account_id: 'account-1',
      vm_id: 'vm-1',
      status: 'cooldown',
      cooldown_reason: 'account_error_protected',
      cooldown_until: Date.now() + 60_000,
    }
    const runtimeRepo = {
      getProtectionState() {
        return snapshot
      },
      clearProtectionState(_id, { expectedGeneration, state }) {
        if (expectedGeneration !== snapshot.generation) return null
        snapshot = { state, generation: expectedGeneration + 1 }
        return snapshot.generation
      },
      get() {
        return account
      },
      upsert(next) {
        account = next
        return account
      },
    }
    const stale = makeHandler(db, { protection_generation: 3 }, runtimeRepo)
    await stale.handlePanel(
      { method: 'POST' },
      {},
      new URL('http://localhost/api/panel/accounts/account-1/error-protection/clear'),
    )
    assert.equal(stale.response.status, 409)

    const clear = makeHandler(db, { protection_generation: 4 }, runtimeRepo)
    await clear.handlePanel(
      { method: 'POST' },
      {},
      new URL('http://localhost/api/panel/accounts/account-1/error-protection/clear'),
    )
    assert.equal(clear.response.status, 200, JSON.stringify(clear.response.body))
    assert.equal(clear.response.body.protection_generation, 5)
    assert.equal(clear.response.body.cooldown_cleared, true)
    assert.equal(account.cooldown_reason, null)
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
