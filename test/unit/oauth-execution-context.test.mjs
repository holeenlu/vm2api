import assert from 'node:assert/strict'
import test from 'node:test'
import { createOAuthExecutionContext } from '../../src/lib/oauth/oauth-execution-context.mjs'

test('OAuth execution context combines credential and redacted proxy facts', () => {
  const context = createOAuthExecutionContext({
    projectRoot: '/tmp/project',
    vm: {
      id: 'vm-1',
      claude: { access_token: 'token', refresh_token: 'refresh' },
      proxy: { id: 'px-1', kind: 'local', host: '127.0.0.1', port: 8080 },
    },
  })
  assert.equal(context.vmId, 'vm-1')
  assert.equal(context.credential.access, true)
  assert.equal(context.credential.refresh, true)
  assert.equal(context.proxy.proxy_id, 'px-1')
  assert.equal(Object.isFrozen(context), true)
})
