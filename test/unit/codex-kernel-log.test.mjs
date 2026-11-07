import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  closeCodexKernelLogFd,
  codexKernelLogPath,
  openCodexKernelLog,
  resetCodexKernelLogs,
  rotateKernelLog,
  trimCodexKernelLogs,
} from '../../src/lib/transport/codex-kernel-log.mjs'
import { ensureCodexKernel, stopCodexKernel } from '../../src/lib/transport/codex-kernel-supervisor.mjs'

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-kernel-log-'))
  t.after(() => {
    resetCodexKernelLogs()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

function setEnv(t, values) {
  const prev = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
  Object.assign(process.env, values)
  t.after(() => {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

test('#684 kernel logs live under the data dir, one file per slot', (t) => {
  const data = tmp(t)
  const env = { KIN_DATA_DIR: data }
  assert.equal(codexKernelLogPath('vm-gpt-a', env), path.join(data, 'logs', 'codex-kernel', 'vm-gpt-a.log'))
  assert.equal(codexKernelLogPath('../x', env), path.join(data, 'logs', 'codex-kernel', '___x.log'))
  assert.equal(codexKernelLogPath('', env), null)
  const fd = openCodexKernelLog('vm-gpt-a', { env })
  assert.equal(typeof fd, 'number')
  fs.writeSync(fd, 'panic: boom\n')
  closeCodexKernelLogFd(fd)
  const file = codexKernelLogPath('vm-gpt-a', env)
  assert.match(fs.readFileSync(file, 'utf8'), /kin-codex-kernel start vm-gpt-a\npanic: boom\n$/)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
})

test('#684 an unwritable log dir falls back to ignore instead of blocking the kernel', (t) => {
  const data = tmp(t)
  fs.writeFileSync(path.join(data, 'logs'), 'not a directory')
  t.mock.method(console, 'warn', () => {})
  assert.equal(openCodexKernelLog('vm-gpt-a', { env: { KIN_DATA_DIR: data } }), 'ignore')
})

test('#684 the log is capped: copy-truncate keeps one previous file and the writer keeps appending', (t) => {
  const data = tmp(t)
  const env = { KIN_DATA_DIR: data }
  const fd = openCodexKernelLog('vm-gpt-a', { env })
  const file = codexKernelLogPath('vm-gpt-a', env)
  // A running kernel keeps its O_APPEND descriptor across the rotation.
  fs.writeSync(fd, 'x'.repeat(2048))
  assert.equal(rotateKernelLog(file, { maxBytes: 1024 }), true)
  assert.equal(fs.statSync(file).size, 0)
  assert.ok(fs.statSync(`${file}.1`).size > 2048)
  fs.writeSync(fd, 'after\n')
  assert.equal(fs.readFileSync(file, 'utf8'), 'after\n')
  // Under the cap nothing moves.
  assert.equal(rotateKernelLog(file, { maxBytes: 1024 }), false)
  // The periodic trim covers every file a kernel was started with; .1 is replaced, never chained.
  fs.writeSync(fd, 'y'.repeat(4096))
  trimCodexKernelLogs({ maxBytes: 1024 })
  assert.equal(fs.statSync(file).size, 0)
  assert.match(fs.readFileSync(`${file}.1`, 'utf8'), /^after\ny+$/)
  assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ['vm-gpt-a.log', 'vm-gpt-a.log.1'])
  closeCodexKernelLogFd(fd)
  // A restart over the cap rotates before appending.
  fs.writeFileSync(file, 'z'.repeat(8192))
  closeCodexKernelLogFd(openCodexKernelLog('vm-gpt-a', { env, maxBytes: 1024 }))
  assert.ok(fs.statSync(file).size < 1024)
})

test('#684 the spawned kernel writes its stderr to the slot log', async (t) => {
  const root = tmp(t)
  const data = path.join(root, 'data')
  const bin = path.join(root, 'fake-kernel')
  fs.writeFileSync(bin, '#!/bin/sh\necho "kernel stderr line $1" >&2\necho "kernel stdout line"\n', { mode: 0o755 })
  setEnv(t, { KIN_CODEX_KERNEL_BIN: bin, KIN_DATA_DIR: data })
  const exec = {
    vmId: 'vm-codex-log',
    homeDir: path.join(root, 'vm-codex-log', 'cli-home'),
    vm: { id: 'vm-codex-log', runtime: {} },
  }
  t.after(() => stopCodexKernel('vm-codex-log'))
  await ensureCodexKernel(exec, { timeoutMs: 300 })
  const file = path.join(data, 'logs', 'codex-kernel', 'vm-codex-log.log')
  for (let i = 0; i < 40 && !/kernel stderr line/.test(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''); i++)
    await new Promise((r) => setTimeout(r, 50))
  const text = fs.readFileSync(file, 'utf8')
  assert.match(text, /kernel stderr line .*codex-kernel\.json/)
  assert.doesNotMatch(text, /kernel stdout line/)
})
