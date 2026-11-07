#!/usr/bin/env node
// 性能回退门槛：在同一个 job 里把固定的基线提交也检出一份，和当前代码交替跑，比的是同一台机器、
// 同一时段的两组数字。
//
// 为什么不跟存档的绝对数字比：ELU 是利用率，共享 runner 上邻居负载直接抬高它，机器之间（甚至同机
// 不同时段）的差别比代码差别大得多。2026-11-07 CI 上同一份源码（`f28540cd` 与 `6372a249` 的 src
// 完全相同）相隔 8 分钟在两台 runner 上测出 tiny ELU 0.127 与 0.117，而存档基线是 0.077：先跑的那次
// 数字更差却因为没有该机型基线被放过，后跑的那次数字更好反而被判回退。轮间 MAD 只能看出一次运行
// 内部稳不稳，看不出两次运行之间机器快慢不同。
//
//   node scripts/bench/gate.mjs [--rounds 5] [--modes tiny,long] [--root .]
//                               [--against <dir>] [--baseline <json>] [--profile <name>]
//                               [--write-baseline]
//
// 判定（阈值依据见 baseline.json 的 rule）：
// - 网关返回 HTTP 错误（如 529）的轮次：失败。只有客户端连接失败（状态 0，网关没收到请求）的轮次
//   不进中位数并告警；超过一半轮次被排除也失败。
// - 当前代码的中位数 > max(基线代码中位数 × (1 + margin), 基线中位数 + slack)：回退。
// - 该指标各轮相对 MAD（中位数绝对偏差 / 中位数）> noise_limit：本次测量不稳定，回退只告警不失败。
// - 准备不出基线树（没有 `baseline_commit`、依赖不同、拉不到该提交、基线就是 HEAD）：退回与
//   baseline.json 里同机器画像的存档数字比较，**只告警不失败**，并说明原因。存档数字用
//   `--write-baseline` 记录，只作参考。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runBench } from './gateway-bench.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const METRICS = ['elu_mean', 'p99']

function parseArgs(argv) {
  const out = {
    rounds: 5,
    modes: null,
    root: path.resolve(HERE, '../..'),
    baseline: path.join(HERE, 'baseline.json'),
    against: '',
    profile: '',
    write: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const [k, v] = [argv[i], argv[i + 1]]
    if (k === '--write-baseline') {
      out.write = true
      continue
    }
    if (k === '--rounds') out.rounds = Number(v)
    else if (k === '--modes') out.modes = v.split(',').filter(Boolean)
    else if (k === '--root') out.root = path.resolve(v)
    else if (k === '--baseline') out.baseline = path.resolve(v)
    else if (k === '--against') out.against = path.resolve(v)
    else if (k === '--profile') out.profile = v
    else continue
    i++
  }
  return out
}

/** 机器画像：系统、架构、CPU 型号与核数。只用于存档数字的退路比较。 */
export function machineProfile() {
  const cpus = os.cpus()
  const model = String(cpus[0]?.model || 'unknown-cpu')
    .replace(/\(R\)|\(TM\)|CPU|Processor|@.*$/gi, '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase()
  return `${process.platform}-${process.arch}-${model}-${cpus.length}c-node${process.versions.node.split('.')[0]}`
}

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * 按失败请求分轮：网关返回的 HTTP 错误（非 0 状态）是回退，例如调度器漏唤醒后请求等满
 * sticky_wait_timeout_ms 返回 529（W16 续修复）；状态 0 是压测客户端自己的连接失败（机器负载很高时
 * fetch 立即报错，网关日志里没有这些请求），与网关无关，只排除。
 */
export function splitRounds(samples) {
  const clean = []
  const clientOnly = []
  const gateway = []
  for (const s of samples) {
    if (!s.failed) clean.push(s)
    else if ((s.failed_statuses || []).every((status) => status === 0)) clientOnly.push(s)
    else gateway.push(s)
  }
  return { clean, clientOnly, gateway }
}

/** 单个指标的判定；返回 { status: pass|regressed|noisy_regressed, limit, spread }。 */
export function judge(metric, values, base, rule) {
  const value = median(values)
  // 相对 MAD（各轮与中位数之差的中位数 / 中位数）：单轮离群不会把整次测量判为不稳定
  const spread = value > 0 ? median(values.map((v) => Math.abs(v - value))) / value : 0
  const limit = Math.max(base * (1 + rule.margin), base + rule.slack[metric])
  if (value <= limit) return { value, limit, spread, status: 'pass' }
  return { value, limit, spread, status: spread > rule.noise_limit ? 'noisy_regressed' : 'regressed' }
}

/**
 * 基线树：固定提交的一份检出，和当前代码在同一个 job 里交替跑。
 * `run(...args)` 执行 git，返回 stdout；抛错表示该命令失败。
 * 返回 `{ dir }` 或 `{ skip: 原因 }`——退不出基线树时调用方降级为只告警，不能把机器差异当回归。
 */
export function prepareBaselineTree(commit, dir, { root, run, remote = 'origin' } = {}) {
  const git = (...args) => run('-C', root, ...args)
  const sha = String(commit || '').trim()
  if (!sha) return { skip: 'baseline.json has no baseline_commit' }
  if (git('rev-parse', 'HEAD').trim().startsWith(sha)) return { skip: `baseline commit ${sha.slice(0, 8)} is HEAD` }
  try {
    git('rev-parse', '-q', '--verify', `${sha}^{commit}`)
  } catch {
    try {
      git('fetch', '--no-tags', '--depth=1', remote, sha)
    } catch {
      return { skip: `baseline commit ${sha.slice(0, 8)} is not reachable from ${remote}` }
    }
  }
  try {
    // node_modules 由当前检出共用：依赖不同就没法共用，也不该把装依赖的差别算进测量
    git('diff', '--quiet', sha, 'HEAD', '--', 'package.json', 'package-lock.json')
  } catch {
    return { skip: `dependencies differ from baseline commit ${sha.slice(0, 8)}` }
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true })
    run('-C', root, 'worktree', 'prune')
    git('worktree', 'add', '--detach', dir, sha)
  } catch {
    return { skip: `could not check out baseline commit ${sha.slice(0, 8)}` }
  }
  // 基线树共用当前检出的依赖。worktree 自己没有 node_modules（靠 Node 往上找到主检出的），
  // 所以要像 Node 那样逐级向上解析真实目录：指向不存在的路径只会造出一个悬空链接，
  // 网关起不来才发现（2026-11-07 实测）。
  const modules = resolveNodeModules(root)
  if (!modules) {
    removeBaselineTree(dir, { root, run })
    return { skip: 'no node_modules to share with the baseline tree' }
  }
  fs.symlinkSync(modules, path.join(dir, 'node_modules'), 'dir')
  return { dir, sha }
}

/** 从 `from` 逐级向上找真实存在的 node_modules（Node 的解析规则），找不到返回 null。 */
export function resolveNodeModules(from) {
  let dir = path.resolve(from)
  for (;;) {
    const candidate = path.join(dir, 'node_modules')
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export function removeBaselineTree(dir, { root, run } = {}) {
  try {
    run('-C', root, 'worktree', 'remove', '--force', dir)
  } catch {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function annotate(level, message) {
  if (process.env.GITHUB_ACTIONS) console.log(`::${level}::${message.replace(/\n/g, '%0A')}`)
  else console.log(`[${level}] ${message}`)
}

/** 每个模式的轮次收口：网关错误算失败，客户端连接失败只排除。返回 { clean, failed }。 */
export function cleanRounds(mode, samples, { warn = annotate } = {}) {
  const rounds = splitRounds(samples)
  let clean = rounds.clean
  let failed = false
  if (rounds.gateway.length) {
    failed = true
    const statuses = [...new Set(rounds.gateway.flatMap((s) => s.failed_statuses))].join(',')
    warn('error', `perf ${mode}: ${rounds.gateway.length}/${samples.length} rounds got gateway errors (${statuses})`)
    clean = [...clean, ...rounds.gateway]
  }
  if (rounds.clientOnly.length) {
    warn(
      'warning',
      `perf ${mode}: ${rounds.clientOnly.length}/${samples.length} rounds had client-side connection failures; excluded`,
    )
  }
  if (clean.length * 2 <= samples.length) {
    failed = true
    warn('error', `perf ${mode}: ${samples.length - clean.length}/${samples.length} rounds excluded`)
    clean = samples
  }
  return { clean, failed }
}

/**
 * 同一次运行里当前代码与基线代码的比较。`current` / `base` 为 { mode: 轮次数组 }。
 * 返回 { rows, failed }：行是给 Job Summary 的表格，failed 为真表示判定回退。
 */
export function compareAgainstBaselineRun(current, base, modes, rule, { warn = annotate } = {}) {
  const rows = []
  let failed = false
  for (const mode of modes) {
    for (const metric of METRICS) {
      const values = current[mode].map((s) => s[metric])
      const baseValues = base[mode].map((s) => s[metric])
      const baseMedian = median(baseValues)
      const v = judge(metric, values, baseMedian, rule)
      const round = (x) => +x.toFixed(metric === 'p99' ? 1 : 3)
      rows.push([mode, metric, round(v.value), round(baseMedian), round(v.limit), v.status, +v.spread.toFixed(2)])
      if (v.status === 'regressed') {
        failed = true
        warn(
          'error',
          `perf ${mode} ${metric}: ${round(v.value)} vs baseline code ${round(baseMedian)} in the same run (limit ${round(v.limit)})`,
        )
      } else if (v.status === 'noisy_regressed') {
        warn(
          'warning',
          `perf ${mode} ${metric}: ${round(v.value)} vs baseline code ${round(baseMedian)} (limit ${round(v.limit)}) but relative MAD ${(v.spread * 100).toFixed(0)}% > ${rule.noise_limit * 100}%; warning only`,
        )
      }
    }
  }
  return { rows, failed }
}

/** 退路：与存档的同机器画像数字比较，只告警不失败。 */
export function compareAgainstStoredProfile(current, stored, modes, rule, reason, { warn = annotate } = {}) {
  const rows = []
  for (const mode of modes) {
    for (const metric of METRICS) {
      const values = current[mode].map((s) => s[metric])
      if (!stored?.[mode]) {
        rows.push([mode, metric, median(values), '-', '-', 'no_baseline', '-'])
        continue
      }
      const v = judge(metric, values, stored[mode][metric], rule)
      rows.push([
        mode,
        metric,
        +v.value.toFixed(3),
        stored[mode][metric],
        +v.limit.toFixed(3),
        v.status === 'pass' ? 'pass' : `${v.status} (warn only)`,
        +v.spread.toFixed(2),
      ])
      if (v.status !== 'pass') {
        warn(
          'warning',
          `perf ${mode} ${metric}: ${+v.value.toFixed(3)} over stored limit ${+v.limit.toFixed(3)}; stored numbers come from another run on another machine, warning only (${reason})`,
        )
      }
    }
  }
  warn('warning', `perf: no same-run baseline (${reason}); compared with stored numbers, warning only`)
  return { rows, failed: false }
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const file = JSON.parse(fs.readFileSync(opts.baseline, 'utf8'))
  const modes = opts.modes || Object.keys(file.modes)
  const profile = opts.profile || machineProfile()

  let tree = null
  if (opts.against) tree = { dir: opts.against, sha: 'given' }
  else if (!opts.write)
    tree = prepareBaselineTree(file.baseline_commit, path.join(os.tmpdir(), 'kin-perf-baseline'), {
      root: opts.root,
      run: git,
    })

  const samples = {
    current: Object.fromEntries(modes.map((m) => [m, []])),
    base: Object.fromEntries(modes.map((m) => [m, []])),
  }
  try {
    for (let r = 0; r < opts.rounds; r++) {
      for (const mode of modes) {
        // 交替顺序：机器在一轮里变慢时两边各吃一半
        const order = tree?.dir ? (r % 2 ? ['base', 'current'] : ['current', 'base']) : ['current']
        for (const side of order) {
          const root = side === 'base' ? tree.dir : opts.root
          const result = await runBench({ ...file.modes[mode], mode, root, cpuProf: '' })
          samples[side][mode].push(result)
          console.log(`round ${r + 1}/${opts.rounds} ${side} ${JSON.stringify(result)}`)
        }
      }
    }
  } finally {
    if (tree?.dir && !opts.against) removeBaselineTree(tree.dir, { root: opts.root, run: git })
  }

  const current = {}
  const base = {}
  const summary = {}
  let failed = false
  for (const mode of modes) {
    const cur = cleanRounds(mode, samples.current[mode])
    current[mode] = cur.clean
    failed = failed || cur.failed
    if (tree?.dir) {
      const b = cleanRounds(`${mode} (baseline code)`, samples.base[mode])
      base[mode] = b.clean
      failed = failed || b.failed
    }
    summary[mode] = { rounds: current[mode].length }
    for (const metric of [...METRICS, 'cpu_ms_per_req', 'p50']) {
      summary[mode][metric] = +median(current[mode].map((s) => s[metric])).toFixed(
        metric === 'p99' || metric === 'p50' ? 1 : 3,
      )
    }
  }

  if (opts.write) {
    if (failed) return 1
    file.profiles ||= {}
    file.profiles[profile] = { recorded_at: new Date().toISOString(), rounds: opts.rounds, ...summary }
    fs.writeFileSync(opts.baseline, `${JSON.stringify(file, null, 2)}\n`)
    console.log(`baseline written for ${profile}: ${JSON.stringify(summary)}`)
    return 0
  }

  const compared = tree?.dir
    ? compareAgainstBaselineRun(current, base, modes, file.rule)
    : compareAgainstStoredProfile(current, file.profiles?.[profile], modes, file.rule, tree?.skip || 'no baseline tree')
  failed = failed || compared.failed
  const against = tree?.dir
    ? `A/B vs ${opts.against ? opts.against : String(file.baseline_commit).slice(0, 8)} in this run`
    : `stored numbers, warning only — ${tree?.skip || 'no baseline tree'}`
  const table = [
    `### Perf gate (${profile}, ${opts.rounds} rounds, median; ${against})`,
    '',
    '| mode | metric | current | baseline | limit | status | spread |',
    '|---|---|---|---|---|---|---|',
    ...compared.rows.map((r) => `| ${r.join(' | ')} |`),
    '',
  ].join('\n')
  console.log(table)
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n`)
  return failed ? 1 : 0
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exitCode = await main()
