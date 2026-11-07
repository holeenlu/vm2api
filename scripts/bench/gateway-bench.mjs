#!/usr/bin/env node
// 网关本机压测：用 test/harness.mjs 起一个真实网关进程，上游是进程内 Anthropic 假上游
// （KIN_CRS_MOCK=1，不起 CLI、不连外网、不需要任何凭据），按固定速率（开环）压 /v1/messages。
//
//   node scripts/bench/gateway-bench.mjs [--mode tiny|long] [--rate 60] [--seconds 10]
//                                        [--warmup 3] [--root .] [--cpu-prof dir]
//
// 模式：
//   tiny  单条 "hi" 消息：测路由、鉴权、调度、记账这条固定开销。
//   long  多个会话各自追加轮次的长对话（约 100–160 条消息、300–500KB）：
//         覆盖缓存前缀比较与哈希、token 估算、协议转换等随正文增长的主线程开销。
//
// 延迟按“计划发出时刻”计（开环，不受协调遗漏影响）。输出一行 JSON：
// 延迟分位、成功数、网关子进程 CPU、主线程 ELU 均值与最大值。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export function parseArgs(argv) {
  const out = { mode: 'tiny', rate: 60, seconds: 10, warmup: 3, root: path.resolve(HERE, '../..'), cpuProf: '' }
  for (let i = 0; i < argv.length; i++) {
    const [k, v] = [argv[i], argv[i + 1]]
    if (k === '--mode') out.mode = v
    else if (k === '--rate') out.rate = Number(v)
    else if (k === '--seconds') out.seconds = Number(v)
    else if (k === '--warmup') out.warmup = Number(v)
    else if (k === '--root') out.root = path.resolve(v)
    else if (k === '--cpu-prof') out.cpuProf = path.resolve(v)
    else continue
    i++
  }
  if (!['tiny', 'long'].includes(out.mode)) throw new Error(`unknown --mode ${out.mode}`)
  return out
}

const filler = (n, seed) => {
  let s = ''
  while (s.length < n) s += `// ${seed}:${s.length} const value = compute(input, options) ?? fallback\n`
  return s.slice(0, n)
}

/** 第 i 条历史消息：assistant 调工具、user 回工具结果，内容按下标确定，同一会话逐轮只追加。 */
function historyMessage(session, i) {
  if (i === 0) return { role: 'user', content: [{ type: 'text', text: `session ${session}: ${filler(600, 'task')}` }] }
  if (i % 2 === 1) {
    return {
      role: 'assistant',
      content: [
        { type: 'text', text: filler(240, `${session}a${i}`) },
        { type: 'tool_use', id: `toolu_${session}_${i}`, name: 'Read', input: { file_path: `/repo/src/f${i}.mjs` } },
      ],
    }
  }
  return {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: `toolu_${session}_${i - 1}`, content: filler(2800, `${session}r${i}`) },
    ],
  }
}

const TOOLS = Array.from({ length: 16 }, (_, i) => ({
  name: `tool_${i}`,
  description: filler(600, `tool${i}`),
  input_schema: { type: 'object', properties: { path: { type: 'string', description: filler(120, `p${i}`) } } },
}))
const SYSTEM = [{ type: 'text', text: filler(8000, 'system'), cache_control: { type: 'ephemeral' } }]
const LONG_SESSIONS = 8
const LONG_MIN = 101
const LONG_MAX = 161

export function makeRequests(mode) {
  if (mode === 'tiny') {
    const body = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8,
      messages: [{ role: 'user', content: 'hi' }],
    })
    return () => ({ body, headers: {} })
  }
  const turns = new Array(LONG_SESSIONS).fill(LONG_MIN)
  let next = 0
  return () => {
    const s = next++ % LONG_SESSIONS
    const n = turns[s]
    turns[s] = n + 2 > LONG_MAX ? LONG_MIN : n + 2
    const messages = Array.from({ length: n }, (_, i) => historyMessage(s, i))
    const last = messages[n - 1]
    messages[n - 1] = {
      ...last,
      content: last.content.map((b, j) =>
        j === last.content.length - 1 ? { ...b, cache_control: { type: 'ephemeral' } } : b,
      ),
    }
    return {
      body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 64, system: SYSTEM, tools: TOOLS, messages }),
      headers: { 'x-claude-code-session-id': `bench-session-${s}` },
    }
  }
}

function quantile(sorted, p) {
  if (!sorted.length) return null
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
}

function childCpuSeconds(pid) {
  const t = execFileSync('ps', ['-o', 'time=', '-p', String(pid)])
    .toString()
    .trim()
  // ps time: [[dd-]hh:]mm:ss(.cc)
  const parts = t.replace(/^\d+-/, '').split(':').map(Number)
  return parts.reduce((acc, v) => acc * 60 + v, 0)
}

export async function runBench(opts) {
  const { startGateway } = await import(pathToFileURL(path.join(opts.root, 'test/harness.mjs')).href)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-bench-'))
  const eluFile = path.join(tmp, 'elu.txt')
  const nodeOptions = [`--import=${pathToFileURL(path.join(HERE, 'elu-hook.mjs')).href}`]
  if (opts.cpuProf) nodeOptions.push('--cpu-prof', `--cpu-prof-dir=${opts.cpuProf}`)
  const gw = await startGateway({
    mockText: 'pong',
    readyMs: 30000,
    env: {
      NODE_OPTIONS: nodeOptions.join(' '),
      KIN_BENCH_ELU_FILE: eluFile,
      KIN_RATE_CAP: '100000000',
      KIN_RATE_REFILL: '10000000',
    },
  })
  const next = makeRequests(opts.mode)
  const url = `${gw.baseUrl}/v1/messages`
  const auth = { authorization: `Bearer ${gw.apiKey}`, 'content-type': 'application/json' }

  async function phase(seconds, record) {
    const total = Math.max(1, Math.round(seconds * opts.rate))
    const interval = 1000 / opts.rate
    const start = performance.now()
    const results = []
    const pending = []
    for (let i = 0; i < total; i++) {
      const due = start + i * interval
      const wait = due - performance.now()
      if (wait > 1) await new Promise((r) => setTimeout(r, wait))
      const req = next()
      pending.push(
        fetch(url, { method: 'POST', headers: { ...auth, ...req.headers }, body: req.body })
          .then(async (r) => {
            await r.text()
            return { ms: performance.now() - due, status: r.status }
          })
          .catch(() => ({ ms: performance.now() - due, status: 0 }))
          .then((r) => record && results.push(r)),
      )
    }
    await Promise.all(pending)
    return { results, wall: (performance.now() - start) / 1000 }
  }

  try {
    if (opts.warmup > 0) await phase(opts.warmup, false)
    fs.writeFileSync(eluFile, '')
    const cpu0 = childCpuSeconds(gw.child.pid)
    const { results, wall } = await phase(opts.seconds, true)
    const cpu1 = childCpuSeconds(gw.child.pid)
    const lat = results.map((r) => r.ms).sort((a, b) => a - b)
    const bad = results.filter((r) => r.status !== 200)
    const elu = fs
      .readFileSync(eluFile, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => Number(l.split(' ')[1]))
    const round = (v, d = 1) => (v == null ? null : +v.toFixed(d))
    return {
      mode: opts.mode,
      rate: opts.rate,
      requests: results.length,
      ok: results.length - bad.length,
      failed: bad.length,
      failed_statuses: [...new Set(bad.map((b) => b.status))],
      achieved_rps: round(results.length / wall),
      p50: round(quantile(lat, 0.5)),
      p90: round(quantile(lat, 0.9)),
      p99: round(quantile(lat, 0.99)),
      max: round(lat.at(-1)),
      cpu_ms_per_req: round(((cpu1 - cpu0) * 1000) / (results.length || 1), 3),
      elu_mean: round(elu.reduce((a, b) => a + b, 0) / (elu.length || 1), 3),
      elu_max: round(Math.max(0, ...elu), 3),
    }
  } finally {
    if (opts.cpuProf && gw.child.exitCode == null) {
      // --cpu-prof 只在正常退出时写出：先 SIGTERM，等网关优雅停机
      gw.child.kill('SIGTERM')
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 20000)
        gw.child.once('exit', () => {
          clearTimeout(t)
          resolve()
        })
      })
    }
    await gw.stop()
    fs.rmSync(tmp, { recursive: true, force: true })
    fs.rmSync(gw.project, { recursive: true, force: true })
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const result = await runBench(parseArgs(process.argv.slice(2)))
  console.log(JSON.stringify(result))
}
