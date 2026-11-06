import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const BIOME = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'biome.cmd' : 'biome')

// 引用未声明的变量（漏 import、用了别的作用域里的名字）只在运行到那一行时才抛 ReferenceError，
// 常被 try/catch 吞掉。项目的 biome.json 未启用 lint，这里单独跑这一条规则。
const NODE_GLOBALS = [
  'AbortController',
  'AbortSignal',
  'Blob',
  'Buffer',
  'BroadcastChannel',
  'CompressionStream',
  'DecompressionStream',
  'DOMException',
  'Event',
  'EventTarget',
  'File',
  'FormData',
  'Headers',
  'MessageChannel',
  'ReadableStream',
  'Request',
  'Response',
  'TextDecoder',
  'TextEncoder',
  'TransformStream',
  'URL',
  'URLSearchParams',
  'WebAssembly',
  'WebSocket',
  'WritableStream',
  'atob',
  'btoa',
  'clearImmediate',
  'clearInterval',
  'clearTimeout',
  'console',
  'crypto',
  'fetch',
  'globalThis',
  'navigator',
  'performance',
  'process',
  'queueMicrotask',
  'setImmediate',
  'setInterval',
  'setTimeout',
  'structuredClone',
]

test('src has no references to undeclared variables', { skip: !fs.existsSync(BIOME) && 'biome not installed' }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-undeclared-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.symlinkSync(path.join(ROOT, 'src'), path.join(dir, 'src'), 'dir')
  fs.writeFileSync(
    path.join(dir, 'biome.json'),
    JSON.stringify({
      files: { includes: ['src/**'] },
      linter: { enabled: true, rules: { recommended: false, correctness: { noUndeclaredVariables: 'error' } } },
      javascript: { globals: NODE_GLOBALS },
    }),
  )
  const run = spawnSync(BIOME, ['lint', '--max-diagnostics=50', 'src'], { cwd: dir, encoding: 'utf8' })
  const output = `${run.stdout}\n${run.stderr}`
  assert.match(output, /Checked [1-9]\d* files/, output)
  assert.equal(run.status, 0, output)
})
