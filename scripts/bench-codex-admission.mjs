#!/usr/bin/env node
/**
 * #737 复现：本机 Codex 选槽并发压测（进程内，无内核、无网络）。
 *
 *   node scripts/bench-codex-admission.mjs [requests=2000] [concurrency=50] [slots=21] [hopMs=200] [perSlot=2]
 *
 * 在临时项目目录写入 `slots` 个 Codex 槽（约三分之一处于 5h/7d 额度限制，与生产常见形态一致），
 * 以 `concurrency` 个并发客户端调用真实的 handleCodexProtocol；上游 hop 用假的流式内核替代：
 * 在 `hopMs` 内分 10 帧回放 Responses SSE，并带回 x-codex-* 额度头（真实路径会据此写回槽文件）。
 *
 * 报告：请求延迟分位、选槽（入场）延迟分位、主线程事件循环延迟（monitorEventLoopDelay）、
 * ELU，以及每请求的槽文件系统调用次数（readFileSync / statSync / readdirSync / 写入）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'

const [nArg = '2000', cArg = '50', sArg = '21', hopArg = '200', perSlotArg = '2'] = process.argv.slice(2)
const N = Number(nArg)
const C = Number(cArg)
const SLOTS = Number(sArg)
const HOP_MS = Number(hopArg)
const PER_SLOT = Number(perSlotArg)

// 计数必须在业务模块加载前装上：业务代码通过默认导出对象调用 fs.*Sync。
const counts = { readFileSync: 0, statSync: 0, readdirSync: 0, existsSync: 0, writeFileSync: 0, renameSync: 0 }
for (const name of Object.keys(counts)) {
  const orig = fs[name]
  fs[name] = function counted(...args) {
    if (String(args[0] || '').includes(`${path.sep}vms`)) counts[name]++
    return orig.apply(this, args)
  }
}

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const { handleCodexProtocol } = await import(path.join(repo, 'src/lib/protocol/handle-codex.mjs'))
const { openDatabase, closeDatabase } = await import(path.join(repo, 'src/lib/db/database.mjs'))

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-bench-codex-'))
const vmDir = path.join(root, 'vms')
fs.mkdirSync(vmDir, { recursive: true })
const resetSoon = new Date(Date.now() + 3 * 3600_000).toISOString()
for (let i = 0; i < SLOTS; i++) {
  const id = `vm-gpt-${String(i).padStart(2, '0')}`
  fs.mkdirSync(path.join(vmDir, id), { recursive: true })
  const extra =
    i % 3 === 0
      ? { codex_7d_used_percent: 100, codex_7d_reset_at: resetSoon, codex_7d_window_minutes: 10080 }
      : { codex_5h_used_percent: 10 + i, codex_5h_window_minutes: 300, codex_7d_used_percent: 20 + i }
  fs.writeFileSync(
    path.join(vmDir, `${id}.json`),
    JSON.stringify({
      id,
      name: id,
      platform: 'openai',
      family: 'codex',
      schedulable: true,
      status: 'running',
      has_token: true,
      policy: { maxConcurrency: PER_SLOT, concurrencyOverride: true },
      codex: { extra },
    }),
  )
  fs.writeFileSync(
    path.join(vmDir, id, 'codex-credentials.json'),
    JSON.stringify({
      accounts: [{ id: `${id}-acc`, access_token: 'at', refresh_token: 'rt', chatgpt_account_id: id }],
    }),
  )
}

openDatabase({ dbPath: ':memory:' })

const routing = {
  pool: { fallback_wait_timeout_ms: 60_000 },
  codex: { quota: { limit_5h: 0.9, limit_7d: 1 } },
  failover: { total_retry_deadline_ms: 120_000 },
}

const frames = [
  { type: 'response.created', response: { id: 'resp_bench', status: 'in_progress' } },
  ...Array.from({ length: 8 }, (_, i) => ({ type: 'response.output_text.delta', delta: `tok${i} ` })),
  {
    type: 'response.completed',
    response: {
      id: 'resp_bench',
      status: 'completed',
      model: 'gpt-5.5',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
      usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
    },
  },
]

const ops = {
  writeCodexKernelConfig() {},
  ensureCodexKernel: async () => ({ ok: true, reused: true }),
  streamCodexKernel: async ({ onEvent, exec }) => {
    for (const frame of frames) {
      await sleep(HOP_MS / frames.length)
      await onEvent(`data: ${JSON.stringify(frame)}`)
      await onEvent('')
    }
    const n = Number(exec.vmId.slice(-2))
    return {
      ok: true,
      status: 200,
      terminalState: 'verified',
      committed: true,
      usage: { input_tokens: 12, output_tokens: 8 },
      headers: {
        'x-codex-primary-used-percent': String(10 + n),
        'x-codex-primary-window-minutes': '300',
        'x-codex-secondary-used-percent': String(20 + n),
        'x-codex-secondary-window-minutes': '10080',
      },
    }
  },
}

const admissions = []
async function one(seq) {
  const req = Object.assign(new EventEmitter(), {
    headers: { 'user-agent': 'codex_cli_rs/0.150.0' },
    apiKeyKind: 'master',
    socket: { remoteAddress: '127.0.0.1' },
  })
  const res = Object.assign(new EventEmitter(), {
    headersSent: false,
    statusCode: 0,
    write() {
      return true
    },
    end() {},
  })
  let admittedAt = null
  const t0 = performance.now()
  const timed = {
    ...ops,
    ensureCodexKernel: async (...args) => {
      admittedAt ??= performance.now()
      return ops.ensureCodexKernel(...args)
    },
  }
  let status = 0
  await handleCodexProtocol({
    req,
    res,
    protocol: 'openai.responses',
    ctx: { path: '/v1/responses', body: { model: 'gpt-5.5', input: `hi ${seq}`, stream: true } },
    inbound: { stream: true },
    logBag: {},
    stats: { errors: 0, requests: 0, by_route: {} },
    json: (_res, s, body) => {
      status = s
      return body
    },
    writeSSEHeaders(r) {
      r.headersSent = true
      status = 200
    },
    routing,
    projectRoot: root,
    ops: timed,
  })
  if (admittedAt != null) admissions.push(admittedAt - t0)
  return { ms: performance.now() - t0, status }
}

async function run(n) {
  const out = []
  let i = 0
  await Promise.all(
    Array.from({ length: C }, async () => {
      while (i < n) {
        const seq = i++
        out.push(await one(seq))
      }
    }),
  )
  return out
}

const q = (sorted, p) => +sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))].toFixed(1)
try {
  await run(Math.min(200, N)) // 预热
  admissions.length = 0
  for (const key of Object.keys(counts)) counts[key] = 0
  const loop = monitorEventLoopDelay({ resolution: 5 })
  loop.enable()
  const elu0 = performance.eventLoopUtilization()
  const cpu0 = process.cpuUsage()
  const t0 = performance.now()
  const res = await run(N)
  const wall = (performance.now() - t0) / 1000
  const cpu = process.cpuUsage(cpu0)
  const elu = performance.eventLoopUtilization(elu0)
  loop.disable()
  const lat = res.map((r) => r.ms).sort((a, b) => a - b)
  const adm = admissions.slice().sort((a, b) => a - b)
  const bad = res.filter((r) => r.status !== 200)
  console.log(
    JSON.stringify({
      N,
      C,
      slots: SLOTS,
      hop_ms: HOP_MS,
      per_slot: PER_SLOT,
      ok: res.length - bad.length,
      failed: bad.length,
      rps: +(N / wall).toFixed(1),
      p50: q(lat, 0.5),
      p99: q(lat, 0.99),
      max: +lat.at(-1).toFixed(1),
      admit_p50: q(adm, 0.5),
      admit_p99: q(adm, 0.99),
      cpu_ms_per_req: +((cpu.user + cpu.system) / 1000 / N).toFixed(3),
      elu: +elu.utilization.toFixed(3),
      loop_delay_p99_ms: +(loop.percentile(99) / 1e6).toFixed(1),
      loop_delay_max_ms: +(loop.max / 1e6).toFixed(1),
      vm_fs_per_req: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, +(v / N).toFixed(1)])),
    }),
  )
} finally {
  await closeDatabase()
  fs.rmSync(root, { recursive: true, force: true })
}
