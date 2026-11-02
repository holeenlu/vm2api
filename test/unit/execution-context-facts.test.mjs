import assert from 'node:assert/strict'
import test from 'node:test'
import { createExecutionContext } from '../../src/lib/vm/execution-context.mjs'
import { proxyBindingOfVm } from '../../src/lib/vm/proxy-binding.mjs'

test('execution context freezes per-attempt paths and credential facts', () => {
  const vm = { id: 'vm-1', claude: { email: 'vm@example.com' }, timezone: 'Asia/Shanghai' }
  const context = createExecutionContext({
    projectRoot: '/tmp/project',
    vm,
    accountId: 'acct-1',
    credential: { email: 'slot@example.com', account_uuid: 'acct-uuid' },
  })
  assert.equal(context.vmId, 'vm-1')
  assert.equal(context.accountId, 'acct-1')
  assert.equal(context.oauth.email, 'slot@example.com')
  assert.equal(context.oauth.account_uuid, 'acct-uuid')
  assert.equal(Object.isFrozen(context), true)
})

test('proxy binding facts redact credentials and preserve local egress mode', () => {
  const binding = proxyBindingOfVm({
    id: 'vm-1',
    proxy: { id: 'px-1', kind: 'local', host: '127.0.0.1', port: 8080, username: 'secret' },
  })
  assert.deepEqual(binding, {
    vm_id: 'vm-1',
    proxy_id: 'px-1',
    mode: 'local',
    endpoint: '127.0.0.1:8080',
    enabled: true,
    local_egress: true,
  })
  assert.equal('username' in binding, false)
})
