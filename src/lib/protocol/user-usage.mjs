/**
 * User protocol: GET /v1/usage.
 * Peek only — never bind/unbind sticky or bill tokens_in.
 */
import { makeError, mapUpstreamError, rewritePoolErrorForClient, ErrorType, ErrorCode } from '../core/errors.mjs'
import { canOfficialUsage, credentialModeOfVm } from '../oauth/credential-mode.mjs'
import { getUsageCache } from '../oauth/usage-cache.mjs'
import { probeAccount } from '../oauth/usage-probe.mjs'
import { isOfficialUsageRateLimited, shouldHopOfficialUsage } from '../oauth/crs-usage-probe.mjs'
import { listQuotaFromHeaders, publicUsageWindow, usageWindowsEmpty } from '../pool/quota-window.mjs'
import { ownerScopeFromRequest, vmMatchesOwnerScope } from '../admin/resource-owner.mjs'
import { keyAllowsVm, keyScopeFromRequest, keyAllowsModel, groupScopeDenial } from '../admin/key-scope.mjs'
import { getVm, listVms } from '../vm/vm-registry.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'
import { summarizeCodexSlot } from '../vm/codex-slot.mjs'
import { pickCodexSlots } from '../pool/codex-slot-pool.mjs'
import { detectInboundPlatform } from './platform-detect.mjs'
import { resolveInboundIdentity } from '../identity/identity-rewrite.mjs'
export function usageUnsupportedError() {
  return makeError({
    type: ErrorType.INVALID_REQUEST,
    code: ErrorCode.USAGE_UNSUPPORTED,
    message: '上游 usage 窗口只支持 OAuth / Setup Token 账户',
    status: 400,
  })
}

export function buildUsageView(listed = {}, source = 'extra') {
  return {
    unit: 'percent_used',
    five_hour: publicUsageWindow(
      listed['5h'] || {
        utilization: listed.utilization_5h,
        status: listed.status_5h,
        reset: listed.reset_5h,
      },
    ),
    seven_day: publicUsageWindow(
      listed['7d'] || {
        utilization: listed.utilization_7d,
        status: listed.status_7d,
        reset: listed.reset_7d,
      },
    ),
    source,
  }
}

export async function peekCurrentAccount({
  poolScheduler,
  stickyRouter,
  req,
  inbound = {},
  model,
  signal,
  usersRepo = null,
} = {}) {
  const detected = detectInboundPlatform(model)
  const platform = detected.ok ? detected.platform : undefined
  const identity = resolveInboundIdentity({ inbound, body: inbound, headers: req?.headers || {} })
  const stickyKey =
    (platform === 'anthropic' && identity.sessionId && stickyRouter?.sessionPoolKeys
      ? stickyRouter.sessionPoolKeys(req, inbound, {
          sessionId: identity.sessionId,
          deviceId: identity.deviceId,
          migrate: false,
        }).stickyKey
      : stickyRouter?.extractPoolKey?.(req, inbound, { platform })) || null
  if (!poolScheduler?.peekAccount) {
    return { ok: false, code: 'no_eligible_accounts' }
  }
  const keyScope = keyScopeFromRequest(req)
  if (!keyAllowsModel(keyScope, model)) return { ok: false, code: ErrorCode.KEY_GROUP_MISMATCH, group_type: '授权模型' }
  const poolDenial = groupScopeDenial(keyScope)
  if (poolDenial) return { ok: false, code: ErrorCode.GROUP_UNAVAILABLE, message: poolDenial.message }
  // Same gate as Messages: a platform-scoped key must not hop to the other platform's VMs.
  if (platform && keyScope.group_type !== 'all' && keyScope.group_type !== platform) {
    return { ok: false, code: ErrorCode.KEY_GROUP_MISMATCH, group_type: keyScope.group_type }
  }
  return poolScheduler.peekAccount({
    model,
    stickyKey,
    signal,
    ownerScope: ownerScopeFromRequest(req, usersRepo),
    keyScope,
  })
}

/** Same client contract as Messages: Fable gate 429, capacity 529 / pool-wide limit 429 with Retry-After, else 503. */
function sendPoolFail(res, json, peeked) {
  const code = peeked?.code || 'no_eligible_accounts'
  if (code === ErrorCode.KEY_GROUP_MISMATCH) {
    const err = makeError({
      type: ErrorType.PERMISSION,
      code,
      message: `此密钥仅可调用 ${peeked.group_type}`,
      status: 403,
    })
    return json(res, 403, err.body)
  }
  if (code === ErrorCode.GROUP_UNAVAILABLE) {
    const err = makeError({
      type: ErrorType.PERMISSION,
      code,
      message: peeked?.message || '账号池不可用',
      status: 403,
    })
    return json(res, 403, err.body)
  }
  if (code === ErrorCode.FABLE_REQUIRES_MAX) {
    const mapped = mapUpstreamError(429, { error: { code } })
    return json(res, mapped.status, mapped.body)
  }
  const mapped = rewritePoolErrorForClient(makeError({ type: ErrorType.OVERLOADED, code, message: code, status: 503 }))
  const retryMs = Number(peeked?.retry_after_ms)
  if (mapped.retryAfterSec || retryMs > 0) {
    const secs = retryMs > 0 ? Math.max(1, Math.ceil(retryMs / 1000)) : mapped.retryAfterSec
    res.setHeader?.('retry-after', String(secs))
  }
  return json(res, mapped.status, mapped.body)
}

export async function resolveUsageWindows({
  accountQuota,
  accountId,
  vmId,
  exec,
  vm,
  usageCache,
  probe = probeAccount,
} = {}) {
  const acc =
    accountQuota?.repo?.get?.(accountId) || accountQuota?.ensure?.({ account_id: accountId, vm_id: vmId }) || null
  let listed = listQuotaFromHeaders(acc?.unified || {})
  let source = 'extra'
  if (!usageWindowsEmpty(listed)) return { listed, source }
  if (!shouldHopOfficialUsage(acc?.unified, { hop: true })) return { listed, source }
  const cache = usageCache || getUsageCache()
  let result
  try {
    result = await cache.load(accountId, () => probe({ exec, vm, includeFable: false }))
  } catch {
    return { listed, source }
  }
  if (!result || isOfficialUsageRateLimited(result)) return { listed, source }
  try {
    accountQuota?.ingestOAuthUsage?.(accountId, result)
  } catch {}
  const next = accountQuota?.repo?.get?.(accountId) || acc
  listed = listQuotaFromHeaders(next?.unified || {})
  source = 'oauth-usage'
  return { listed, source }
}

const USAGE_PLATFORMS = {
  claude: 'anthropic',
  anthropic: 'anthropic',
  cc: 'anthropic',
  openai: 'openai',
  codex: 'openai',
  gpt: 'openai',
  cx: 'openai',
}

export function usagePlatformOf(req) {
  let raw = ''
  try {
    raw = new URL(req?.url || '/', 'http://localhost').searchParams.get('platform') || ''
  } catch {
    raw = ''
  }
  const key = raw.trim().toLowerCase()
  if (!key) return { ok: true, platform: null }
  const platform = USAGE_PLATFORMS[key]
  return platform ? { ok: true, platform } : { ok: false }
}

function usableUsageVm(vm, { ownerScope, keyScope }) {
  return !!vm?.id && vmMatchesOwnerScope(vm, ownerScope) && keyAllowsVm(keyScope, vm)
}

function codexUsageVm(projectRoot, scope) {
  if (!projectRoot) return null
  // Readiness reads summary fields (has_token, expires_at), same as the Codex hop.
  const summaries = listVms(projectRoot).filter((vm) => isCodexVm(vm) && usableUsageVm(vm, scope))
  const id = pickCodexSlots(summaries).ids?.[0]
  return id ? getVm(projectRoot, id) : null
}

/** The account the scheduler would pick next. Claude first, then Codex; `platform` narrows to one. */
export async function handleUserUsage(req, res, deps) {
  const json = (...args) => deps.json(...args)
  if (!deps.requireAuth(req, res)) return
  const wanted = usagePlatformOf(req)
  if (!wanted.ok) {
    const err = makeError({
      type: ErrorType.INVALID_REQUEST,
      code: 'invalid_platform',
      message: 'platform 只能是 claude 或 openai',
      param: 'platform',
      status: 400,
    })
    return json(res, err.status, err.body)
  }
  const keyScope = keyScopeFromRequest(req)
  const poolDenial = groupScopeDenial(keyScope)
  if (poolDenial) return sendPoolFail(res, json, { code: ErrorCode.GROUP_UNAVAILABLE, message: poolDenial.message })
  if (wanted.platform && keyScope.group_type !== 'all' && keyScope.group_type !== wanted.platform) {
    return sendPoolFail(res, json, { code: ErrorCode.KEY_GROUP_MISMATCH, group_type: keyScope.group_type })
  }
  const poolScheduler = typeof deps.getPoolScheduler === 'function' ? deps.getPoolScheduler() : deps.poolScheduler
  const projectRoot = deps.projectRoot || poolScheduler?.projectRoot || null

  let peeked = null
  if (wanted.platform !== 'openai') {
    peeked = await peekCurrentAccount({
      poolScheduler,
      stickyRouter: deps.stickyRouter,
      req,
      inbound: {},
      usersRepo: deps.apiKeyStore?.users || null,
    })
    if (peeked.ok && !isCodexVm(peeked.vm)) {
      if (!canOfficialUsage(credentialModeOfVm(peeked.vm))) {
        const err = usageUnsupportedError()
        return json(res, err.status, err.body)
      }
      const { listed, source } = await resolveUsageWindows({
        accountQuota: deps.accountQuota,
        accountId: peeked.accountId,
        vmId: peeked.vmId,
        exec: peeked.exec,
        vm: peeked.vm,
        usageCache: deps.usageCache,
        probe: deps.probeAccount,
      })
      return json(res, 200, { ...buildUsageView(listed, source), platform: 'anthropic' })
    }
  }
  if (wanted.platform !== 'anthropic') {
    const vm = codexUsageVm(projectRoot, {
      ownerScope: ownerScopeFromRequest(req, deps.apiKeyStore?.users || null),
      keyScope,
    })
    if (vm) {
      const quota = summarizeCodexSlot(projectRoot, vm).usage?.quota || {}
      return json(res, 200, { ...buildUsageView(quota, 'codex'), platform: 'openai' })
    }
  }
  return sendPoolFail(res, json, peeked && !peeked.ok ? peeked : { code: 'no_eligible_accounts' })
}
