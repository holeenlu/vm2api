import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { generateAuthUrl } from '../../src/lib/oauth/oauth-auth-url.mjs'

test('Claude code and Cookie HTTP endpoints carry their target VM execution context', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-context-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const previous = process.env.KIN_FAKE_SESSION_OAUTH
  process.env.KIN_FAKE_SESSION_OAUTH = '0'
  t.after(() =>
    previous == null ? delete process.env.KIN_FAKE_SESSION_OAUTH : (process.env.KIN_FAKE_SESSION_OAUTH = previous),
  )
  fs.mkdirSync(path.join(root, 'vms'))
  // An expired binding deliberately stops at prepareSlotOAuth, before Docker or
  // any provider request. The old HTTP path failed earlier with oauth_vm_required.
  const vm = {
    id: 'vm-context',
    platform: 'anthropic',
    runtime_type: 'docker',
    status: 'stopped',
    kernel: 'claude',
    claude: {},
    proxy: { host: '127.0.0.1', port: 3128, expires_at: '2000-01-01T00:00:00Z' },
  }
  fs.writeFileSync(path.join(root, 'vms', vm.id + '.json'), JSON.stringify(vm))
  const link = generateAuthUrl({ vmId: vm.id, proxyUrl: 'http://127.0.0.1:3128' })
  for (const [suffix, body] of [
    ['exchange-code', { session_id: link.session_id, code: 'test-code#provider-state' }],
    ['import', { vm_id: vm.id, session_key: 'sk-ant-sid01-test-only', type: 'oauth' }],
  ]) {
    let response
    const handler = createPanelHandler({
      cfg: { paths: { project: root }, vm: { id: null } },
      routingConfig: {},
      requireAuth(req) {
        req.apiKeyKind = 'master'
        req.panelRole = 'super_admin'
        return true
      },
      readBody: async () => body,
      // Test the HTTP-to-helper contract. A stale read permits the request here;
      // the helper must reread precisely this VM and reject its expired exit.
      requireSlotProxy: () => ({ ok: true, proxyUrl: 'http://127.0.0.1:3128' }),
      json(_res, status, payload) {
        response = { status, payload }
        return true
      },
    })
    await handler(
      { method: 'POST' },
      {},
      new URL(
        suffix === 'import'
          ? 'http://localhost/api/panel/vms/import'
          : `http://localhost/api/panel/vms/${vm.id}/oauth/${suffix}`,
      ),
    )
    assert.equal(response?.status, suffix === 'import' ? 500 : 502, JSON.stringify(response))
    assert.equal(response.payload.error.code, 'proxy_expired', JSON.stringify(response))
  }
})
