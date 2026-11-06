/**
 * Codex kernel stderr on disk (#684). The kernel used to start with `stdio: 'ignore'`,
 * so its own account of a refusal or a crash was lost. Each slot's kernel now appends
 * stderr to `<data>/logs/codex-kernel/<vmId>.log`.
 *
 * The kernel is detached and may outlive this process, so it gets the file descriptor
 * itself (no pipe through the control plane that would break on restart). Size is
 * bounded by copy-truncate: once a file passes KERNEL_LOG_MAX_BYTES it is copied to
 * `<vmId>.log.1` (replacing the previous one) and truncated in place; the kernel's
 * O_APPEND descriptor keeps writing at the new end. At most two files per slot.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const KERNEL_LOG_MAX_BYTES = 4 * 1024 * 1024
export const KERNEL_LOG_CHECK_MS = 60_000

// Same default as core/config.mjs `paths.data` (src/data) when KIN_DATA_DIR is unset.
const DEFAULT_DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data')

const tracked = new Set()
let timer = null

export function codexKernelLogDir(env = process.env) {
  return env.KIN_CODEX_KERNEL_LOG_DIR || path.join(env.KIN_DATA_DIR || DEFAULT_DATA_DIR, 'logs', 'codex-kernel')
}

export function codexKernelLogPath(vmId, env = process.env) {
  const safe = String(vmId || '').replace(/[^A-Za-z0-9_-]/g, '_')
  return safe ? path.join(codexKernelLogDir(env), `${safe}.log`) : null
}

/** Copy-truncate `file` when it is over `maxBytes`. Returns true when it rotated. */
export function rotateKernelLog(file, { maxBytes = KERNEL_LOG_MAX_BYTES } = {}) {
  let size
  try {
    size = fs.statSync(file).size
  } catch {
    return false
  }
  if (size <= maxBytes) return false
  try {
    fs.copyFileSync(file, `${file}.1`)
    fs.chmodSync(`${file}.1`, 0o600)
    fs.truncateSync(file, 0)
    return true
  } catch (error) {
    console.warn(`[codex-kernel] log rotate failed ${path.basename(file)}: ${error?.message || error}`)
    return false
  }
}

/** Rotate every log a kernel of this process writes to. */
export function trimCodexKernelLogs({ maxBytes = KERNEL_LOG_MAX_BYTES } = {}) {
  for (const file of tracked) rotateKernelLog(file, { maxBytes })
}

function watchLogs() {
  if (timer) return
  timer = setInterval(() => trimCodexKernelLogs(), KERNEL_LOG_CHECK_MS)
  timer.unref?.()
}

/**
 * Append-mode descriptor for a kernel's stderr, or 'ignore' when the log cannot be
 * opened (a full or read-only disk must not stop the kernel from starting). The
 * caller passes it to spawn and closes its own copy afterwards.
 */
export function openCodexKernelLog(vmId, { maxBytes = KERNEL_LOG_MAX_BYTES, env = process.env } = {}) {
  const file = codexKernelLogPath(vmId, env)
  if (!file) return 'ignore'
  let fd = null
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    rotateKernelLog(file, { maxBytes })
    fd = fs.openSync(file, 'a', 0o600)
    fs.writeSync(fd, `--- ${new Date().toISOString()} kin-codex-kernel start ${vmId}\n`)
    tracked.add(file)
    watchLogs()
    return fd
  } catch (error) {
    // 打开之后写入失败（磁盘满等）：关闭已打开的描述符，不泄漏（M4 复审 P2-6）
    if (typeof fd === 'number') closeCodexKernelLogFd(fd)
    console.warn(`[codex-kernel] stderr log unavailable for ${vmId}: ${error?.message || error}`)
    return 'ignore'
  }
}

/**
 * 控制面重启后复用仍在运行的内核（detached）：它继续写原来的日志文件，这里把文件登记进轮转检查，
 * 否则这份日志不再受大小上限约束（M4 复审 P2-6）。
 */
export function trackCodexKernelLog(vmId, { env = process.env } = {}) {
  const file = codexKernelLogPath(vmId, env)
  if (!file || !fs.existsSync(file)) return false
  tracked.add(file)
  watchLogs()
  return true
}

export function closeCodexKernelLogFd(fd) {
  if (typeof fd !== 'number') return
  try {
    fs.closeSync(fd)
  } catch {}
}

/** Tests: stop the size check and forget tracked files. */
export function resetCodexKernelLogs() {
  if (timer) clearInterval(timer)
  timer = null
  tracked.clear()
}
