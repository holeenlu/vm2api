import test from 'node:test'
import assert from 'node:assert/strict'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { SettingsRepo } from '../../src/lib/db/repos/settings-repo.mjs'
import { GatewayWorkerRepo } from '../../src/lib/gateway-worker/gateway-repo.mjs'
import { gatewayHeartbeatPolicy } from '../../src/lib/gateway-worker/gateway-routes.mjs'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
import { saveCodexSettings } from '../../src/lib/executor/settings-store.mjs'
import {
  activePrivacyPolicy,
  keyClientProfile,
  readClientProfileSetting,
  validateClientProfileSelection,
  validatePrivacyPolicy,
  validateProfileDeployment,
  validSemver,
} from '../../src/lib/gateway-worker/codex-client-profile.mjs'

test('client profile selections mirror the Worker rules', () => {
  assert.deepEqual(
    validateClientProfileSelection({
      client: 'cli',
      platform: 'linux',
      versionMode: 'latest',
      versionLag: 2,
      cliEntry: 'exec',
    }),
    {
      client: 'cli',
      platform: 'linux',
      versionMode: 'latest',
      versionLag: 2,
      cliEntry: 'exec',
    },
  )
  assert.deepEqual(
    validateClientProfileSelection({ mode: 'custom', userAgent: 'codex_cli_rs/0.150.0 (Ubuntu 24.04; x86_64) xterm' }),
    {
      mode: 'custom',
      userAgent: 'codex_cli_rs/0.150.0 (Ubuntu 24.04; x86_64) xterm',
    },
  )
  for (const bad of [
    { client: 'cli', platform: 'linux', versionMode: 'latest', versionLag: 11 },
    { client: 'desktop', platform: 'macos', versionMode: 'latest', cliEntry: 'tui' },
    {
      client: 'desktop',
      platform: 'macos',
      versionMode: 'fixed',
      codexVersion: '0.150.0',
      desktopVersion: '26.1',
      desktopBuild: 'x',
    },
    { client: 'cli', platform: 'linux', versionMode: 'fixed', codexVersion: '01.2.3' },
    { mode: 'custom', userAgent: 'my-agent/1' },
    { mode: 'custom', userAgent: 'codex_exec/0.150.0 x', codexVersion: '0.151.0' },
    { client: 'cli', platform: 'linux', versionMode: 'latest', osType: 'Linux (x)' },
    { client: 'cli', platform: 'linux', versionMode: 'latest', extra: 1 },
  ]) {
    assert.throws(() => validateClientProfileSelection(bad), { code: 'invalid_client_profile' }, JSON.stringify(bad))
  }
  assert.ok(
    validSemver('0.154.0-alpha.6.2') && validSemver('1.2.3+build.5') && !validSemver('1.2') && !validSemver('1.2.3-01'),
  )
  assert.deepEqual(validateProfileDeployment({ residency: 'us', accountRoutingOverride: '' }), { residency: 'us' })
  assert.throws(() => validateProfileDeployment({ residency: 'ü' }), { code: 'invalid_profile_deployment' })
})

test('privacy policies enforce structure and limits before reaching Workers', () => {
  const policy = validatePrivacyPolicy({
    enabled: true,
    rules: [
      {
        id: 'r1',
        name: 'mail',
        steps: [
          {
            scope: 'request_body',
            selector: '$.input[*]["text"]',
            action: 'regex_replace',
            pattern: '[a-z]+@x',
            replacement: '***',
          },
        ],
      },
    ],
  })
  assert.equal(policy.onError, 'skip_rule')
  assert.equal(policy.rules[0].steps[0].replaceAll, false)
  assert.equal(activePrivacyPolicy(policy), policy)
  assert.equal(activePrivacyPolicy({ ...policy, enabled: false }), null)
  const rule = (step) => ({
    enabled: true,
    rules: [
      { id: 'r', name: 'r', steps: [{ scope: 'request_body', selector: '$.a', action: 'remove_field', ...step }] },
    ],
  })
  for (const bad of [
    rule({ selector: 'a' }),
    rule({ selector: '$.a[?(@.x)]' }),
    rule({ selector: '$' + '.a'.repeat(17) }),
    rule({ action: 'regex_replace' }),
    rule({ action: 'regex_replace', pattern: '(?=x)' }),
    rule({ action: 'set_value', pattern: 'x' }),
    rule({ scope: 'request_header', selector: 'bad header' }),
    rule({ scope: 'environment_text', selector: '$.x' }),
    {
      rules: Array.from({ length: 33 }, (_, i) => ({
        id: `r${i}`,
        name: 'n',
        steps: [{ scope: 'request_body', selector: '$', action: 'remove_field' }],
      })),
    },
  ]) {
    assert.throws(
      () => validatePrivacyPolicy(bad),
      { code: 'invalid_privacy_policy' },
      JSON.stringify(bad).slice(0, 80),
    )
  }
})

test('heartbeat ships the global profile and privacy; keys override the profile', async () => {
  const db = createDatabase({ dbPath: ':memory:' })
  try {
    const repo = new GatewayWorkerRepo(db)
    await repo.upsertInstance({
      id: 'gw_a',
      name: 'a',
      base_url: 'http://127.0.0.1:1',
      health_state: 'healthy',
      drain_state: 'accepting',
      last_heartbeat_at: new Date().toISOString(),
    })
    let policy = await gatewayHeartbeatPolicy(repo, 'gw_a')
    assert.deepEqual(policy.client_profile, { client: 'desktop', platform: 'macos', versionMode: 'latest' })
    // 自动重置卡与预热一样只交给指定实例；设置来自 Codex 本地设置（控制面设置存储）
    assert.deepEqual(policy.reset_credit, { enabled: true, lead_minutes: 10, max_weekly_remaining_percent: null })
    assert.equal(policy.settings_revision, 0)
    await saveCodexSettings(db, { reset_credit: { lead_minutes: 5 } }, 'test')
    assert.equal((await gatewayHeartbeatPolicy(repo, 'gw_other')).reset_credit.enabled, false)
    assert.equal((await gatewayHeartbeatPolicy(repo, 'gw_a')).reset_credit.lead_minutes, 5)
    // 点数超额开关对所有实例下发，默认关闭；配置版本随修改推进
    assert.equal(policy.credit_overage, false)
    await saveCodexSettings(db, { credit_overage: true }, 'test')
    assert.equal((await gatewayHeartbeatPolicy(repo, 'gw_other')).credit_overage, true)
    assert.equal((await gatewayHeartbeatPolicy(repo, 'gw_other')).settings_revision, 2)
    assert.equal(policy.privacy.enabled, false)
    const settings = new SettingsRepo(db)
    await settings.set('codex_client_profile', {
      selection: { client: 'cli', platform: 'windows', versionMode: 'latest' },
      deployment: { residency: 'eu' },
    })
    await settings.set('codex_privacy_policy', {
      enabled: true,
      rules: [{ id: 'r', name: 'r', steps: [{ scope: 'request_header', selector: 'x-a', action: 'remove_field' }] }],
    })
    policy = await gatewayHeartbeatPolicy(repo, 'gw_a')
    assert.equal(policy.client_profile.platform, 'windows')
    assert.deepEqual(policy.profile_deployment, { residency: 'eu' })
    assert.equal(policy.privacy.rules[0].steps[0].selector, 'x-a')
    await settings.set('codex_client_profile', { selection: { client: 'nope' } })
    assert.equal(
      readClientProfileSetting(db).selection.client,
      'desktop',
      'invalid stored profile falls back to the default',
    )

    const keys = new ApiKeyStore({ db, hashSecret: 'test' })
    const created = await keys.create({ name: 'k' })
    assert.equal(keyClientProfile(await keys.repo.getById(created.id)), null)
    await keys.update(created.id, {
      codex_client_profile: { client: 'cli', platform: 'macos', versionMode: 'fixed', codexVersion: '0.150.0' },
    })
    assert.equal(keyClientProfile(await keys.repo.getById(created.id)).codexVersion, '0.150.0')
    await assert.rejects(() => keys.update(created.id, { codex_client_profile: { client: 'cli' } }), {
      code: 'invalid_client_profile',
    })
    await keys.update(created.id, { codex_client_profile: null })
    assert.equal((await keys.repo.getById(created.id)).codex_client_profile, null)
  } finally {
    db.close()
  }
})

// 只支持单个 Worker（Gateway 事实直读 G4b）：冻结只记下供供应商门户显示，不再随心跳转发给其他实例
test('protection freezes reported by the Worker are recorded for display, not forwarded in the policy', async () => {
  const db = createDatabase({ dbPath: ':memory:' })
  try {
    db.exec('PRAGMA foreign_keys=OFF')
    const repo = new GatewayWorkerRepo(db)
    await repo.upsertInstance({
      id: 'gw_a',
      name: 'gw_a',
      base_url: 'http://127.0.0.1:1',
      health_state: 'healthy',
      drain_state: 'accepting',
      last_heartbeat_at: new Date().toISOString(),
    })
    db.prepare(
      "INSERT INTO vendor_resources(id,vendor_id,resource_type,name,status,config_json,created_by,created_at,updated_at) VALUES('acc','v','account','acc','active','{}','t','now','now')",
    ).run()
    db.prepare(
      "INSERT INTO gateway_worker_account_bindings(id,account_resource_id,runtime_account_id,projection_status,created_at,updated_at) VALUES('b_a','acc','rt_a','synced','now','now')",
    ).run()
    const until = new Date(Date.now() + 600_000).toISOString()
    await repo.recordAccountFreezes('gw_a', [
      { account_id: 'rt_a', frozen_until: until, reason: 'rule' },
      { account_id: 'unknown', frozen_until: until },
    ])
    const rows = () =>
      db
        .prepare('SELECT account_resource_id,frozen_until,reason FROM gateway_account_freezes')
        .all()
        .map((row) => ({ ...row }))
    assert.deepEqual(rows(), [{ account_resource_id: 'acc', frozen_until: until, reason: 'rule' }])
    assert.equal('account_freezes' in (await gatewayHeartbeatPolicy(repo, 'gw_a')), false)
    await repo.recordAccountFreezes('gw_a', [])
    assert.deepEqual(rows(), [], 'an empty report clears the freeze')
  } finally {
    db.close()
  }
})
