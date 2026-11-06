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

// X25519 私钥（32 字节原始值）的 PKCS#8 DER 前缀
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex')

/**
 * 托管 Worker 的实例标识与托管公钥：直接读本机数据目录里的 custody-key.json 推出公钥（base64url）。
 * 控制面自己拉起的同机 Worker 不需要管理员带外核对（终审 B2）；读不到时返回 null。
 */
export function localCustodyIdentity({ env = process.env, root, dataDir }) {
  const workerEnv = supervisedWorkerEnv({ env, root, dataDir })
  try {
    const file = JSON.parse(
      fs.readFileSync(path.join(workerEnv.KIN_CODEX_GATEWAY_DATA_DIR, 'custody-key.json'), 'utf8'),
    )
    const raw = Buffer.from(String(file.private_key || ''), 'base64url')
    if (raw.length !== 32) return null
    const privateKey = crypto.createPrivateKey({
      key: Buffer.concat([X25519_PKCS8_PREFIX, raw]),
      format: 'der',
      type: 'pkcs8',
    })
    return {
      instanceId: workerEnv.KIN_CODEX_GATEWAY_INSTANCE_ID,
      publicKey: crypto.createPublicKey(privateKey).export({ format: 'jwk' }).x,
    }
  } catch {
    return null
  }
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
    KIN_CODEX_GATEWAY_REQUIRE_MTLS: '0',
    KIN_CODEX_GATEWAY_VERSION: env.TAPMODELS_IMAGE_TAG || readVersion(root),
    // Gateway 事实直读（设计第 19 节）：同机 Worker 以只读方式读取控制面数据库与凭据库主密钥文件
    KIN_CODEX_GATEWAY_FACTS_DB: factsDb,
    KIN_CREDENTIAL_MASTER_KEY_FILE: masterKeyFile(env, { location: () => factsDb }),
  }
  const out = { ...env }
  for (const [key, value] of Object.entries(defaults)) if (!out[key] && value) out[key] = value
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

/** 同机托管 Worker 的实例标识与托管公钥（没有托管器或未托管时为 null）。 */
export function supervisedCustodyIdentity() {
  return activeSupervisor?.localCustodyIdentity?.() ?? null
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
      if (child === proc) child = null
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
    /** 托管中的同机 Worker 的实例标识与托管公钥（未托管时为 null）。 */
    localCustodyIdentity() {
      return gatewaySupervisionEnabled(env) ? localCustodyIdentity({ env, root, dataDir }) : null
    },
  }
  activeSupervisor = api
  return api
}
