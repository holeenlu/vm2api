import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { prepareSlotOAuth, runGuestOAuthAuthService } from '../../src/lib/oauth/guest-oauth-helper.mjs'
import { slotExec, startSlotReady } from '../../src/lib/vm/slot-runtime.mjs'
import { getVm } from '../../src/lib/vm/vm-registry.mjs'

function fixture(t, runtime = 'docker') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-readiness-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const vm = {
    id: 'vm-01',
    platform: 'anthropic',
    runtime: { type: runtime },
    status: 'stopped',
    schedulable: false,
    claude: {},
    proxy: { id: 'px-local' },
  }
  const dir = path.join(root, 'vms', vm.id, 'run')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(root, 'vms', vm.id + '.json'), JSON.stringify(vm))
  fs.writeFileSync(
    path.join(dir, 'kernel.json'),
    JSON.stringify({
      credential_path: '/home/kincli/.claude/credentials.json',
    }),
  )
  return { root, vm, exec: slotExec(root, vm) }
}

// Exercise the real lifecycle wrappers; replace only OS start and kernel probe.
function startup(overrides = {}) {
  return (vm, root, opts) =>
    startSlotReady(vm, root, {
      ...opts,
      ops: {
        startSlot: async () => ({ ok: true, runtime: { type: vm.runtime.type } }),
        materializeWrapCli: () => ({ ok: true, glibc_shim: true }),
        ensureRustKernel: async (_exec, options) => {
          assert.equal(options.allowMissingCredential, true)
          return { ok: true, health: { vm_telemetry: true, telemetry_ready: true, cli_pid: 42 } }
        },
        ...overrides,
      },
    })
}

for (const runtime of ['docker', 'kvm']) {
  test(`${runtime}: healthy unauthenticated VM reaches OAuth helper through real readiness wrappers`, async (t) => {
    const { root, vm, exec } = fixture(t, runtime)
    let invoked = false
    const credential = await runGuestOAuthAuthService(
      { operation: 'authorization_code', code: 'fixture' },
      {
        exec,
        projectRoot: root,
        prepare: (options) => prepareSlotOAuth({ ...options, startReady: startup() }),
        postTelemetry: async () => ({ ok: true }),
        runDocker: async (_argv, { stdin }) => {
          invoked = true
          assert.equal(JSON.parse(stdin).operation, 'authorization_code')
          return { code: 0, stdout: JSON.stringify({ ok: true, credential: { access_token: 'fixture' } }) }
        },
      },
    )
    assert.equal(invoked, true)
    assert.equal(credential.access_token, 'fixture')
    assert.equal(getVm(root, vm.id).status, 'running')
    assert.equal(getVm(root, vm.id).schedulable, false)
  })
}

for (const [label, overrides, routing, code] of [
  [
    'container failure',
    { startSlot: async () => ({ ok: false, code: 'container_not_ready' }) },
    {},
    'container_not_ready',
  ],
  [
    'kernel timeout',
    { ensureRustKernel: async () => ({ ok: false, reason: 'health_timeout' }) },
    {},
    'kernel_health_timeout',
  ],
  ['missing telemetry', { ensureRustKernel: async () => ({ ok: true, health: {} }) }, {}, 'oauth_runtime_not_ready'],
  [
    'telemetry starting',
    { ensureRustKernel: async () => ({ ok: true, health: { vm_telemetry: true, telemetry_ready: false } }) },
    {},
    'oauth_runtime_not_ready',
  ],
]) {
  test(`OAuth still rejects ${label} without running the helper or enabling scheduling`, async (t) => {
    const { root, vm, exec } = fixture(t)
    await assert.rejects(
      runGuestOAuthAuthService(
        { operation: 'session_key' },
        {
          exec,
          projectRoot: root,
          routing,
          prepare: (options) => prepareSlotOAuth({ ...options, startReady: startup(overrides) }),
          runDocker: async () => {
            assert.fail('helper must not run before readiness')
          },
        },
      ),
      (error) => error.code === code,
    )
    assert.equal(getVm(root, vm.id).status, 'stopped')
    assert.equal(getVm(root, vm.id).schedulable, false)
  })
}
