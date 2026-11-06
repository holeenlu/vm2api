import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyClaudePaste, resolveCodexPaste, sessionKeyOauth } from '../../src/lib/oauth/credential-paste.mjs'

const API_KEY = 'sk-ant-api03-abcdefghijklmnop'

test('Claude paste: Console API Key wins by prefix or requested type', () => {
  for (const body of [{ api_key: API_KEY }, { session_key: API_KEY }, { access_token: ` ${API_KEY} ` }]) {
    const paste = classifyClaudePaste({ ...body, auth_scheme: 'x-api-key' })
    assert.equal(paste.kind, 'apikey')
    assert.equal(paste.oauth.api_key, API_KEY)
    assert.equal(paste.oauth.access_token, API_KEY)
    assert.equal(paste.oauth.type, 'apikey')
    assert.equal(paste.oauth.base_url, 'https://api.anthropic.com')
    assert.equal(paste.oauth.auth_scheme, 'x-api-key')
  }
  assert.equal(classifyClaudePaste({ type: 'apikey', api_key: 'sk-other' }).kind, 'invalid_api_key')
  assert.equal(classifyClaudePaste({ type: 'console', access_token: 'sk-other' }).kind, 'invalid_api_key')
})

test('Claude paste: sessionKey scope follows the requested type; Setup Token is marked after exchange', () => {
  const full = classifyClaudePaste({ sessionKey: ' sk-ant-sid01-abc ' })
  assert.deepEqual(full, { kind: 'session_key', sessionKey: 'sk-ant-sid01-abc', scope: 'full', authScheme: undefined })
  for (const body of [
    { type: 'setup-token' },
    { type: 'setup_token' },
    { scope: 'inference' },
    { type: 'inference' },
  ]) {
    const paste = classifyClaudePaste({ ...body, session_key: 'sk-ant-sid01-abc', authScheme: 'bearer' })
    assert.equal(paste.scope, 'inference')
    const oauth = sessionKeyOauth({ access_token: 'at' }, paste)
    assert.equal(oauth.type, 'setup-token')
    assert.equal(oauth.mode, 'setup-token')
    assert.equal(oauth.auth_scheme, 'bearer')
  }
  assert.equal(sessionKeyOauth({ access_token: 'at', type: 'oauth' }, full).type, 'oauth')
})

test('Claude paste: sub2api export before access token; access token keeps pasted identity', () => {
  const exported = classifyClaudePaste(
    { accounts: [{ type: 'oauth', credentials: { access_token: 'sk-ant-oat01-x', refresh_token: 'rt' } }] },
    { claude: { email: 'slot@example.test' } },
  )
  assert.equal(exported.kind, 'sub2api')
  assert.equal(exported.oauth.source, 'sub2api-account-export')
  assert.equal(exported.oauth.email, 'slot@example.test')
  const pasted = classifyClaudePaste({ access_token: 'sk-ant-oat01-y', email: 'a@example.test', auth_scheme: 'bearer' })
  assert.equal(pasted.kind, 'access_token')
  assert.equal(pasted.oauth.access_token, 'sk-ant-oat01-y')
  assert.equal(pasted.oauth.email, 'a@example.test')
  assert.equal(pasted.oauth.account_uuid, null)
  assert.equal(pasted.oauth.auth_scheme, 'bearer')
  assert.equal(classifyClaudePaste({}).kind, 'missing')
  assert.throws(() => classifyClaudePaste({ access_token: 'sk-ant-оat' }), { code: 'access_token_invalid' })
})

test('Codex paste: refresh only when the file has no access token, keeping only token fields', async () => {
  const calls = []
  const refresh = async (refreshToken) => {
    calls.push(refreshToken)
    return { ok: true, access_token: 'at-new', refresh_token: 'rt-new', expires_at: 123, extra: 'ignored' }
  }
  const direct = await resolveCodexPaste(
    { auth_json: JSON.stringify({ access_token: 'at', refresh_token: 'rt' }) },
    refresh,
  )
  assert.equal(direct.ok, true)
  assert.equal(direct.account.access_token, 'at')
  assert.deepEqual(calls, [])
  const refreshed = await resolveCodexPaste({ auth_json: JSON.stringify({ refresh_token: 'rt-only' }) }, refresh)
  assert.equal(refreshed.ok, true)
  assert.deepEqual(calls, ['rt-only'])
  assert.equal(refreshed.account.access_token, 'at-new')
  assert.equal(refreshed.account.refresh_token, 'rt-new')
  assert.equal(refreshed.account.expires_at, 123)
  assert.equal(refreshed.account.extra, undefined)
  assert.equal(refreshed.account.ok, undefined)

  const failed = await resolveCodexPaste({ auth_json: JSON.stringify({ refresh_token: 'rt' }) }, async () => ({
    ok: false,
    error: 'invalid_grant',
  }))
  assert.deepEqual(failed, { ok: false, stage: 'refresh', result: { ok: false, error: 'invalid_grant' } })
  const skipped = await resolveCodexPaste({ auth_json: JSON.stringify({ refresh_token: 'rt' }) }, async () => null)
  assert.deepEqual(skipped, { ok: false, stage: 'refresh', result: null })
  const invalid = await resolveCodexPaste({ auth_json: '{not json' }, refresh)
  assert.equal(invalid.ok, false)
  assert.equal(invalid.stage, 'parse')
  assert.ok(invalid.code)
})
