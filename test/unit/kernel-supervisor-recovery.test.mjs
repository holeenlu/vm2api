import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createKernelWatchdog } from '../../src/lib/transport/kernel-watchdog.mjs'
import { ensureRustKernel, writeKernelConfig } from '../../src/lib/transport/rust-kernel-supervisor.mjs'

const UNHEALTHY = { ok: true, engine: 'rust', healthy: false, ready_slots: 0, cli_pid: 0 }
const HEALTHY = { ok: true, engine: 'rust', healthy: true, ready_slots: 20, cli_pid: 7 }

async function fixture(runtime, { waitOnly, launchFails = false }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-'))
  const vm = { id: 'vm-recover', status: 'running', runtime: { type: runtime, accel: 'kvm', container: 'kin-test' } }
  const written = writeKernelConfig(root, vm, { token: 'fixture', proxyUrl: '', proxyRequired: false })
  vm.runtime.kernel_socket = written.socketPath
  const homeDir = path.join(root, 'vms', vm.id, 'cli-home')
  const commands = []
  let server
  let healthReads = 0
  let launches = 0
  let at = 0
  let result
  async function serve() {
    if (server) await new Promise((resolve) => server.close(resolve))
    server = http.createServer((_req, res) => {
      healthReads++
      const ready = waitOnly ? healthReads > 1 : launches > 0
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(ready ? HEALTHY : UNHEALTHY))
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(written.socketPath, resolve)
    })
  }
  await serve()
  const runDockerExec = async (args) => {
    commands.push(args)
    if (args[0] === 'inspect') return { ok: true, stdout: '/home/kincli/.kin/kin-kernel' }
    if (args[0] === 'restart' || args.includes('systemctl')) {
      launches++
      await serve()
      if (launchFails) return { ok: false, error: 'fixture restart command failed' }
    }
    return { ok: true }
  }
  const wd = createKernelWatchdog({
    listTargets: () => [vm],
    homeDirFor: () => homeDir,
    config: { restart_backoff_sec: [10] },
    now: () => at,
    observeRuntime: async () => ({ state: 'running' }),
    health: async () => UNHEALTHY,
    ensure: async (exec) => {
      result = await ensureRustKernel(exec, { timeoutMs: 1000, runDockerExec, force: !waitOnly })
      return result
    },
  })
  return {
    wd,
    vm,
    commands,
    result: () => result,
    launches: () => launches,
    advance: () => {
      at = 10_000
    },
    close: async () => {
      wd.reset(vm.id)
      if (server) await new Promise((resolve) => server.close(resolve))
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

for (const runtime of ['docker', 'kvm']) {
  test(`a ${runtime} kernel becoming healthy before a launch does not spend watchdog budget`, {
    skip: process.platform === 'win32',
  }, async () => {
    const f = await fixture(runtime, { waitOnly: true })
    try {
      await f.wd.tick()
      f.advance()
      await f.wd.tick()
      assert.equal(f.result()?.ok, true)
      assert.equal(f.result()?.reason, 'already_up')
      assert.equal(f.launches(), 0)
      assert.equal(f.wd.restartsInWindow(f.vm.id), 0)
      assert.equal(
        f.commands.some((args) => args.some((arg) => String(arg).includes('kill -KILL'))),
        false,
      )
    } finally {
      await f.close()
    }
  })

  test(`a ${runtime} kernel that required a launch still spends watchdog budget`, {
    skip: process.platform === 'win32',
  }, async () => {
    const f = await fixture(runtime, { waitOnly: false })
    try {
      await f.wd.tick()
      f.advance()
      await f.wd.tick()
      assert.equal(f.result()?.ok, true)
      assert.equal(f.result()?.reason, 'started_in_vm')
      assert.equal(f.launches(), 1)
      assert.equal(f.wd.restartsInWindow(f.vm.id), 1)
    } finally {
      await f.close()
    }
  })
}

test('KVM becoming healthy after a failed restart command still spends the attempted recovery', {
  skip: process.platform === 'win32',
}, async () => {
  const f = await fixture('kvm', { waitOnly: false, launchFails: true })
  try {
    await f.wd.tick()
    f.advance()
    await f.wd.tick()
    assert.equal(f.result()?.ok, true)
    assert.equal(f.result()?.reason, 'started_in_vm')
    assert.equal(f.launches(), 1)
    assert.equal(f.wd.restartsInWindow(f.vm.id), 1)
  } finally {
    await f.close()
  }
})
