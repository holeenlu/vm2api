import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  compareAgainstBaselineRun,
  compareAgainstStoredProfile,
  judge,
  median,
  prepareBaselineTree,
  resolveNodeModules,
  splitRounds,
} from '../../scripts/bench/gate.mjs'
import { makeRequests } from '../../scripts/bench/gateway-bench.mjs'

const { rule } = JSON.parse(fs.readFileSync(new URL('../../scripts/bench/baseline.json', import.meta.url), 'utf8'))

test('perf gate fails a steady regression, only warns when rounds are noisy', () => {
  assert.equal(median([3, 1, 2]), 2)
  assert.equal(median([4, 1, 3, 2]), 2.5)
  // within margin
  assert.equal(judge('p99', [20, 21, 22], 20, rule).status, 'pass')
  // small baselines get the absolute slack instead of a few-percent limit
  assert.equal(judge('elu_mean', [0.05, 0.06, 0.065], 0.05, rule).status, 'pass')
  // steady regression past max(base*1.15, base+slack)
  const steady = judge('p99', [40, 41, 42], 30, rule)
  assert.equal(steady.status, 'regressed')
  assert.equal(steady.limit, 35)
  // same median, rounds scattered (relative MAD above noise_limit): warning only
  assert.equal(judge('p99', [25, 41, 60], 30, rule).status, 'noisy_regressed')
})

test('perf gate fails rounds with gateway errors and only excludes client-side connection failures', () => {
  const ok = { failed: 0, failed_statuses: [] }
  const client = { failed: 36, failed_statuses: [0] }
  const overloaded = { failed: 1, failed_statuses: [529] }
  const mixed = { failed: 3, failed_statuses: [0, 529] }
  const rounds = splitRounds([ok, client, overloaded, mixed])
  assert.deepEqual(rounds.clean, [ok])
  assert.deepEqual(rounds.clientOnly, [client])
  assert.deepEqual(rounds.gateway, [overloaded, mixed])
})

test('bench long mode grows each session append-only and stays off any network address', () => {
  const next = makeRequests('long')
  const first = next()
  const body = JSON.parse(first.body)
  assert.match(first.headers['x-claude-code-session-id'], /^bench-session-\d$/)
  for (let i = 0; i < 7; i++) next()
  const again = JSON.parse(next().body) // same session, two messages later
  assert.equal(again.messages.length, body.messages.length + 2)
  assert.deepEqual(again.messages.slice(0, body.messages.length - 1), body.messages.slice(0, -1))
  const bench = fs.readFileSync(new URL('../../scripts/bench/gateway-bench.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(bench, /https?:\/\/(?!127\.0\.0\.1)[\w.-]+\.\w+/)
})

const SHA = 'a'.repeat(40)
const rounds = (elu, p99) => elu.map((v, i) => ({ elu_mean: v, p99: p99[i], failed: 0, failed_statuses: [] }))

test('the gate compares the two sides measured in the same run, not a stored number', () => {
  const quiet = []
  const warn = (level, message) => quiet.push([level, message])
  const modes = ['tiny']
  // 同机同时段：当前代码比基线代码高一倍 → 回退
  const regressed = compareAgainstBaselineRun(
    { tiny: rounds([0.12, 0.121, 0.119], [40, 41, 39]) },
    { tiny: rounds([0.06, 0.061, 0.059], [20, 21, 19]) },
    modes,
    rule,
    { warn },
  )
  assert.equal(regressed.failed, true)
  assert.ok(quiet.some(([level, m]) => level === 'error' && m.includes('baseline code')))
  // 机器整体变慢：两边一起抬高，相对关系不变 → 通过（这正是存档比较会误判的情形）
  const slowMachine = compareAgainstBaselineRun(
    { tiny: rounds([0.117, 0.118, 0.116], [38, 39, 37]) },
    { tiny: rounds([0.115, 0.116, 0.114], [37, 38, 36]) },
    modes,
    rule,
    { warn: () => {} },
  )
  assert.equal(slowMachine.failed, false)
  assert.equal(slowMachine.rows[0][5], 'pass')
})

test('without a baseline tree the gate only warns, whatever the stored numbers say', () => {
  const messages = []
  const warn = (level, message) => messages.push(`${level}: ${message}`)
  const stored = { tiny: { elu_mean: 0.077, p99: 19 } }
  const result = compareAgainstStoredProfile(
    { tiny: rounds([0.117, 0.118, 0.116], [38, 39, 37]) },
    stored,
    ['tiny'],
    rule,
    'dependencies differ',
    { warn },
  )
  assert.equal(result.failed, false)
  assert.ok(result.rows[0][5].includes('warn only'))
  assert.ok(messages.every((m) => m.startsWith('warning:')))
  assert.ok(messages.some((m) => m.includes('dependencies differ')))
})

test('the baseline tree is refused rather than faked when it cannot be prepared', () => {
  const dir = path.join(os.tmpdir(), 'kin-gate-test-baseline')
  const git =
    (calls, { head = 'b'.repeat(40), missing = false, depsDiffer = false } = {}) =>
    (...args) => {
      calls.push(args.join(' '))
      const cmd = args[2]
      if (cmd === 'rev-parse' && args[3] === 'HEAD') return `${head}\n`
      if (cmd === 'rev-parse' && missing) throw new Error('unknown revision')
      if (cmd === 'diff' && depsDiffer) throw new Error('differ')
      if (cmd === 'worktree' && args[3] === 'add') fs.mkdirSync(dir, { recursive: true })
      return ''
    }
  assert.match(prepareBaselineTree('', dir, { root: '.', run: () => '' }).skip, /no baseline_commit/)
  assert.match(prepareBaselineTree(SHA, dir, { root: '.', run: git([], { head: SHA }) }).skip, /is HEAD/)
  assert.match(
    prepareBaselineTree(SHA, dir, { root: '.', run: git([], { depsDiffer: true }) }).skip,
    /dependencies differ/,
  )
  // 本地没有该提交时先按 SHA 拉一次，拉不到才放弃
  const calls = []
  const fetched = prepareBaselineTree(SHA, dir, {
    root: '.',
    run: (...args) => {
      calls.push(args.join(' '))
      if (args[2] === 'rev-parse' && args[3] === 'HEAD') return `${'b'.repeat(40)}\n`
      if (args[2] === 'rev-parse') throw new Error('unknown revision')
      if (args[2] === 'worktree' && args[3] === 'add') fs.mkdirSync(dir, { recursive: true })
      return ''
    },
  })
  assert.equal(fetched.dir, dir)
  assert.ok(calls.some((c) => c.includes(`fetch --no-tags --depth=1 origin ${SHA}`)))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('the baseline tree shares real node_modules, never a dangling link', () => {
  // worktree 自己没有 node_modules，靠 Node 往上找到主检出的；直接 join(root, 'node_modules')
  // 会造出悬空链接，网关起不来才发现（2026-11-07 实测）
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-gate-modules-'))
  const nested = path.join(base, 'a', 'b')
  fs.mkdirSync(nested, { recursive: true })
  const outside = resolveNodeModules(nested) // 临时目录之上通常没有，但不依赖这一点
  assert.notEqual(outside, path.join(base, 'node_modules'))
  fs.mkdirSync(path.join(base, 'node_modules'))
  assert.equal(resolveNodeModules(nested), path.join(base, 'node_modules'))
  fs.rmSync(base, { recursive: true, force: true })
})
