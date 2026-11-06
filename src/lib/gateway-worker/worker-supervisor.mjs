import { resolveDbPath } from '../db/database.mjs'
import { masterKeyFile } from '../executor/vault.mjs'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
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
// - KIN_REDIS_URL / KIN_REDIS_PREFIX（共享运行态）；CODEX_CA_CERTIFICATE / SSL_CERT_FILE / SSL_CERT_DIR（自定义 CA）；
// - 代理：HTTP_PROXY / HTTPS_PROXY / NO_PROXY / ALL_PROXY（含小写）；
// - 进程基础：PATH、HOME、TZ、TMPDIR、LANG、LC_ALL、LC_CTYPE，Go 运行时 GODEBUG、GOMAXPROCS、GOMEMLIMIT、GOTRACEBACK；
// - Gateway 事实直读：KIN_CREDENTIAL_MASTER_KEY_FILE 原值传递（没有时由托管器补默认位置）；
//   TAPMODELS_DB_SECRET / KIN_DB_SECRET 只在事实直读开启时传（见 supervisedWorkerEnv）。
const WORKER_ENV_EXACT = new Set([
  'KIN_REDIS_URL',
  'KIN_REDIS_PREFIX',
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
const WORKER_ENV_DENIED = new Set(['KIN_CODEX_GATEWAY_INSTANCE_KEY_WRAP', 'KIN_CODEX_GATEWAY_BOOTSTRAP_TOKEN'])
export function workerEnvAllowed(name) {
  if (WORKER_ENV_DENIED.has(name)) return false
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
    KIN_CODEX_GATEWAY_RECEIPT_URL: `http://127.0.0.1:${port}/internal/v1/gateway/receipts`,
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
 * 同机托管 Worker 的一次性引导令牌（中期技术债 M2，审查 P0-1/P0-3）：托管器每次拉起子进程时生成随机令牌，经子进程环境
 * KIN_CODEX_GATEWAY_BOOTSTRAP_TOKEN 传入，控制面内存里只保存 SHA-256 摘要。注册请求出示的令牌与当前子进程的实例 ID、
 * 摘要都一致时返回引导授权；consume() 在签发事务内原子消耗，用过一次即作废。没有托管或没有拉起子进程时返回 null。
 */
export function supervisedBootstrap(instanceId, presented) {
  return activeSupervisor?.bootstrapAuthorization?.(instanceId, presented) ?? null
}

export function createWorkerSupervisor({
  env = process.env,
  root,
  dataDir,
  spawnImpl = spawn,
  log = console,
  reconcileMs = RECONCILE_MS,
  now = () => Date.now(),
} = {}) {
  const bin = env.KIN_CODEX_GATEWAY_BIN || path.join(root, 'bin', 'kin-codex-gateway')
  const pidFile = path.join(dataDir, 'codex-gateway.pid')
  const state = { status: 'idle', pid: null, started_at: null, restarts: 0, last_exit: null, binary: bin }
  let child = null
  let timer = null
  let failures = 0
  let nextStartAt = 0
  let stopping = false
  // 当前子进程的一次性引导令牌（只存摘要）：{ instanceId, digest, issuedKeyId }。issuedKeyId 为空表示还没用过
  let bootstrap = null
  const digest = (value) => crypto.createHash('sha256').update(String(value)).digest()

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
    const token = crypto.randomBytes(32).toString('hex')
    bootstrap = { instanceId: workerEnv.KIN_CODEX_GATEWAY_INSTANCE_ID, digest: digest(token), issuedKeyId: null }
    workerEnv.KIN_CODEX_GATEWAY_BOOTSTRAP_TOKEN = token
    const workerData = workerEnv.KIN_CODEX_GATEWAY_DATA_DIR
    fs.mkdirSync(workerData, { recursive: true, mode: 0o700 })
    try {
      fs.chmodSync(workerData, 0o700)
    } catch {}
    clearStale()
    stopping = false
    const proc = spawnImpl(bin, [], { env: workerEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    child = proc
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
        bootstrap = null
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

  function stop() {
    if (!child) return
    const proc = child
    stopping = true
    try {
      proc.kill('SIGTERM')
    } catch {}
    const force = setTimeout(() => {
      try {
        if (proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL')
      } catch {}
    }, STOP_GRACE_MS)
    force.unref?.()
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
    /** 控制面关停：停止定时器并向 Worker 发送 SIGTERM（Worker 优雅退出）。 */
    stop() {
      if (timer) clearInterval(timer)
      timer = null
      stop()
    },
    status() {
      return { ...state, supervised: gatewaySupervisionEnabled(env) }
    },
    /** 当前子进程的一次性引导授权（见 supervisedBootstrap）。 */
    bootstrapAuthorization(instanceId, presented) {
      const current = bootstrap
      if (!current || !child || current.instanceId !== instanceId || !presented) return null
      const given = digest(presented)
      if (!crypto.timingSafeEqual(given, current.digest)) return null
      return {
        kind: 'supervisor',
        // 签发事务内判断（复审 P1-2）：没用过可以引导；用过时只有它签发的那把密钥仍有效（且未确认，事务已先排除
        // 已确认的密钥）时才能重新引导——Worker 没收到响应或落盘失败后用同一令牌重试
        allowed(liveKeyIds) {
          if (bootstrap !== current) return false
          return !current.issuedKeyId || liveKeyIds.includes(current.issuedKeyId)
        },
        // 事务提交后才记下已用（以及签发的密钥）
        commit(keyId) {
          if (bootstrap === current) current.issuedKeyId = keyId
        },
      }
    },
  }
  activeSupervisor = api
  return api
}
