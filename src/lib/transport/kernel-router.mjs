/**
 * Request-level inference hop router.
 * 公开仓只走 rust cli-hop（kernel → Claude Code）。Go HTTP 转发不再启用。
 * Credential import/ensure 仍可走 Go 客户端，但不参与推理 hop。
 */
import { clientCancelledResult, isClientCancelledResult } from '../core/errors.mjs'
import { ensureWorkerCredential } from './go-worker-client.mjs'
import { ensureOfficialCredentialLink, slotUidGidFromHomeDir } from '../oauth/oauth-credentials.mjs'
import { slotHost } from '../vm/slot-host.mjs'
import path from 'node:path'
import { checkCragLicense, cragLicenseDeniedResult } from '../vm/crag-license.mjs'
import {
  streamRustKernel,
  callRustKernel,
  rustKernelHealth,
  rustKernelReachable,
  rustKernelBusy,
  isNeedsRefreshResult,
  kernelFaults,
} from './rust-kernel-client.mjs'
import {
  kernelBinPath,
  awaitWrapRecycle,
  noteWrapHop,
  beginWrapHop,
  endWrapHop,
  wrapHopInflight,
} from './rust-kernel-supervisor.mjs'

const rustHealthCache = new Map()
// 上游 401 触发的强制换票按槽限频（审计 P1-C1）：被吊销的账号不能让每个请求都去换一次票（刷新风暴、
// 烧掉授权）；冷却期内只做普通检查（令牌临期才刷新），401 交给 failover 冷却换号。
const FORCED_REFRESH_COOLDOWN_MS = 5 * 60_000
const lastForcedRefresh = new Map()

function claimForcedRefresh(exec, now = Date.now()) {
  const key = String(exec?.homeDir || exec?.vmId || exec?.vm?.id || '')
  if (!key) return true
  const last = lastForcedRefresh.get(key) || 0
  if (now - last < FORCED_REFRESH_COOLDOWN_MS) return false
  lastForcedRefresh.set(key, now)
  if (lastForcedRefresh.size > 4096) {
    for (const [k, at] of lastForcedRefresh) if (now - at >= FORCED_REFRESH_COOLDOWN_MS) lastForcedRefresh.delete(k)
  }
  return true
}

// 只有请求确实没送到内核时才隐式重发（审计 P1-R1）：写入后首字节超时、连接被重置都可能已在上游生成，
// 重发会重复消耗额度且第一次不计量，交给 failover 按 sendState 判定。
const UNDELIVERED_TRANSPORT_CODES = new Set(['ECONNREFUSED', 'ENOENT', 'EACCES'])
function transportResendSafe(result) {
  if (result?.sendState === 'not_sent') return true
  return UNDELIVERED_TRANSPORT_CODES.has(String(result?.body?.error?.code || ''))
}

/** 测试用：清空强制换票的限频记录。 */
export function resetForcedRefreshCooldown() {
  lastForcedRefresh.clear()
}
const DEFAULT_SLOT_WAIT_MS = 30_000
const DEFAULT_SLOT_POLL_MS = 200

export function rustHealthTtlMs(routing = {}) {
  const raw = routing?.inference?.health_ttl_ms
  if (raw == null || raw === '') return 2000
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return 2000
  return n
}

export function rustSlotWaitMs(routing = {}) {
  const raw = routing?.inference?.slot_wait_ms
  if (raw == null || raw === '') return DEFAULT_SLOT_WAIT_MS
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_SLOT_WAIT_MS
  return n
}

/** Hop slot poll uses leftover wait-plan budget; never stacks a second independent 30s. */
export function resolveHopSlotWaitMs({ remainingBudgetMs, routing } = {}) {
  const configuredRaw = routing?.inference?.slot_wait_ms
  const hasConfigured = configuredRaw != null && configuredRaw !== ''
  const configured = hasConfigured ? rustSlotWaitMs(routing) : null
  const budget = Number(remainingBudgetMs)
  const hasBudget = remainingBudgetMs != null && remainingBudgetMs !== '' && Number.isFinite(budget)
  if (hasBudget) {
    if (budget <= 0) return 0
    if (configured != null) return Math.min(budget, configured)
    return budget
  }
  return rustSlotWaitMs(routing)
}

export function rustShouldWaitForSlot(health, inflight = 0) {
  return rustKernelBusy(health) || Number(inflight) > 0
}

export async function waitForReadySlot(exec, timeoutMs = DEFAULT_SLOT_WAIT_MS, pollMs = DEFAULT_SLOT_POLL_MS) {
  const parsed = Number(timeoutMs)
  const waitMs = Number.isFinite(parsed) ? Math.max(0, parsed) : DEFAULT_SLOT_WAIT_MS
  const deadline = Date.now() + waitMs
  const gap = Math.max(40, Number(pollMs) || DEFAULT_SLOT_POLL_MS)
  let last = await rustKernelHealth(exec, { timeoutMs: 400 })
  if (rustKernelReachable(last)) return { ok: true, reason: 'already_up', health: last }
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, gap))
    last = await rustKernelHealth(exec, { timeoutMs: 400 })
    if (rustKernelReachable(last)) return { ok: true, reason: 'slot_ready', health: last }
  }
  return { ok: false, reason: 'slot_busy', health: last, error: 'rust kernel has no free slot' }
}

export function clearRustHealthCache(vmId = null) {
  if (vmId) rustHealthCache.delete(String(vmId))
  else rustHealthCache.clear()
}

function cacheKey(exec) {
  return String(exec?.vmId || exec?.vm?.id || '')
}

export function rememberRustHealth(exec, ready) {
  const key = cacheKey(exec)
  if (!key || !ready?.ok) return
  rustHealthCache.set(key, { at: Date.now(), health: ready.health || null })
}

export function peekRustHealth(exec, ttlMs, now = Date.now()) {
  if (ttlMs <= 0) return null
  const key = cacheKey(exec)
  if (!key) return null
  const hit = rustHealthCache.get(key)
  if (!hit) return null
  if (now - hit.at > ttlMs) return null
  return hit
}

export function resolveHopEngine(vm, _routing = {}, { rustReady = null, binPath = null } = {}) {
  const wanted = 'rust'
  // A baked slot image carries its own kernel; the host binary only matters for local mounts.
  const bin = slotHost(vm).bakedKernel ? 'image' : binPath != null ? String(binPath).trim() : kernelBinPath()
  if (rustReady === true) {
    return { engine: 'rust', wanted, reason: 'configured_rust', fallback: false }
  }
  if (rustReady === false || !bin) {
    return {
      engine: 'rust',
      wanted,
      reason: rustReady === false ? 'rust_unhealthy' : 'bin_missing',
      fallback: false,
      blocked: true,
    }
  }
  return { engine: 'rust', wanted, reason: 'configured_rust', fallback: false }
}

function rustUnavailableResult(ready) {
  // Both mean "try another VM": the kernel answered and said so.
  const answered = ready?.reason === 'slot_busy' || ready?.reason === 'kernel_unavailable'
  return {
    ok: false,
    status: answered ? 503 : 0,
    via: 'rust-kernel',
    engine: 'rust',
    body: {
      type: 'error',
      error: {
        type: 'worker_error',
        code: ready?.reason || 'rust_unavailable',
        message: ready?.error || 'rust kernel is not available',
      },
    },
    headers: {},
    terminalState: answered ? 'rejected' : 'transport_error',
    transportError: !answered,
  }
}

function credentialEnsureFailure(result, ensured) {
  const rawError = ensured?.error
  const error = rawError && typeof rawError === 'object' ? rawError : {}
  const blob = `${error.code || ''} ${error.message || ''} ${typeof rawError === 'string' ? rawError : ''}`
  const fatal = /invalid_grant|oauth_revoked|token has been revoked|refresh_token_missing/i.test(blob)
  const revoked = /token has been revoked|oauth_revoked/i.test(blob)
  return {
    ...result,
    ok: false,
    status: fatal ? 401 : Number(ensured?.status) || result.status,
    committed: fatal ? false : result.committed,
    terminalState: fatal ? 'rejected' : result.terminalState,
    body: {
      type: 'error',
      error: {
        type: fatal ? 'authentication_error' : error.type || 'worker_error',
        code: fatal
          ? revoked
            ? 'oauth_revoked'
            : error.code || 'invalid_grant'
          : error.code || 'credential_refresh_failed',
        message: fatal
          ? revoked
            ? 'OAuth access token has been revoked'
            : 'OAuth credential was rejected'
          : String(error.message || rawError || 'credential ensure failed').slice(0, 300),
      },
    },
    credential_ensure_failed: true,
  }
}

async function prepareSlotCredentials(exec) {
  if (!exec?.homeDir) return
  const ids = slotUidGidFromHomeDir(exec.homeDir)
  ensureOfficialCredentialLink(exec.homeDir, ids || {})
}

async function prepareRust(exec, { ensure, routing, slotWaitMs } = {}) {
  await awaitWrapRecycle(exec)
  const fault = kernelFaults.get(cacheKey(exec))
  if (fault) return { ok: false, reason: 'kernel_unavailable', error: fault }
  if (typeof ensure === 'function') return ensure(exec)
  await prepareSlotCredentials(exec)
  const ttl = rustHealthTtlMs(routing)
  const cached = peekRustHealth(exec, ttl)
  if (cached && rustKernelReachable(cached.health)) {
    return { ok: true, reason: 'health_cache', health: cached.health }
  }
  const health = await rustKernelHealth(exec, { timeoutMs: 800 })
  if (rustKernelReachable(health)) {
    const ready = { ok: true, reason: 'already_up', health }
    rememberRustHealth(exec, ready)
    return ready
  }
  // The kernel spent its own CLI restarts, or the watchdog spent its container
  // restarts. Only the watchdog restarts it, bounded; a request must not.
  if (health?.healthy === false) {
    return {
      ok: false,
      reason: 'kernel_unavailable',
      error: health?.unhealthy_reason || 'rust kernel unhealthy',
    }
  }
  if (rustShouldWaitForSlot(health, wrapHopInflight(exec))) {
    const waited = await waitForReadySlot(exec, resolveHopSlotWaitMs({ remainingBudgetMs: slotWaitMs, routing }))
    if (waited?.ok) {
      rememberRustHealth(exec, waited)
      return waited
    }
    return waited
  }
  clearRustHealthCache(cacheKey(exec))
  return { ok: false, reason: 'kernel_unavailable', error: 'rust kernel is down; watchdog recovery pending' }
}

async function runHop({ mode, opts }) {
  const routing = opts.routing || {}
  const projectRoot = opts.exec?.projectRoot || (opts.exec?.homeDir ? path.resolve(opts.exec.homeDir, '../../..') : '')
  const licensed = checkCragLicense(projectRoot, opts.exec?.vm, routing)
  if (!licensed.ok) return cragLicenseDeniedResult(licensed)
  const decision = resolveHopEngine(opts.exec?.vm, routing)
  let engine = 'rust'
  let reason = decision.reason
  if (!decision.blocked) {
    const ready = await prepareRust(opts.exec, {
      ensure: opts.ensureRust,
      routing,
      slotWaitMs: opts.slotWaitMs,
    })
    if (ready?.ok) {
      if (opts.requestContext && opts.cliHop && ready.health?.classifier_request_context !== true) {
        return {
          ok: false,
          status: 400,
          terminalState: 'rejected',
          upstreamExecutions: 0,
          body: {
            type: 'error',
            error: {
              type: 'invalid_request_error',
              code: 'classifier_runtime_unsupported',
              message: 'The kernel/CLI runtime does not support classifier request context.',
            },
          },
        }
      }
      reason = ready.reason || 'configured_rust'
    } else {
      return {
        ...rustUnavailableResult(ready),
        wanted_engine: 'rust',
        engine_reason: ready?.reason || 'rust_unavailable',
      }
    }
  } else {
    return {
      ...rustUnavailableResult({ reason: decision.reason }),
      wanted_engine: 'rust',
      engine_reason: decision.reason,
    }
  }
  const send = mode === 'stream' ? streamRustKernel : callRustKernel
  const onSendState = opts.onSendState
  beginWrapHop(opts.exec)
  let result
  try {
    result = await send({ ...opts, onSendState })
    noteWrapHop(opts.exec)
    if (opts.signal?.aborted || isClientCancelledResult(result)) {
      result = clientCancelledResult(result)
    } else if (result.transportError === true && result.committed !== true && transportResendSafe(result)) {
      result = await send({ ...opts, onSendState })
      result = { ...result, rust_transport_retried: true }
      noteWrapHop(opts.exec)
    }
    if (!isClientCancelledResult(result) && isNeedsRefreshResult(result)) {
      const ensure = opts.ensureCredential || ensureWorkerCredential
      // kernel 明确报 needs_refresh（本地判定临期）照常强制；上游拒票引起的强制换票按槽限频
      const explicit = String(result?.body?.error?.code || result?.error?.code || '') === 'needs_refresh'
      const force = explicit || claimForcedRefresh(opts.exec)
      const ensured = await ensure(opts.exec, { force })
      if (ensured?.ok !== true) result = credentialEnsureFailure(result, ensured)
      else if (!force && ensured?.refreshed !== true) {
        // 冷却期内且令牌未临期：不重发，原样交回 401 由 failover 处理
        result = { ...result, forced_refresh_suppressed: true }
      } else {
        // The CLI invalidates its OAuth cache from the shared credential file
        // before creating each API client. Recycling here kills sibling hops.
        result = await send({ ...opts, onSendState })
        result = { ...result, credential_retried: true }
        noteWrapHop(opts.exec)
      }
    }
    return {
      ...result,
      engine,
      wanted_engine: decision.wanted,
      engine_reason: reason,
    }
  } finally {
    endWrapHop(opts.exec)
    // Inference failures only invalidate health. The watchdog owns container
    // recovery, so concurrent requests cannot bypass its restart budget.
    if (result?.transportError || result?.body?.error?.code === 'kernel_unavailable') {
      clearRustHealthCache(cacheKey(opts.exec))
    }
  }
}

export function dispatchStreamInference(opts = {}) {
  return runHop({ mode: 'stream', opts })
}

export function dispatchCallInference(opts = {}) {
  return runHop({ mode: 'call', opts })
}
