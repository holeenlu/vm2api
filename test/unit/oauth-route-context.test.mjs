import test from 'node:test'
import assert from 'node:assert/strict'
import { oauthCredentialState, oauthCredentialView, oauthVmPaths } from '../../src/lib/oauth/oauth-route-context.mjs'

test('OAuth route context keeps paths and refresh policy canonical', () => {
  assert.deepEqual(oauthVmPaths('/srv/project', 'vm-1'), {
    vmPath: '/srv/project/vms/vm-1.json',
    homeDir: '/srv/project/vms/vm-1/cli-home',
    slotDir: '/srv/project/vms/vm-1',
  })
  assert.equal(oauthCredentialState({ claude: { mode: 'apikey' } }).refreshable, false)
  assert.equal(oauthCredentialState({ claude: { mode: 'oauth', has_refresh: true } }).refreshable, true)
  assert.deepEqual(oauthCredentialView({ id: 'vm-1' }, {}), {
    vm_id: 'vm-1',
    has_token: false,
    source: null,
  })
})
