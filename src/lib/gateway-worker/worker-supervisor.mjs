import { resolveDbPath } from '../db/database.mjs'
import { masterKeyFile } from '../executor/vault.mjs'
import { buildGatewayHeaders } from './gateway-auth.mjs'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

// 控制面托管同机 Gateway Worker（默认拓扑：一个 Node + 一个 Worker）。二进制存在时以子进程拉起
// kin-codex-gateway，环回明文 + HMAC 回连控制面；崩溃按指数退避重启，日志并入控制面输出；控制面关停时停止。
// 控制面重启或升级时 Worker 随之换成镜像内的新二进制，不需要单独的侧车或 systemd 单元。是否分流到
// Worker 由分组是否绑定 Gateway 账号决定，Worker 常驻不改变未绑定分组的 Codex VM 行为。
// KIN_CODEX_GATEWAY_SUPERVISE=0 表示 Worker 由外部管理（多 Worker、跨主机或 scripts/codex-gateway-start.sh）。
const RESTART_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000]
const STABLE_RUN_MS = 60_000
const STOP_GRACE_MS = 10_000
const RECONCILE_MS = 10_000
// 停止前排空的上限：与控制面停机排空 KIN_SHUTDOWN_DRAIN_TIMEOUT_MS 的默认值一致（120 秒）。Worker 到截止时间
// 取消仍在途的请求并写出回执，这里再多等一小段让回执写完，然后才 SIGTERM
const DRAIN_TIMEOUT_MS = 120_000
const DRAIN_SETTLE_MS = 5_000
const DRAIN_POLL_MS = 500

/** 向托管的 Worker 发一个签名请求（会话密钥，环回明文）；返回 { ok, status, data }。 */
function workerHttpRequest({ listen, key, method, path: target, body = null, timeoutMs = 5_000 }) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? '' : JSON.stringify(body)
    const url = new URL(target, `http://${listen}`)
    const headers = { accept: 'application/json', ...buildGatewayHeaders({ secret: key, body: payload }) }
    if (payload) headers['content-length'] = String(Buffer.byteLength(payload))
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method, headers, timeout: timeoutMs },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.once('end', () => {
          let data = null
          try {
            data = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')
          } catch {}
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode || 0, data })
        })
        res.once('error', reject)
      },
    )
    req.once('timeout', () => req.destroy(new Error('gateway worker request timeout')))
    req.once('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

export function gatewaySupervisionEnabled(env = process.env) {
  const value = String(env.KIN_CODEX_GATEWAY_SUPERVISE ?? '')
    .trim()
    .toLowerCase()
  return !['0', 'false', 'no', 'off'].includes(value)
}

function readVersion(root) {
  try {
    return fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim()
  } catch {
    return ''
  }
}

// 托管 Worker 可以继承的控制面环境变量（复审 P2-4）：
// - KIN_CODEX_GATEWAY_*（Worker 配置），但不含实例密钥的包裹密钥与引导令牌（引导令牌由 start() 按子进程生成）；
// - CODEX_CA_CERTIFICATE / SSL_CERT_FILE / SSL_CERT_DIR（自定义 CA）；
// - 代理：HTTP_PROXY / HTTPS_PROXY / NO_PROXY / ALL_PROXY（含小写）；
// - 进程基础：PATH、HOME、TZ、TMPDIR、LANG、LC_ALL、LC_CTYPE，Go 运行时 GODEBUG、GOMAXPROCS、GOMEMLIMIT、GOTRACEBACK；
// - Gateway 事实直读：KIN_CREDENTIAL_MASTER_KEY_FILE 原值传递（没有时由托管器补默认位置）；
//   TAPMODELS_DB_SECRET / KIN_DB_SECRET 只在事实直读开启时传（见 supervisedWorkerEnv）。
const WORKER_ENV_EXACT = new Set([
  'CODEX_CA_CERTIFICATE',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
  'PATH',
  'HOME',
  'TZ',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'GODEBUG',
  'GOMAXPROCS',
  'GOMEMLIMIT',
  'GOTRACEBACK',
  'KIN_CREDENTIAL_MASTER_KEY_FILE',
])
// 只在事实直读开启时传给 Worker 的数据库字段密钥
const WORKER_ENV_FACTS = ['TAPMODELS_DB_SECRET', 'KIN_DB_SECRET']
export function workerEnvAllowed(name) {
  return name.startsWith('KIN_CODEX_GATEWAY_') || WORKER_ENV_EXACT.has(name)
}

/** 托管 Worker 的环境：只补未显式设置的键，默认值与 scripts/codex-gateway-start.sh 相同。 */
export function supervisedWorkerEnv({ env = process.env, root, dataDir }) {
  const port = env.PORT || '8787'
  const listen = env.KIN_CODEX_GATEWAY_LISTEN || '127.0.0.1:8790'
  const factsDb = path.resolve(resolveDbPath({ dataDir, dbPath: env.KIN_DB_PATH }))
  const defaults = {
    KIN_CODEX_GATEWAY_LISTEN: listen,
    KIN_CODEX_GATEWAY_INSTANCE_ID: 'gw-01',
    KIN_CODEX_GATEWAY_ADVERTISE_URL: `http://${listen}`,
    KIN_CODEX_GATEWAY_DATA_DIR: path.join(dataDir, 'codex-gateway'),
    KIN_CODEX_GATEWAY_CONTROL_PLANE_URL: `http://127.0.0.1:${port}/internal/v1/gateway/workers/register`,
    KIN_CODEX_GATEWAY_VERSION: env.TAPMODELS_IMAGE_TAG || readVersion(root),
    // Gateway 事实直读（设计第 19 节）：同机 Worker 以只读方式读取控制面数据库与凭据库主密钥文件
    KIN_CODEX_GATEWAY_FACTS_DB: factsDb,
    KIN_CREDENTIAL_MASTER_KEY_FILE: masterKeyFile(env, { location: () => factsDb }),
  }
  // 只把 Worker 需要的变量传给子进程（中期技术债 M2 复审 P2-4）：控制面环境里的数据库字段密钥、管理员密码、
  // API Key 等一律不继承。白名单见 workerEnvAllowed 与 SETUP 第 3 节 A
  const out = {}
  for (const [key, value] of Object.entries(env)) if (value !== undefined && workerEnvAllowed(key)) out[key] = value
  for (const [key, value] of Object.entries(defaults)) if (!out[key] && value) out[key] = value
  // 数据库字段密钥只在事实直读开启时传（读取器要解密事实视图里的字段密文，这是事实直读的前提）；
  // KIN_CODEX_GATEWAY_FACTS=off 或没有 FACTS_DB 时不传
  const factsOn =
    !!out.KIN_CODEX_GATEWAY_FACTS_DB &&
    String(out.KIN_CODEX_GATEWAY_FACTS || '')
      .trim()
      .toLowerCase() !== 'off'
  if (factsOn) for (const name of WORKER_ENV_FACTS) if (env[name]) out[name] = env[name]
  return out
}

function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// 只清理确认为 kin-codex-gateway 的残留进程（控制面异常退出后遗留），避免误杀复用的 PID
function isGatewayProcess(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('kin-codex-gateway')
  } catch {
    return false
  }
}

// 当前进程里的托管器（注册接口据此识别同机托管的 Worker，终审 B2）
let activeSupervisor = null

/**
 * 同机托管 Worker 的会话密钥（2026-11-07 S4，取代实例密钥与引导）：托管器每次拉起子进程时生成 32 字节随机密钥，作为子进程的
 * 内部令牌（KIN_CODEX_GATEWAY_INTERNAL_TOKEN）传入，只保存在控制面内存与子进程环境里；双向 HMAC 签名都用它。子进程退出即作废。
 * 没有托管或没有在运行的子进程时返回 null（外部自启的 Worker 用共用令牌）。
 */
export function supervisedSession() {
  return activeSupervisor?.session?.() ?? null
}

export function createWorkerSupervisor({
  env = process.env,
  root,
  dataDir,
  spawnImpl = spawn,
  log = console,
  reconcileMs = RECONCILE_MS,
  now = () => Date.now(),
  // 停止前排空（审计 P2-11）：上限默认与控制面停机排空一致；workerRequest 发签名请求（测试注入）
  drainTimeoutMs = Number(env.KIN_SHUTDOWN_DRAIN_TIMEOUT_MS) || DRAIN_TIMEOUT_MS,
  drainPollMs = DRAIN_POLL_MS,
  workerRequest = workerHttpRequest,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const bin = env.KIN_CODEX_GATEWAY_BIN || path.join(root, 'bin', 'kin-codex-gateway')
  const pidFile = path.join(dataDir, 'codex-gateway.pid')
  const state = { status: 'idle', pid: null, started_at: null, restarts: 0, last_exit: null, binary: bin }
  let child = null
  let timer = null
  let failures = 0
  let nextStartAt = 0
  let stopping = false
  // 当前子进程的会话密钥：{ instanceId, key }；listen 是子进程的监听地址（排空请求用）
  let session = null
  let listen = ''
  // 进行中的停止（并发的 stop / restart 共用一次排空与退出）
  let stopping$ = null

  const setStatus = (status) => {
    state.status = status
  }

  function clearStale() {
    let pid = 0
    try {
      pid = Number(fs.readFileSync(pidFile, 'utf8').trim())
    } catch {
      return
    }
    if (pid > 0 && processAlive(pid) && isGatewayProcess(pid)) {
      try {
        process.kill(pid, 'SIGTERM')
        log.warn?.(`[codex-gateway] stopped a leftover Worker process ${pid}`)
      } catch {}
    }
    try {
      fs.rmSync(pidFile, { force: true })
    } catch {}
  }

  function start() {
    const workerEnv = supervisedWorkerEnv({ env, root, dataDir })
    if (!workerEnv.KIN_CODEX_GATEWAY_INTERNAL_TOKEN) {
      setStatus('missing_secret')
      return
    }
    // 子进程用会话密钥代替共用令牌（共用令牌留给外部自启的 Worker 与只读诊断脚本）
    const key = crypto.randomBytes(32).toString('hex')
    workerEnv.KIN_CODEX_GATEWAY_INTERNAL_TOKEN = key
    const workerData = workerEnv.KIN_CODEX_GATEWAY_DATA_DIR
    fs.mkdirSync(workerData, { recursive: true, mode: 0o700 })
    try {
      fs.chmodSync(workerData, 0o700)
    } catch {}
    clearStale()
    stopping = false
    const proc = spawnImpl(bin, [], { env: workerEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    child = proc
    session = { instanceId: workerEnv.KIN_CODEX_GATEWAY_INSTANCE_ID, key }
    listen = workerEnv.KIN_CODEX_GATEWAY_LISTEN
    state.pid = proc.pid || null
    state.started_at = new Date(now()).toISOString()
    setStatus('running')
    if (proc.pid) {
      try {
        fs.writeFileSync(pidFile, `${proc.pid}\n`, { mode: 0o600 })
      } catch {}
    }
    const forward = (stream, write) => {
      let buffer = ''
      stream?.setEncoding?.('utf8')
      stream?.on?.('data', (chunk) => {
        buffer += chunk
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''
        for (const line of lines) if (line.trim()) write(`[codex-gateway] ${line}`)
      })
    }
    forward(proc.stdout, (line) => log.log?.(line))
    forward(proc.stderr, (line) => log.error?.(line))
    const startedAt = now()
    proc.once('error', (error) => {
      log.error?.(`[codex-gateway] failed to start ${bin}: ${error.message}`)
    })
    proc.once('exit', (code, signal) => {
      if (child === proc) {
        child = null
        session = null
      }
      state.pid = null
      state.last_exit = { code, signal, at: new Date(now()).toISOString() }
      try {
        fs.rmSync(pidFile, { force: true })
      } catch {}
      if (stopping) {
        setStatus('stopped')
        return
      }
      // 稳定运行过一段时间的退出从最短退避重新计数
      failures = now() - startedAt >= STABLE_RUN_MS ? 1 : failures + 1
      state.restarts += 1
      const delay = RESTART_BACKOFF_MS[Math.min(failures, RESTART_BACKOFF_MS.length) - 1]
      nextStartAt = now() + delay
      setStatus('backoff')
      const retry = setTimeout(reconcile, delay)
      retry.unref?.()
      log.error?.(`[codex-gateway] Worker exited (code=${code}, signal=${signal}); restarting`)
    })
  }

  // 排空：让 Worker 停止接单并等在途请求结束（截止时间到时 Worker 取消剩余请求并写回执），最多 drainTimeoutMs + 收尾。
  // Worker 不可达或报错时直接返回（随后照常 SIGTERM，Worker 在停机宽限内为仍在途的流写回执）
  async function drain(proc, current) {
    if (!current || !listen || drainTimeoutMs <= 0) return
    const call = (method, target, body) =>
      workerRequest({ listen, key: current.key, method, path: target, body }).catch(() => null)
    const started = now()
    const result = await call('POST', '/internal/v1/drain', {
      deadline: new Date(started + drainTimeoutMs).toISOString(),
    })
    if (!result?.ok) return
    let state = result.data
    const limit = started + drainTimeoutMs + DRAIN_SETTLE_MS
    while (state && state.drain_state !== 'drained' && Number(state.active_concurrency) > 0) {
      if (now() >= limit || child !== proc) return
      await sleep(drainPollMs)
      const health = await call('GET', '/internal/v1/health')
      if (!health?.ok) return
      state = health.data
    }
  }

  // 停止当前子进程：先排空（drain）再 SIGTERM，宽限 STOP_GRACE_MS 后 SIGKILL；子进程退出后完成。
  function stop({ drainFirst = true } = {}) {
    if (stopping$) return stopping$
    if (!child) return Promise.resolve()
    const proc = child
    const current = session
    stopping = true
    stopping$ = (async () => {
      const exited = new Promise((resolve) => {
        if (proc.exitCode != null || proc.signalCode != null) resolve()
        else proc.once('exit', () => resolve())
      })
      if (drainFirst) {
        try {
          await drain(proc, current)
        } catch (error) {
          log.warn?.(`[codex-gateway] draining the Worker failed: ${error.message}`)
        }
      }
      try {
        proc.kill('SIGTERM')
      } catch {}
      const force = setTimeout(() => {
        try {
          if (proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL')
        } catch {}
      }, STOP_GRACE_MS)
      force.unref?.()
      await exited
      clearTimeout(force)
    })().finally(() => {
      stopping$ = null
    })
    return stopping$
  }

  function reconcile() {
    if (!gatewaySupervisionEnabled(env)) {
      setStatus('external')
      return
    }
    if (child) return
    if (!fs.existsSync(bin)) {
      setStatus('missing_binary')
      return
    }
    if (now() < nextStartAt) return
    start()
  }

  const api = {
    start() {
      reconcile()
      timer = setInterval(reconcile, reconcileMs)
      timer.unref?.()
    },
    reconcile,
    /** 控制面关停：停止定时器，先排空 Worker 再发送 SIGTERM（Worker 优雅退出）；子进程退出后完成。 */
    async stop() {
      if (timer) clearInterval(timer)
      timer = null
      await stop()
    },
    /**
     * 重启 Worker（恢复备份后：库与凭据已换，Worker 按新库重新加载账号、清掉旧的运行时状态）：先排空、停止，
     * 再立即拉起新进程（不走崩溃退避）。外部管理或缺少二进制时只做一次 reconcile。
     */
    async restart() {
      await stop()
      failures = 0
      nextStartAt = 0
      reconcile()
    },
    status() {
      return { ...state, supervised: gatewaySupervisionEnabled(env) }
    },
    /** 当前子进程的会话密钥（见 supervisedSession）。 */
    session() {
      return child && session ? { ...session } : null
    },
  }
  activeSupervisor = api
  return api
}
