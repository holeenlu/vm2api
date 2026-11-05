import { filterAccountRows } from '../../shared/vendor-account-filters.mjs'
import { wakeOpenAIWaiter } from '../pool/openai-account-runtime.mjs'
import { listGlobalPricing, createGlobalPricing } from '../vendor/vendor-pricing.mjs'
import { withTransaction } from '../db/database.mjs'
import { maybeDecrypt, maybeEncrypt } from '../db/secure.mjs'
import { createPanelApiKeyRoutes } from './panel-api-key-routes.mjs'
import { createPanelApiEndpointRoutes } from './panel-api-endpoint-routes.mjs'
import { createPanelBackupRoutes } from './panel-backup-routes.mjs'
import { siteBranding, saveSiteBranding } from './site-branding.mjs'
import { ownProfile, profileView, updateOwnProfile, changeOwnPassword } from './panel-profile.mjs'
import { projectPanelUsage, projectUsage } from './usage-projection.mjs'
import { createPanelVmBulkRoutes } from './panel-vm-bulk-routes.mjs'
import { createRelayHandler } from './relay-routes.mjs'
import { GroupsRepo } from '../db/repos/groups-repo.mjs'
import { relayError, audit } from './relay-common.mjs'
/**
 * /admin and /api/panel routes. Login / logout / me and { ok, data }
 * envelopes are unchanged; slot start/reload go through startSlotReady.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { resolveVendorAccountName } from '../vendor/vendor-account-name.mjs'
import {
  verifyPanelLogin,
  createPanelSession,
  extractPanelToken,
  panelSessionCookie,
  panelCookieSecure,
  clearPanelSessionCookie,
  revokePanelSession,
  revokePanelSessionsForUser,
  getPanelAdmin,
} from '../core/security.mjs'
import { loadDistillRules, saveDistillRules, validateDistillPatch } from '../core/distill-detect.mjs'
import { applyRefusalGuardPatch, refusalGuardPolicy } from '../core/refusal-guard.mjs'
import {
  applyJevPatch,
  buildScopeInventory,
  listPolicyModels as listDecisionModels,
  publicJevConfig,
  publicJevKeys,
  readJevConfig,
} from '../protocol/jev-intercept.mjs'
import { JevUsageRepo } from '../db/repos/jev-usage-repo.mjs'
import { RefusalGuardsRepo } from '../db/repos/refusal-guards-repo.mjs'
import { RefusalDeviceBlocksRepo } from '../db/repos/refusal-device-blocks-repo.mjs'
import { SettingsRepo } from '../db/repos/settings-repo.mjs'
import {
  DEFAULT_ACCOUNT_ERROR_PROTECTION,
  compileAccountErrorProtection,
  normalizeAccountErrorProtection,
  validateAccountErrorProtection,
  clearProtectionState,
} from '../pool/account-error-protection.mjs'
import { parseCodexImportPayload, upsertCodexAccount, readCodexAccounts } from '../vm/codex-slot.mjs'
import { generateAuthUrl, exchangeAuthCode, normalizeOauthFlavor } from '../oauth/oauth-auth-url.mjs'
import { sessionKeyToOAuth, panelImportErrorPayload } from '../oauth/cookie-auth.mjs'
import { enrichOauthIdentity } from '../oauth/oauth-identity.mjs'
import { refreshAccountProfile } from '../oauth/account-profile.mjs'
import { generateCodexAuthUrl, exchangeCodexAuthCode } from '../oauth/codex-oauth.mjs'
import { makeProxyFetch } from '../protocol/codex-models.mjs'
import {
  completeClaudeSetupToken,
  readSetupTokenSession,
  looksLikeOfficialSetupToken,
  pastedAccessTokenToOauth,
  SETUP_TOKEN_FLAVOR,
} from '../oauth/claude-setup-token.mjs'
import {
  completeClaudeAuthLogin,
  readAuthLoginSession,
  startClaudeAuthLoginSession,
  AUTH_LOGIN_FLAVOR,
  AUTH_LOGIN_SOURCE,
} from '../oauth/claude-auth-login.mjs'
import {
  canOfficialCc,
  isApiKeyMode,
  isOfficialSetupTokenMode,
  isSetupTokenMode,
  looksLikeConsoleApiKey,
  credentialModeOfVm,
  liveOauthToSetupToken,
} from '../oauth/credential-mode.mjs'
import { persistSlotAuthScheme, readWorkerCredentialFile } from '../oauth/oauth-credentials.mjs'
import {
  isSub2apiAccountExport,
  sub2apiAccountToOauth,
  oauthToSub2apiExport,
  parseCredentialEdit,
} from '../oauth/sub2api-account.mjs'
import { officialCcHome, readOfficialCcStatus, scheduleOfficialCcBootstrap } from '../oauth/official-cc-bootstrap.mjs'
import { invalidateLiveCredentialCache } from './panel-live-credentials.mjs'
import { ensureCodexKernel, stopCodexKernel } from '../transport/codex-kernel-supervisor.mjs'
import { listOfficialModels, seedModelCatalog } from '../protocol/models.mjs'
import { jevUsageStorageErrors } from '../protocol/jev-usage.mjs'
import { getModelPolicy, saveModelPolicy, resetModelPolicy, listPolicyModels } from '../protocol/model-policy.mjs'
import {
  getGptModelPolicy,
  listGptPolicyModels,
  listImageToolModels,
  saveGptModelPolicy,
  resetGptModelPolicy,
} from '../protocol/gpt-model-policy.mjs'
import { refreshCodexAccessToken } from '../protocol/codex-models.mjs'
import { defaultSeedPolicy, isTelemetryEnabled, seedTelemetryContract } from '../protocol/seed-policy.mjs'

import { runVmTestChat, resolveTestModels, syncCodexCatalog } from './vm-test-chat.mjs'
import { VmTestScheduleError } from './vm-test-schedule.mjs'
import { readCatalogSync, syncClaudeCatalog, syncGptCatalog } from './catalog-monitor.mjs'
import { setPriceOverride, listPriceOverrides, syncModelsDev } from './price-catalog.mjs'
import { buildPricing } from './pricing-view.mjs'
import { createGatewayWorkerRoutes } from '../gateway-worker/gateway-routes.mjs'
import { GatewayWorkerService } from '../gateway-worker/gateway-execution.mjs'
import { GatewayAccountManagement } from '../gateway-worker/account-management.mjs'
import {
  CLIENT_PROFILE_SETTING,
  PRIVACY_POLICY_SETTING,
  readClientProfileSetting,
  readPrivacyPolicySetting,
  validateClientProfileSelection,
  validatePrivacyPolicy,
  validateProfileDeployment,
} from '../gateway-worker/codex-client-profile.mjs'
import {
  DEFAULT_REQUEST_LOCATION,
  REQUEST_LOCATION_SETTING,
  normalizeRequestLocation,
  readRequestLocationSetting,
} from '../gateway-worker/request-location.mjs'

import { runAnthropicConsole } from './anthropic-console.mjs'
import { mePayload, panelIdentity } from './panel-acl.mjs'
import { authorizePanelRoute } from './capability-policy.mjs'
import { createPanelRouteContext } from './route-context.mjs'
import { createPanelUserRoutes } from './panel-user-routes.mjs'
import { createPanelVmReadRoutes } from './panel-vm-read-routes.mjs'
import { createPanelVmCommandRoutes } from './panel-vm-command-routes.mjs'
import { createPanelVmLifecycleRoutes } from './panel-vm-lifecycle-routes.mjs'
import { createPanelVmDiagnoseRoutes } from './panel-vm-diagnose-routes.mjs'
import { createPanelVmProbeRoutes } from './panel-vm-probe-routes.mjs'
import { createPanelVmQuotaRoutes } from './panel-vm-quota-routes.mjs'
import { createPanelVmTestRoutes } from './panel-vm-test-routes.mjs'
import { createPanelVmCredentialRoutes } from './panel-vm-credential-routes.mjs'
import { createPanelVmRuntimeRoutes } from './panel-vm-runtime-routes.mjs'
import { createPanelVmOauthQueryRoutes } from './panel-vm-oauth-query-routes.mjs'
import { createPanelVmOauthMutationRoutes } from './panel-vm-oauth-mutation-routes.mjs'
import { createPanelVmSeedRoutes } from './panel-vm-seed-routes.mjs'
import { createPanelVmPackageRoutes } from './panel-vm-package-routes.mjs'
import { createPanelVmResetRoutes } from './panel-vm-reset-routes.mjs'
import { createPanelVmMaintenanceRoutes } from './panel-vm-maintenance-routes.mjs'
import { createPanelVmProvisionRoutes } from './panel-vm-provision-routes.mjs'
import { createPanelVmImportRoutes } from './panel-vm-import-routes.mjs'
import { VM_ORIGIN, canBindProxyToVm, filterVmsForPanel, normalizeOwnerId } from './resource-owner.mjs'
import { servePoolSeatStream } from './pool-seat-stream.mjs'
import { logsToCsv, logsToJsonl } from './request-log.mjs'
import {
  listVms,
  getVm,
  summarizeVm,
  getActiveVmId,
  setActiveVm,
  clearActiveVm,
  setScheduleOff,
  setScheduleHold,
  markUnschedulable,
  clearUnschedulable,
  clearScheduleHold,
  isMaintenanceHold,
  holdSchedulableSlots,
  resumeSchedulableSlots,
  waitForSlotDrain,
  KERNEL_UPDATE_HOLD,
  markKernelRestartPending,
  clearKernelRestartPending,
  bindVmProxy,
  adoptVmProxyBinding,
  patchVmRecord,
  vmHasClaudeCredential,
  vmHasSchedulableCredential,
  persistAllowedModels,
  persistSlotEnginePolicy,
  persistVmActiveHours,
  persistVmScheduleLevel,
  persistVmTimezone,
} from '../vm/vm-registry.mjs'
import {
  HOLD_MAINTENANCE,
  HOLD_PROXY,
  applyScheduleOff,
  applyUnschedulable,
  migrateScheduleRecord,
} from '../pool/schedule-state.mjs'
import { fillVmTimezoneFromExit, syncVmTimezoneFromProxy } from '../vm/proxy-timezone.mjs'
import { validTimezone } from '../core/timezone.mjs'
import { stampVmKind, isCodexVm, normalizeVmKind } from '../vm/vm-kind.mjs'
import { parseAllowedModelsPatch } from '../pool/slot-model-gate.mjs'
import { parseScheduleLevelInput, manualScheduleLevelOf } from '../pool/credential-weight.mjs'
import { parseActiveHoursInput } from '../pool/active-hours.mjs'
import { parseVmQuotaOverride } from '../pool/vm-quota-override.mjs'
import { validateOpenAIQuotaPatch, normalizeOpenAIQuotaPolicy } from '../pool/openai-quota-policy.mjs'
import { normalizeCodexRouting, validateInferenceWebsocketPatch } from '../protocol/codex-route.mjs'
import { queryOpenaiQuota } from '../oauth/openai-quota.mjs'
import {
  normalizeInferenceConfig,
  normalizeSessionSlots,
  parseKernelDataplanePatch,
  parseSlotEnginePolicyPatch,
  parseSlotPolicyTargets,
  resolveInferenceEngine,
  resolveKernelDataplane,
  SESSION_SLOT_MAX,
  SESSION_SLOT_MIN,
  validateInferenceRoutingPatch,
} from '../vm/slot-engine.mjs'
import { validateTelemetryRoutingPatch } from '../vm/native-telemetry.mjs'
import { makeError, ErrorType, ErrorCode } from '../core/errors.mjs'
import * as panel from './panel-api.mjs'
import { GATEWAY_CAPABILITIES } from '../vm/execution-context.mjs'
import { withVmLock, atomicWriteJson, isValidVmId, invalidateVmSlotReadCache } from '../vm/vm-file.mjs'
import { snapshotDatabaseMetrics } from '../db/database-metrics.mjs'
import { runtimeMetrics } from '../core/runtime-metrics.mjs'
import { getUsageCache } from '../oauth/usage-cache.mjs'
import { getDb, getDbPath } from '../db/database.mjs'
import { usagePoolEnabled, usageRead } from '../db/sqlite-pool.mjs'
import { UsageLogsView } from '../db/repos/usage-logs-view.mjs'
import {
  readLocalVersion,
  loadChangelog,
  buildUpdateStatus,
  readHostUpgradeStatus,
  startHostUpgrade,
} from './release.mjs'
import { downloadReleaseKernel, kernelReleaseHttpStatus } from './release-kernel.mjs'
import { clearActiveVmFromDb, removeVmFromDb } from '../vm/vm-db-sync.mjs'
import { normalizeCredentialMode } from '../oauth/credential-mode.mjs'
import { oauthCredentialState, oauthCredentialView, oauthVmPaths } from '../oauth/oauth-route-context.mjs'
import { accountPortalRows } from '../vendor/vendor-portal-view.mjs'
import { createSharedSnapshot } from '../vendor/shared-snapshot.mjs'
import { deriveScheduleFields } from '../pool/schedule-state.mjs'
import { VendorError, VendorPlatform, vendorProxyAddress, rejectInlinePricing } from '../vendor/vendor-platform.mjs'
import { projectResource } from './project-resource.mjs'
import {
  adminVendorIdentity,
  adminVendors,
  adminResources,
  updateAdminVendor,
  vendorIds,
  listSettlements,
} from '../vendor/vendor-admin.mjs'
import { createUsageQueryService } from '../vendor/queries/usage-query-service.mjs'
import { createSettlementQueryService } from '../vendor/queries/settlement-query-service.mjs'
import { createSettlementCommandService } from '../vendor/commands/settlement-command-service.mjs'
import { createAccountCommandService } from '../vendor/commands/account-command-service.mjs'
import { createAccountQueryService } from '../vendor/queries/account-query-service.mjs'
import { createProxyCommandService } from '../vendor/commands/proxy-command-service.mjs'
import { parseSocks5Line } from '../vm/proxy-pool.mjs'
import { reloadActiveVm } from '../core/config.mjs'
import { OS_CATALOG, kernelForIndex, normalizeTimezone, newVmNaming, STANDARD_LOCALE } from '../vm/vm-runtime.mjs'
import {
  startSlotReady,
  reloadSlotReady,
  stopSlot,
  destroySlot,
  switchSlotInferenceEngine,
  switchInheritedInferenceEngines,
  slotExec,
} from '../vm/slot-runtime.mjs'
import { buildNewVmRecord } from '../vm/vm-create-config.mjs'
import { recreateVmFiles, seedFreshCliHome } from '../vm/vm-recreate.mjs'
import { diagnoseSlotServices, powerOnSlot, recoverSlot } from '../vm/slot-recovery.mjs'
import { commitVmPackage, exportVmPackage, parseVmPackage } from '../vm/vm-package.mjs'
import { preflightNode } from '../cluster/placement.mjs'
import { probeLocalKvm } from '../vm/kvm-host.mjs'
import { normalizeVmConfig, resolveMachineSpec, validateVmConfigPatch } from '../vm/machine-spec.mjs'
import { raiseDockerSlotMemory } from '../vm/docker-slot-memory.mjs'
import { RUNTIME_KVM } from '../vm/runtime-kind.mjs'
import { hostProxyUrlForVm, slotHost } from '../vm/slot-host.mjs'
import { syncIpv6ProxyEgress } from '../vm/proxy-policy-runtime.mjs'
import { proxyBlockedReason } from '../vm/proxy-policy.mjs'
import { writeSlotSeedFiles } from '../vm/slot-seed.mjs'
import {
  egressEnabled,
  ensureProxyEgress,
  stopProxyEgress,
  hasBoundExit,
  isLocalEgressId,
  isLocalEgressProxy,
  localEgressIdForNode,
  boundProxyUrl,
  dnsUpstreamChain,
} from '../vm/egress.mjs'
import { collectSlotIdentity } from '../vm/guest-identity.mjs'
import { applyOfficialFingerprintToVm, reconcileOfficialFingerprints } from '../identity/official-fingerprint.mjs'
import { personaPreviewVars } from '../identity/crs-persona.mjs'
import { canonicalPersonaCompat } from '../identity/persona-template.mjs'
import { buildOutboundProfile } from './outbound-profile.mjs'
import {
  applyGeneratedFingerprint,
  SLOT_LOCALES,
  takenFingerprintKeys,
  writeGuestMachineIdFile,
} from '../identity/workstation-fingerprint.mjs'
import { assignComputerFingerprint } from '../identity/slot-computer.mjs'
import { runFleetUpdate, fleetStatus } from '../vm/fleet-update.mjs'
import {
  captureWrapSample,
  describeWrapSample,
  makeWrapSample,
  materializeSlotDataplane,
  materializeWrapCli,
  replaceCragKernelBinary,
  replaceKernelBinary,
  replaceCliNodeBinary,
  replaceCcNodeBinary,
  inspectKernelChanges,
  syncWrapSample,
  wrapCliHomeDir,
} from '../vm/wrap-cli-runtime.mjs'
import { inspectClusterPayloadChanges, refreshClusterSlotPayloads } from '../cluster/remote-slot.mjs'
import { readRawBody as defaultReadRawBody } from '../http/respond.mjs'
import { corsHeadersForRequest } from '../http/cors.mjs'
import { restartRustKernel, syncClaudeKernelConfigs, writeKernelConfig } from '../transport/rust-kernel-supervisor.mjs'

import { rustKernelHealth, toPublicKernelHealth } from '../transport/rust-kernel-client.mjs'
import { applyNativeTelemetry } from '../vm/fleet-update.mjs'
import { codexKernelHealth } from '../transport/codex-kernel-client.mjs'
import { normalizeHealthProbeConfig } from './health-probe.mjs'
import { normalizeUsageProbeConfig } from '../oauth/usage-probe-monitor.mjs'
import { mergeNotifyConfig, publicNotifyConfig, publicRoutingNotify, sendNotifyTest } from './notify.mjs'
import { notificationStatus, notificationTestConfig } from './ops/notification-command.mjs'
import {
  applyOnboardingAction,
  buildOnboardingPayload,
  loadOnboardingState,
  onboardingRoleOf,
  onboardingUserOf,
  recordOf,
  saveOnboardingState,
  setOnboardingProfile,
  vmStepFacts,
} from './onboarding.mjs'
import { applyUsageProfile } from './usage-profile.mjs'
import {
  StatisticsRepo,
  USER_ROLE_DIMENSIONS,
  normalizeDimension,
  normalizeRange,
} from '../db/repos/statistics-repo.mjs'

/**
 * An upstream credential failure must remain a panel error. Returning the
 * upstream 401 directly would make the web client clear its own panel session
 * and redirect to login because panelFetch treats every panel 401 as session
 * expiry.
 */
function upstreamFetchStatus(error) {
  const status = Number(error?.status)
  if (status === 401) return 502
  return status >= 400 && status < 600 ? status : 400
}

/** Tenants always see their own rows; other roles may narrow by `user_id`. */
function logsOwner(req, u) {
  if (panelIdentity(req).role === 'admin') {
    if (u.searchParams.get('scope') === 'mine') return { type: 'panel_key_creator', creatorId: req.panelUserId }
    const requested = u.searchParams.get('user_id') || null
    const managed = new Set(req.panelManagedUserIds || [])
    const userId = requested ? (managed.has(requested) ? requested : '__none__') : req.panelUserId
    return requested
      ? { type: 'panel_users', userId, scopeRootId: req.panelScopeRootId }
      : { type: 'panel_admin_scope', adminId: req.panelUserId, scopeRootId: req.panelScopeRootId }
  }
  return panelIdentity(req).role === 'user' ? req.panelUserId : u.searchParams.get('user_id') || null
}

const LOCAL_PROXY_MISMATCH_MESSAGE = '本地代理只能绑定到它所在 VPS 上的槽位'

function clusterNodesOf(ctx) {
  try {
    const list = ctx.clusterManager?.list?.()
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

function collectOnboardingFacts(req, ctx) {
  const ident = panelIdentity(req)
  if (ident.role === 'admin')
    return {
      hasFirstRequest: ctx.requestLog.hasSuccessfulRequest({
        owner_user_id: logsOwner(req, new URL(req.url, 'http://x')),
      }),
    }
  const ownerUserId = ident.role === 'user' ? req.panelUserId : null
  const vms = listVms(ctx.cfg.paths.project, ctx.routingConfig)
  const snap = ctx.proxyPool.panelSnapshot({
    role: ident.role,
    ownerUserId: ident.role === 'user' ? req.panelUserId : undefined,
    vms,
    nodes: clusterNodesOf(ctx),
  })
  const visible = filterVmsForPanel(vms, { role: ident.role, userId: ownerUserId })
  const keys = ctx.apiKeyStore.snapshot().keys || []
  const mine =
    ident.role === 'user' ? keys.filter((k) => normalizeOwnerId(k.user_id) === normalizeOwnerId(req.panelUserId)) : keys
  const admin = getPanelAdmin()
  return {
    envPassword: admin.password,
    envAdmin: ctx.panelUsers.getByUsername(admin.username),
    proxyCount: (snap.proxies || []).length,
    ...vmStepFacts(visible),
    groupCount:
      ident.role === 'user'
        ? new GroupsRepo(ctx.apiKeyStore.db).list().filter((g) => {
            try {
              new GroupsRepo(ctx.apiKeyStore.db).access(ctx.apiKeyStore.users.getById(ownerUserId), g.id)
              return true
            } catch {
              return false
            }
          }).length
        : 0,
    activeKeyCount: mine.filter((k) => k.status === 'active').length,
    hasFirstRequest: ctx.requestLog.hasSuccessfulRequest({ owner_user_id: ownerUserId }),
  }
}

function onboardingPayloadFor(req, ctx) {
  const user = onboardingUserOf(req)
  const role = onboardingRoleOf(req)
  const rec = recordOf(loadOnboardingState(new SettingsRepo()), user)
  return buildOnboardingPayload({
    user,
    role,
    status: rec.status,
    profile: rec.profile,
    guide_used: rec.guide_used,
    // Onboarding matches /health: base_url only when PUBLIC_* is configured; else null → browser origin.
    base_url: process.env.PUBLIC_BASE_URL || null,
    facts: collectOnboardingFacts(req, ctx),
  })
}

/**
 * 槽位 → 平台（anthropic / openai）。读库 worker 解不开加密的 `vm_json`，由控制面按已解密注册表算好传入，
 * 用于使用记录的平台判定与筛选联动；只含槽位 ID 与平台，不含凭据。
 */
function vmPlatforms(project) {
  const out = {}
  try {
    for (const vm of listVms(project)) if (vm?.id) out[vm.id] = normalizeVmKind(vm).platform
  } catch {}
  return out
}

/** Scrolling-log query string → `UsageLogsView` filters. Empty strings are dropped. */
function usageLogFilters(req, u, project) {
  const get = (k) => {
    const v = u.searchParams.get(k)
    return v == null || v === '' ? null : v
  }
  const role = panelIdentity(req).role
  const isUser = role === 'user'
  const diagnostic = role === 'super_admin'
  return {
    limit: get('limit'),
    cursor_created_at: get('cursor_created_at'),
    cursor_id: get('cursor_id'),
    user_id: isUser ? null : get('user_id'),
    key_id: get('key_id'),
    group_id: get('group_id'),
    vm_id: diagnostic ? get('vm_id') : null,
    account_id: diagnostic ? get('account_id') : null,
    session_id: diagnostic ? get('session_id') : null,
    model: get('model'),
    platform: get('platform'),
    vm_platforms: get('platform') ? vmPlatforms(project) : undefined,
    status_code: get('status_code'),
    exclude_status_200: get('exclude_status_200') === '1',
    model_mismatch: diagnostic && get('model_mismatch') === '1',
    min_attempt_count: diagnostic ? get('min_attempt_count') : null,
    error_class: get('error_class'),
    exclude_error_class: get('exclude_error_class'),
    include_muted: get('include_muted') === '1',
    errors_only: get('errors_only') === '1',
    start_time: get('start_time'),
    end_time: get('end_time'),
    q: get('q'),
    owner_user_id: logsOwner(req, u),
  }
}

/**
 * Validated statistics params. `user` may only group by key/model: user and
 * vm groupings would reveal other tenants or the pool layout.
 */
function statsParams(req, u, dimensionKey) {
  const isUser = panelIdentity(req).role === 'user'
  const rawRange = u.searchParams.get('range')
  const rawDim = u.searchParams.get(dimensionKey)
  const range = rawRange ? normalizeRange(rawRange) : 'today'
  if (!range) return { error: `invalid range: ${rawRange}` }
  const dimension = rawDim ? normalizeDimension(rawDim) : 'model'
  if (!dimension) return { error: `invalid ${dimensionKey}: ${rawDim}` }
  if (isUser && !USER_ROLE_DIMENSIONS.includes(dimension)) return { error: `${dimensionKey} not allowed: ${dimension}` }
  if (panelIdentity(req).role === 'admin' && !['user', 'model'].includes(dimension))
    return { error: `${dimensionKey} not allowed: ${dimension}` }
  return { range, dimension, owner_user_id: logsOwner(req, u) }
}

async function commitImportedCodexVm({
  cfg,
  vmPath,
  existing,
  account,
  catalogClientVersion = 'auto',
  routingConfig = {},
}) {
  const wasCodex = isCodexVm(existing)
  const previousPolicy = existing.policy && typeof existing.policy === 'object' ? existing.policy : {}
  const saved = upsertCodexAccount(cfg.paths.project, existing.id, account, { replaceCredentials: true })
  existing.platform = 'openai'
  existing.family = 'codex'
  existing.codex_kernel = true
  existing.codex = {
    ...(existing.codex && typeof existing.codex === 'object' ? existing.codex : {}),
    has_access: !!saved.access_token,
    has_refresh: !!saved.refresh_token,
    chatgpt_account_id: saved.chatgpt_account_id || null,
    email: saved.email || null,
    expires_at: saved.expires_at || null,
  }
  const global = normalizeOpenAIQuotaPolicy(routingConfig.codex?.quota || {})
  const preservePin = (value, override) =>
    previousPolicy[override] === true &&
    typeof previousPolicy[value] === 'number' &&
    Number.isInteger(previousPolicy[value]) &&
    previousPolicy[value] >= 0
  existing.policy = {
    ...previousPolicy,
    maxConcurrency:
      wasCodex && preservePin('maxConcurrency', 'concurrencyOverride')
        ? previousPolicy.maxConcurrency
        : global.max_concurrency,
    concurrencyOverride: wasCodex && preservePin('maxConcurrency', 'concurrencyOverride'),
    maxRpm: wasCodex && preservePin('maxRpm', 'rpmOverride') ? previousPolicy.maxRpm : global.max_rpm,
    rpmOverride: wasCodex && preservePin('maxRpm', 'rpmOverride'),
    maxSessions:
      wasCodex && preservePin('maxSessions', 'sessionsOverride') ? previousPolicy.maxSessions : global.max_sessions,
    sessionsOverride: wasCodex && preservePin('maxSessions', 'sessionsOverride'),
  }
  stampVmKind(existing)
  const writtenCodex = patchVmRecord(cfg.paths.project, existing.id, (vm) => {
    vm.platform = existing.platform
    vm.family = existing.family
    vm.codex_kernel = existing.codex_kernel
    vm.codex = existing.codex
    vm.policy = existing.policy
    stampVmKind(vm)
  })
  if (writtenCodex) Object.assign(existing, writtenCodex)
  resolveVendorAccountName(existing, saved.email)
  // Importing a GPT credential is an operator action: it reopens 不可调度.
  if (saved.access_token || saved.refresh_token) {
    const reopened = clearUnschedulable(cfg.paths.project, existing.id, { by: 'credential_import' })
    if (reopened) Object.assign(existing, getVm(cfg.paths.project, existing.id) || {})
  }
  let catalog = null
  try {
    catalog = await syncCodexCatalog({
      projectRoot: cfg.paths.project,
      vmId: existing.id,
      rotate: true,
      catalogClientVersion,
    })
  } catch {
    catalog = null
  }
  // Plan, subscription dates and payment channel come with the quota snapshot;
  // fetch it now so a fresh slot does not read 订阅 未知 until someone queries.
  try {
    await queryOpenaiQuota({
      projectRoot: cfg.paths.project,
      vmId: existing.id,
      rotate: false,
      policy: normalizeCodexRouting(routingConfig.codex).quota,
    })
    Object.assign(existing, getVm(cfg.paths.project, existing.id) || {})
  } catch {}
  return {
    vm: summarizeVm(existing, cfg.paths.project, routingConfig),
    platform: 'openai',
    catalog: catalog && catalog.ok ? { synced: catalog.synced, ids: catalog.ids } : catalog,
  }
}

function mergeKernelReports(local, cluster) {
  const items = [...(local?.items || []), ...(cluster?.items || [])]
  const failed = items.filter((item) => !item.ok)
  const changed = items.filter((item) => item.kernel_changed === true)
  return {
    ...(local || {}),
    ok: failed.length === 0,
    changed: changed.length > 0,
    total: items.length,
    ok_count: items.length - failed.length,
    failed_count: failed.length,
    changed_count: changed.length,
    items,
    cluster: cluster
      ? { total: cluster.total, ok_count: cluster.ok_count, failed_count: cluster.failed_count }
      : { total: 0, ok_count: 0, failed_count: 0 },
  }
}

// The entrypoint auto-sync and the panel upgrade can both ask at once; a slot must not be recreated twice concurrently.
let kernelSyncTail = Promise.resolve()

function syncInstalledKernels(args) {
  const run = kernelSyncTail.then(() => runKernelSync(args))
  kernelSyncTail = run.catch(() => {})
  return run
}

async function runKernelSync({ project, routingConfig, body = {}, refreshCluster = refreshClusterSlotPayloads }) {
  const all = listVms(project)
  const wanted = Array.isArray(body.ids) ? new Set(body.ids.map(String)) : null
  const selected = wanted ? all.filter((vm) => wanted.has(vm.id)) : all
  // Local slots bind the new binaries. Cluster slots bake the same kernel, CLIs
  // and kin-worker telemetry into a content-hashed image, then recreate onto it.
  const localVms = selected.filter((vm) => !slotHost(vm).bakedKernel)
  const clusterVms = selected.filter((vm) => slotHost(vm).bakedKernel)
  const checkOnly = body.restart === false
  const local = checkOnly
    ? inspectKernelChanges(project, localVms, { routing: routingConfig })
    : syncWrapSample(project, localVms, { routing: routingConfig })
  if (!checkOnly) {
    for (const item of local.items || []) {
      if (!item.ok || item.kernel_changed !== true) continue
      const vm = getVm(project, item.id)
      if (!vm || vm.status !== 'running') {
        item.kernel = { ok: true, skipped: true, reason: 'vm_stopped' }
        continue
      }
      if (resolveInferenceEngine(vm, routingConfig) !== 'rust') continue
      writeKernelConfig(project, vm, { routing: routingConfig, timezone: vm.timezone })
      const exec = slotExec(project, vm)
      item.kernel = await restartRustKernel(exec).catch((e) => ({
        ok: false,
        error: String(e?.message || e).slice(0, 200),
      }))
      if (!item.kernel?.ok) {
        markKernelRestartPending(project, item.id, item.kernel?.reason || 'kernel_restart_failed')
        item.ok = false
        item.code = 'kernel_restart_failed'
        item.error = item.kernel?.error || item.kernel?.reason || 'kernel restart failed'
      } else {
        clearKernelRestartPending(project, item.id)
      }
    }
  }
  const traits = body.mode === 'traits' && !checkOnly
  if (traits) {
    for (const vm of localVms) {
      if (isCodexVm(vm)) continue
      const gone = await destroySlot(vm)
      if (!gone.ok) {
        const item = (local.items || []).find((row) => row.id === vm.id)
        if (item) {
          item.ok = false
          item.code = gone.code || 'rebuild_failed'
          item.error = gone.error || '重建新特征失败'
        }
        continue
      }
      const rebuilt = recreateVmFiles(project, vm, { mode: 'traits' })
      const boot = await startSlotReady(rebuilt.vm, project, { recreate: true, routing: routingConfig })
      const item = (local.items || []).find((row) => row.id === vm.id) || {
        id: vm.id,
        ok: true,
        kernel_changed: true,
      }
      item.rebuild = boot.ok ? 'traits' : 'traits_failed'
      if (!boot.ok) {
        item.ok = false
        item.code = boot.code || 'rebuild_failed'
        item.error = boot.error || '重建新特征后启动失败'
      }
      if (!(local.items || []).includes(item)) local.items.push(item)
    }
  }
  const cluster = clusterVms.length
    ? checkOnly
      ? await inspectClusterPayloadChanges(project, clusterVms, { routing: routingConfig })
      : await refreshCluster(project, clusterVms, { routing: routingConfig, recreate: true })
    : null
  const failed = (local.items || []).filter((item) => !item.ok)
  local.ok = failed.length === 0
  local.ok_count = (local.items || []).length - failed.length
  local.failed_count = failed.length
  const report = mergeKernelReports(local, cluster)
  report.mode = traits ? 'traits' : 'keep'
  return report
}

/** Auth-link hint for the slot's proxy: `name · host:port`, or bare host:port when unnamed. */
function slotProxyHint(px = {}, label = null) {
  if (!px.host) return null
  const endpoint = `${px.host}${px.port ? ':' + px.port : ''}`
  return label ? `${label} · ${endpoint}` : endpoint
}

export function createPanelHandler(ctx) {
  const handleRelay = createRelayHandler(ctx)
  const handleVmBulk = createPanelVmBulkRoutes(ctx)
  // A checkout can change under a live Node process; report its boot version.
  const runningVersion = readLocalVersion(ctx.cfg?.paths?.project)
  const {
    cfg,
    json,
    readBody,
    readRawBody,
    refreshCluster,
    requireAuth,
    routingConfigPath,
    stickyRouter,
    accountQuota,
    proxyPool,
    apiKeyStore,
    apiEndpointStore,
    apiScheduler,
    panelUsers,
    requestLog,
    vmTestSchedule,
    backupService,
    stats,
    persistRoutingPatch,
    applyVmConcurrency,
    applyVmRpm,
    applyVmSessionSlots,
    inheritVmScheduling,
    applyVmQuotaOverride,
    initPoolRuntime,
    poolSchedulerConfig,
    commitImportedOauth,
    requireSlotProxy,
    officialCcStatsHandler,
    refreshWorkerCredentialForVm,
    fetchWorkerModels,
  } = createPanelRouteContext(ctx, { defaultReadRawBody, refreshClusterSlotPayloads })
  const hostUnsupported = (res, vm, cap) => {
    if (slotHost(vm).supports(cap)) return false
    json(res, 409, {
      ok: false,
      error: { code: 'remote_unsupported', message: '集群节点上的虚拟机暂不支持此操作' },
    })
    return true
  }
  const vendorPlatform = () =>
    ctx.vendorPlatform || (ctx.vendorPlatform = new VendorPlatform(getDb(), { vmProvisioner: ctx.vendorVmProvisioner }))
  const usageQueries = createUsageQueryService()
  const settlementQueries = createSettlementQueryService()
  const settlementCommands = createSettlementCommandService()
  const accountCommands = createAccountCommandService()
  const accountQueries = createAccountQueryService()
  const handleGatewayWorkerRoutes = createGatewayWorkerRoutes({
    json,
    readBody,
    proxyPool,
    supervisor: ctx.gatewayWorkerSupervisor,
  })
  const gatewayWorkerService = ctx.gatewayWorker || new GatewayWorkerService()
  // 供应商（及运营端账号池）重新授权已有 Gateway 账号：复用运营端 Codex 账号的草稿与 OAuth 流程
  let gatewayReauthorization = null
  const vendorGatewayAccounts = () =>
    (gatewayReauthorization ||= new GatewayAccountManagement({
      repo: gatewayWorkerService.repo,
      service: gatewayWorkerService,
      proxyPool,
    }))
  const settingsRepo = () => new SettingsRepo(ctx.db || getDb())
  const handlePanelUsers = createPanelUserRoutes({ panelUsers, json, readBody, vendorPlatform })
  const handlePanelApiKeys = createPanelApiKeyRoutes({
    apiKeyStore,
    requestLog,
    json,
    readBody,
    ctx,
    normalizeInput: normalizePanelApiKeyInput,
  })
  const handlePanelApiEndpoints = createPanelApiEndpointRoutes({
    apiEndpointStore,
    apiKeyStore,
    apiScheduler,
    proxyPool,
    cfg,
    ctx,
    json,
    readBody,
    upstreamFetchStatus,
  })
  const handlePanelBackups = createPanelBackupRoutes({ backupService, apiKeyStore, json, readBody })
  const handlePanelVmReadRoutes = createPanelVmReadRoutes({
    panel,
    cfg,
    accountQuota,
    routingConfig: ctx.routingConfig,
    poolScheduler: ctx.poolScheduler,
    proxyPool,
    requestLog,
    db: ctx.db || null,
    kernelHealth: panelKernelHealth,
    clusterNodesOf: () => clusterNodesOf(ctx),
    panelIdentity,
    probeLocalKvm: ctx.probeLocalKvm || probeLocalKvm,
    usageProbeMonitor: ctx.usageProbeMonitor,
    json,
  })
  const handlePanelVmProvisionRoutes = createPanelVmProvisionRoutes({
    cfg,
    fs,
    path,
    json,
    readBody,
    listVms,
    accountQuota,
    newVmNaming,
    isValidVmId,
    panelIdentity,
    ctx,
    normalizeVmConfig,
    resolveMachineSpec,
    OS_CATALOG,
    kernelForIndex,
    RUNTIME_KVM,
    probeLocalKvm,
    preflightNode,
    stampVmKind,
    isCodexVm,
    slotHost,
    proxyPool,
    isLocalEgressId,
    isLocalEgressProxy,
    localProxyMismatchMessage: LOCAL_PROXY_MISMATCH_MESSAGE,
    canBindProxyToVm,
    validTimezone,
    slotLocales: SLOT_LOCALES,
    standardLocale: STANDARD_LOCALE,
    assignComputerFingerprint,
    takenFingerprintKeys,
    buildNewVmRecord,
    atomicWriteJson,
    writeGuestMachineIdFile,
    seedFreshCliHome,
    bindVmProxy,
    adoptVmProxyBinding,
    fillTimezoneFromExit,
    activateVmSlot,
    startSlotReady,
    patchVmRecord,
    markUnschedulable,
    getVm,
    clusterNodesOf,
    summarizeVm,
    panel,
  })
  const handlePanelVmImportRoutes = createPanelVmImportRoutes({
    cfg,
    fs,
    path,
    json,
    readBody,
    panel,
    ctx,
    summarizeVm,
    panelImportErrorPayload,
    requireSlotProxy,
    slotExec,
    isCodexVm,
    parseCodexImportPayload,
    refreshCodexAccessToken,
    commitImportedCodexVm,
    looksLikeConsoleApiKey,
    pastedAccessTokenToOauth,
    sessionKeyToOAuth,
    isSub2apiAccountExport,
    sub2apiAccountToOauth,
    enrichOauthIdentity,
    assertVendorRuntimeVm,
    commitImportedOauth,
    invalidateLiveCredentialCache,
  })
  const handlePanelVmCommandRoutes = createPanelVmCommandRoutes({
    cfg,
    routingConfig: ctx.routingConfig,
    readBody,
    json,
  })
  const handlePanelVmLifecycleRoutes = createPanelVmLifecycleRoutes({
    cfg,
    routingConfig: ctx.routingConfig,
    proxyPool,
    clusterNodesOf: () => clusterNodesOf(ctx),
    panel,
    panelIdentity,
    gatewayCapabilities: GATEWAY_CAPABILITIES,
    json,
    start: async (id, { role }) => {
      if (role === 'vendor') {
        const started = await startVendorRuntimeVm(id)
        return started.ok ? started : { ...started, status: started.status || 409 }
      }
      const started = await powerOnSlot({
        projectRoot: cfg.paths.project,
        id,
        proxyPool,
        routing: ctx.routingConfig,
        fillTimezone: fillTimezoneFromExit,
        by: 'start',
      })
      return started.ok ? started : { ...started, status: started.status || 409 }
    },
    recover: async (id, { role }) =>
      recoverSlot({
        projectRoot: cfg.paths.project,
        id,
        proxyPool,
        routing: ctx.routingConfig,
        fillTimezone: fillTimezoneFromExit,
        watchdog: ctx.kernelWatchdog,
        internal: role === 'super_admin',
      }),
    stop: async (id) => {
      const vmPath = path.join(cfg.paths.project, 'vms', `${id}.json`)
      if (!fs.existsSync(vmPath)) return { ok: false, status: 404, code: 'vm_not_found', error: 'vm not found' }
      const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
      const halt = await stopSlot(vm)
      if (!halt.ok)
        return { ok: false, status: 500, code: 'runtime_stop_failed', error: halt.error || 'runtime stop failed' }
      vm.status = 'stopped'
      migrateScheduleRecord(vm)
      applyScheduleOff(vm, true, { reason: 'stopped' })
      atomicWriteJson(vmPath, vm, { mode: 0o600 })
      return { ok: true, vm, halt }
    },
  })
  const handlePanelVmDiagnoseRoutes = createPanelVmDiagnoseRoutes({
    cfg,
    routingConfig: ctx.routingConfig,
    kernelWatchdog: ctx.kernelWatchdog,
    panelIdentity,
    json,
  })
  const handlePanelVmProbeRoutes = createPanelVmProbeRoutes({
    cfg,
    routingConfig: ctx.routingConfig,
    accountQuota,
    panel,
    probeExitGeo: probeVmExitGeo,
    json,
  })
  const handlePanelVmQuotaRoutes = createPanelVmQuotaRoutes({
    cfg,
    routingConfig: ctx.routingConfig,
    accountQuota,
    panel,
    json,
  })
  const handlePanelVmTestRoutes = createPanelVmTestRoutes({
    cfg: { ...cfg, accountQuota },
    panel,
    panelIdentity,
    readBody,
    json,
    getVm: (projectRoot, id) => getVm(projectRoot, id),
    isValidVmId,
    vmTestSchedule,
    VmTestScheduleError,
    runVmTestChat,
    resolveTestModels,
  })
  const handlePanelVmCredentialRoutes = createPanelVmCredentialRoutes({
    cfg,
    fs,
    path,
    json,
    readBody,
    withVmLock,
    getVm,
    patchVmRecord,
    migrateScheduleRecord,
    applyUnschedulable,
    invalidateLiveCredentialCache,
    stopCodexKernel,
    ensureCodexKernel,
    slotExec,
    isCodexVm,
    accountQuota,
    summarizeVm,
    routingConfig: () => ctx.routingConfig,
    assignComputerFingerprint,
    takenFingerprintKeys,
    listVms,
    atomicWriteJson,
    writeGuestMachineIdFile,
    applyGeneratedFingerprint,
    applyOfficialFingerprintToVm,
    officialCcHome,
  })
  const handlePanelVmRuntimeRoutes = createPanelVmRuntimeRoutes({
    cfg,
    json,
    readBody,
    panel,
    panelIdentity,
    getVm,
    reloadSlotReady,
    slotShell: ctx.slotShell,
    assertVendorRuntimeVm,
    collectSlotIdentity,
    routing: ctx.routingConfig,
  })
  const handlePanelVmOauthQueryRoutes = createPanelVmOauthQueryRoutes({
    cfg,
    json,
    panel,
    getVm,
    readWorkerCredentialFile,
    oauthToSub2apiExport,
    readSetupTokenSession,
    setupTokenFlavor: SETUP_TOKEN_FLAVOR,
  })
  const handlePanelVmOauthMutationRoutes = createPanelVmOauthMutationRoutes({
    cfg,
    fs,
    path,
    json,
    readBody,
    panel,
    proxyPool,
    requireSlotProxy,
    slotProxyHint,
    getVm,
    summarizeVm,
    isCodexVm,
    generateCodexAuthUrl,
    startClaudeAuthLoginSession,
    normalizeOauthFlavor,
    setupTokenFlavor: SETUP_TOKEN_FLAVOR,
    authLoginFlavor: AUTH_LOGIN_FLAVOR,
    authLoginSource: AUTH_LOGIN_SOURCE,
    generateAuthUrl,
    exchangeCodexAuthCode,
    readAuthLoginSession,
    looksLikeOfficialSetupToken,
    completeClaudeSetupToken,
    completeClaudeAuthLogin,
    exchangeAuthCode,
    slotExec,
    enrichOauthIdentity,
    assertVendorRuntimeVm,
    commitImportedCodexVm,
    commitImportedOauth,
    parseCredentialEdit,
    readWorkerCredentialFile,
    isApiKeyMode,
    isOfficialSetupTokenMode,
    isSetupTokenMode,
    liveOauthToSetupToken,
    readCodexAccounts,
    refreshCodexAccessToken,
    hostProxyUrlForVm,
    upsertCodexAccount,
    oauthCredentialState,
    refreshWorkerCredentialForVm,
    refreshAccountProfile,
    invalidateLiveCredentialCache,
    routingConfig: ctx.routingConfig,
  })
  const handlePanelVmSeedRoutes = createPanelVmSeedRoutes({
    cfg,
    json,
    readBody,
    panel,
    getVm,
    fs,
    path,
    withVmLock,
    readSeedSettings,
    defaultSeedPolicy,
    seedTelemetryContract,
    readTelemetryUploadLog,
    isCodexVm,
    slotHost,
    isTelemetryEnabled,
    validTimezone,
    standardLocale: STANDARD_LOCALE,
    slotLocales: SLOT_LOCALES,
    syncVmTimezoneFromProxy,
    proxyPool,
    atomicWriteJson,
    writeSlotSeedFiles,
    applyNativeTelemetry,
    routingConfig: ctx.routingConfig,
  })
  const handlePanelVmPackageRoutes = createPanelVmPackageRoutes({
    cfg,
    json,
    readBody,
    panel,
    panelIdentity,
    getVm,
    exportVmPackage,
    commitVmPackage,
    parseVmPackage,
    proxyPool,
    fillTimezoneFromExit,
    accountQuota,
    reloadSlotReady,
    setScheduleHold,
    restoreSchedulableIfReady,
    bringUpImportedVm,
    summarizeVm,
    routingConfig: ctx.routingConfig,
    packageImportBringUp: ctx.packageImportBringUp,
    holdMaintenance: HOLD_MAINTENANCE,
  })
  const handlePanelVmResetRoutes = createPanelVmResetRoutes({
    cfg,
    json,
    readBody,
    panel,
    fs,
    path,
    withVmLock,
    destroySlot,
    recreateVmFiles,
    getVm,
    invalidateLiveCredentialCache,
    hasBoundExit,
    proxyPool,
    bindVmProxy,
    adoptVmProxyBinding,
    patchVmRecord,
    markUnschedulable,
    startSlotReady,
    summarizeVm,
    routingConfig: ctx.routingConfig,
  })
  const handlePanelVmMaintenanceRoutes = createPanelVmMaintenanceRoutes({
    cfg,
    json,
    readBody,
    panel,
    getVm,
    listVms,
    setScheduleOff,
    holdSchedulableSlots,
    waitForSlotDrain: (ids) => waitForSlotDrain(ctx.poolScheduler, ids),
    kernelUpdateHold: KERNEL_UPDATE_HOLD,
    resumeSchedulableSlots,
    isMaintenanceHold,
    activateVmSlot,
    deactivateVmSlot,
    clearVmCooldown: (id) =>
      panel.clearVmCooldown({
        cfg,
        accountQuota,
        stickyRouter,
        poolScheduler: ctx.poolScheduler,
        id,
      }),
    resetVmCircuit: (id) => panel.resetVmCircuit({ cfg, poolScheduler: ctx.poolScheduler, id }),
    deleteVm: async (id, respond, response, req) => {
      if (!isValidVmId(id)) return respond(response, 400, { ok: false, error: { message: 'invalid vm id' } })
      const vmPath = path.join(cfg.paths.project, 'vms', `${id}.json`)
      if (!fs.existsSync(vmPath)) return respond(response, 404, { ok: false, error: { message: 'vm not found' } })
      const active = getActiveVmId(cfg.paths.project)
      if (active === id && listVms(cfg.paths.project).some((vm) => vm.id !== id))
        return respond(response, 409, { ok: false, error: { message: 'cannot delete active VM, switch active first' } })
      const vm = getVm(cfg.paths.project, id)
      try {
        if (vm) {
          const gone = await destroySlot(vm)
          if (!gone.ok && slotHost(vm).kind === 'node')
            return respond(response, 409, {
              ok: false,
              error: { code: gone.code || 'remote_destroy_failed', message: gone.error || 'remote destroy failed' },
            })
        }
      } catch {}
      try {
        removeVmFromDb(id, panelIdentity(req).user)
      } catch {
        return respond(response, 500, {
          ok: false,
          error: { code: 'vm_delete_failed', message: '槽位分组关系清理失败，请重试删除' },
        })
      }
      try {
        proxyPool.unbindVm(id)
      } catch {}
      try {
        fs.rmSync(path.join(cfg.paths.project, 'vms', id), { recursive: true, force: true })
      } catch {}
      fs.unlinkSync(vmPath)
      invalidateVmSlotReadCache(cfg.paths.project, id)
      try {
        vmTestSchedule.remove(id)
      } catch {}
      if (active === id) {
        clearActiveVm(cfg.paths.project)
        try {
          clearActiveVmFromDb()
        } catch {}
        try {
          reloadActiveVm(cfg)
        } catch {}
      }
      try {
        const chat = path.join(cfg.paths.project, 'vms', `${id}-chat.json`)
        if (fs.existsSync(chat)) fs.unlinkSync(chat)
      } catch {}
      return respond(response, 200, panel.ok({ deleted: id }))
    },
  })
  const numericRevision = (value) => {
    if (value == null || typeof value === 'boolean' || (typeof value === 'string' && value.trim() === '')) return NaN
    return Number(value)
  }
  const currentConfigRevision = () => {
    try {
      const revision = ctx.getConfigRevision?.() ?? ctx.runtimeSnapshot?.revision?.()
      const numeric = numericRevision(revision)
      return Number.isSafeInteger(numeric) && numeric >= 1 ? numeric : 1
    } catch {
      return 1
    }
  }
  /**
   * A worker reload finished: lift its maintenance hold. `by` names the operator
   * action that caused the reload; only that may also clear 不可调度.
   */
  function restoreSchedulableIfReady(vmId, { by = null } = {}) {
    clearScheduleHold(cfg.paths.project, vmId, HOLD_MAINTENANCE)
    const vm = getVm(cfg.paths.project, vmId)
    if (!vmHasSchedulableCredential(vm, cfg.paths.project)) {
      markUnschedulable(cfg.paths.project, vmId, 'no_credential')
      return
    }
    if (by) clearUnschedulable(cfg.paths.project, vmId, { by })
  }

  function fillTimezoneFromExit(id) {
    return fillVmTimezoneFromExit(cfg.paths.project, proxyPool, id)
  }

  function assertVendorRuntimeVm(req, runtimeVmId) {
    if (panelIdentity(req).role !== 'vendor') return
    runtimeVmId = String(runtimeVmId || '').trim()
    const platform = vendorPlatform()
    const identity = platform.identity(req.panelUserId)
    platform.requireActive(identity)
    platform.requireCapability(identity, 'vendor.resource.manage')
    const rows = platform.db
      .prepare(`SELECT vm.config_json,a.config_json AS account_config_json FROM vendor_resources vm
      JOIN vendor_resources a ON a.id=json_extract(vm.config_json,'$.account_resource_id') AND a.vendor_id=vm.vendor_id
      WHERE vm.vendor_id=? AND vm.resource_type='vm' AND vm.status<>'archived'
        AND a.resource_type='account' AND a.status<>'archived'`)
      .all(identity.vendor.id)
    const owned = rows.some(
      (row) => String(JSON.parse(row.config_json || '{}').runtime_vm_id || '') === String(runtimeVmId),
    )
    if (!owned) throw new VendorError('vendor_scope_forbidden', '虚拟机或配对账号已归档，或不属于当前供应商', 403)
    const runtime = getVm(cfg.paths.project, runtimeVmId)
    const selected = rows.find((row) => JSON.parse(row.config_json || '{}').runtime_vm_id === runtimeVmId)
    const accountPlatform = JSON.parse(selected.account_config_json || '{}').platform
    const actualPlatform = normalizeVmKind(runtime || { platform: accountPlatform }).platform
    const allowed = new Set(platform.availableAccountGroups(identity, actualPlatform).map((g) => g.id))
    const assigned = platform.db
      .prepare("SELECT group_id FROM group_resources WHERE resource_kind='vm' AND resource_id=?")
      .all(runtimeVmId)
    if (actualPlatform !== accountPlatform || !assigned.length || assigned.some((g) => !allowed.has(g.group_id)))
      throw new VendorError('vendor_scope_revoked', '账号平台或分组授权已变更，请联系超级管理员', 403)
  }

  async function startVendorRuntimeVm(runtimeVmId) {
    const vm = getVm(cfg.paths.project, runtimeVmId)
    if (!vm) return { ok: false, status: 404, code: 'vm_not_found', error: 'vm not found' }
    if (vm.status === 'running') return { ok: true, vm }
    let boot
    try {
      boot = await startSlotReady(vm, cfg.paths.project, { routing: ctx.routingConfig })
    } catch (error) {
      boot = { ok: false, code: error?.code || 'runtime_start_failed', error: String(error?.message || error) }
    }
    if (!boot?.ok)
      return {
        ok: false,
        status: 500,
        code: boot?.code || 'runtime_start_failed',
        error: '运行环境启动失败，请联系超级管理员检查代理和虚拟机服务',
      }
    const saved = patchVmRecord(cfg.paths.project, runtimeVmId, {
      ...(boot.runtime ? { runtime: boot.runtime } : {}),
      status: 'running',
    })
    return { ok: true, vm: saved || getVm(cfg.paths.project, runtimeVmId) || vm, boot }
  }

  function vendorDraftProxyUrl(platform, identity, draft) {
    if (draft.body.proxy_endpoint) return vendorProxyAddress(draft.body.proxy_endpoint)
    if (!draft.body.proxy_id) return ''
    const resource = platform.getResource(identity, String(draft.body.proxy_id), { write: true })
    if (resource.resource_type !== 'proxy' || resource.status !== 'active')
      throw new VendorError('proxy_unavailable', '代理不可用', 409)
    const secret = platform.resourceSecret(identity, resource.id)
    return vendorProxyAddress(secret.endpoint || resource.config.endpoint)
  }

  function normalizeVendorDraft(platform, identity, body) {
    const allowed = [
      'name',
      'platform',
      'authorization_kind',
      'auth_method',
      'execution_kind',
      'proxy_id',
      'proxy_endpoint',
      'group_ids',
      'idempotency_key',
    ]
    if (Object.keys(body).some((key) => !allowed.includes(key)))
      throw new VendorError('vm_config_forbidden', '供应商不能修改虚拟机运行参数', 403)
    const kind =
      String(body.authorization_kind || '').trim() ||
      (String(body.platform || '').toLowerCase() === 'openai' ? 'codex_oauth' : 'claude_oauth')
    const defaults = {
      claude_oauth: { platform: 'anthropic', auth_method: 'oauth' },
      claude_setup_token: { platform: 'anthropic', auth_method: 'setup-token' },
      claude_console: { platform: 'anthropic', auth_method: 'apikey' },
      codex_oauth: { platform: 'openai', auth_method: 'oauth' },
      codex_account_file: { platform: 'openai', auth_method: 'oauth' },
    }[kind]
    if (!defaults) throw new VendorError('authorization_kind_invalid', '授权方式无效')
    const normalizedPlatform =
      { claude: 'anthropic', codex: 'openai' }[String(body.platform || '').trim()] ||
      String(body.platform || defaults.platform).trim()
    if (normalizedPlatform !== defaults.platform)
      throw new VendorError('authorization_platform_mismatch', '授权方式与所选平台不一致')
    const executionKind = String(body.execution_kind || 'vm').trim()
    if (!['vm', 'gateway_worker'].includes(executionKind))
      throw new VendorError('execution_kind_invalid', '执行方式无效')
    if (body.proxy_id && body.proxy_endpoint)
      throw new VendorError('proxy_source_conflict', '请选择已有代理或填写新代理')
    if (body.proxy_endpoint) vendorProxyAddress(body.proxy_endpoint)
    // Worker 进程共用主机出口，账号没有代理就会以 Worker IP 直连上游（与超管自营开户同一规则）
    if (executionKind === 'gateway_worker' && !body.proxy_id && !body.proxy_endpoint)
      throw new VendorError('proxy_required', '请先配置账号出站代理')
    if (body.proxy_id) {
      const proxy = platform.getResource(identity, String(body.proxy_id), { write: true })
      if (proxy.resource_type !== 'proxy' || proxy.status !== 'active')
        throw new VendorError('proxy_unavailable', '代理不可用', 409)
    }
    platform.requireActive(identity)
    platform.requireCapability(identity, 'vendor.resource.manage')
    if (executionKind === 'vm') platform.requireCapability(identity, 'vendor.vm.create')
    const groupIds = platform.accountGroupIds(identity, body.group_ids, normalizedPlatform, {
      requireExplicitGroup: true,
    })
    return {
      name: String(body.name || '').trim(),
      platform: normalizedPlatform,
      authorization_kind: kind,
      auth_method: defaults.auth_method,
      execution_kind: executionKind,
      proxy_id: body.proxy_id ? String(body.proxy_id) : '',
      proxy_endpoint: body.proxy_endpoint ? String(body.proxy_endpoint).trim() : '',
      group_ids: groupIds,
      idempotency_key: String(body.idempotency_key || '').trim(),
    }
  }

  async function finalizeVendorDraft(identity, draft) {
    if (draft.result) return draft.result
    if (!draft.credential) throw new VendorError('authorization_required', '请先完成账号授权', 409)
    const platform = vendorPlatform()
    let pair = null
    const resourceView = (resourceId) =>
      projectResource(platform.db.prepare('SELECT * FROM vendor_resources WHERE id=?').get(resourceId))
    try {
      pair = platform.createAccount(
        identity,
        {
          ...draft.body,
          idempotency_key: draft.body.idempotency_key || `vendor-draft:${draft.id}`,
        },
        {
          configure: (runtime, account) => {
            const proxyId = account.config?.proxy_id
            if (proxyId) {
              const proxyResource = platform.getResource(identity, proxyId, { write: true })
              const poolId = vendorProxyPoolId(identity, projectResource(proxyResource))
              proxyPool.addPlatform(poolId, account.config.platform)
              const bound = proxyPool.bind(poolId, runtime.id)
              if (!bound.ok) throw new VendorError('proxy_bind_failed', '代理不可用或已达到绑定上限', 409)
              runtime.proxy = proxyPool.getProxyForVm(runtime.id)
              runtime.proxy_required = true
              runtime.proxy_cli_enabled = true
            }
            if (ctx.groupsRepo)
              ctx.groupsRepo.assignResource(
                'vm',
                runtime.id,
                account.config?.group_ids || [],
                ctx.groupsRepo.resourceVersion('vm', runtime.id),
                identity.user_id,
              )
          },
        },
      )
      if (draft.body.execution_kind === 'gateway_worker') {
        const runtimeAccountId = String(draft.credential.runtime_account_id || `gwacct_${pair.account.id}`)
        // 凭据来源实例只选一次：OAuth 用完成换票的实例，导入用推送凭据的实例
        const sourceInstanceId = draft.credential.worker_authorized
          ? draft.credential.gateway_instance_id || null
          : gatewayWorkerService.repo.pickInstance()?.id || null
        if (!sourceInstanceId) throw new VendorError('gateway_worker_unavailable', '暂无可用 Gateway Worker', 503)
        const proxyUrl = vendorDraftProxyUrl(platform, identity, draft)
        let pushed = { ok: true, data: { account: { credential_revision: draft.credential.credential_revision || 1 } } }
        if (!draft.credential.worker_authorized) {
          pushed = await gatewayWorkerService.upsertAccount(
            {
              id: runtimeAccountId,
              email: draft.credential.email || draft.credential.account_email || '',
              chatgpt_account_id: draft.credential.chatgpt_account_id || draft.credential.account_id || '',
              plan: draft.credential.plan_type || draft.credential.plan || '',
              auth_type: draft.credential.api_key ? 'api_key' : 'oauth',
              access_token: draft.credential.access_token || draft.credential.accessToken || '',
              refresh_token: draft.credential.refresh_token || draft.credential.refreshToken || '',
              id_token: draft.credential.id_token || draft.credential.idToken || '',
              api_key: draft.credential.api_key || draft.credential.apiKey || '',
              enabled: true,
              groups: (draft.body.group_ids || []).map(String),
              proxy_url: proxyUrl,
            },
            sourceInstanceId,
          )
          if (!pushed?.ok) throw new VendorError('gateway_account_sync_failed', 'Gateway Worker 账号同步失败', 502)
        }
        const credentialRevision = Number(
          pushed.data?.account?.credential_revision || draft.credential.credential_revision || 1,
        )
        const authorizedEmail = String(draft.credential.email || draft.credential.account_email || '').trim()
        const authorizedPlan = String(draft.credential.plan_type || draft.credential.plan || '').trim()
        const accountConfig = {
          ...pair.account.config,
          execution_kind: 'gateway_worker',
          runtime_account_id: runtimeAccountId,
          gateway_instance_id: sourceInstanceId,
          group_ids: draft.body.group_ids || [],
          // 与运营端建号相同：授权身份写入配置，账号池据此显示邮箱与套餐
          ...(authorizedEmail ? { email: authorizedEmail } : {}),
          ...(authorizedPlan ? { plan: authorizedPlan } : {}),
        }
        // 名称留空时使用授权邮箱（与虚拟机账号的 resolveVendorAccountName 相同）
        const authorizedName = accountConfig.name_from_authorization === true && authorizedEmail ? authorizedEmail : ''
        if (authorizedName) delete accountConfig.name_from_authorization
        // 账号已进入来源实例：先落绑定、运行 ID 与代理，后续投影失败也能由心跳对账并重放代理
        gatewayWorkerService.repo.recordProjection({
          accountResourceId: pair.account.id,
          instanceId: sourceInstanceId,
          runtimeAccountId,
          credentialRevision,
          status: 'pending',
        })
        const storedSecret = JSON.parse(
          maybeDecrypt(
            platform.db.prepare('SELECT secret_json FROM vendor_resources WHERE id=?').get(pair.account.id)
              ?.secret_json,
          ) || '{}',
        )
        platform.db
          .prepare(
            'UPDATE vendor_resources SET name=COALESCE(?,name),config_json=?,secret_json=?,updated_at=? WHERE id=?',
          )
          .run(
            authorizedName || null,
            JSON.stringify(accountConfig),
            maybeEncrypt(JSON.stringify({ ...storedSecret, proxy_url: proxyUrl })),
            new Date().toISOString(),
            pair.account.id,
          )
        const projected = await gatewayWorkerService.projectAccountToAll(
          { id: runtimeAccountId, account_resource_id: pair.account.id, credential_revision: credentialRevision },
          sourceInstanceId,
        )
        if (!projected?.ok)
          throw new VendorError('gateway_account_projection_pending', 'Gateway Worker 账号正在同步到集群实例', 502)
        platform.db
          .prepare("UPDATE vendor_resources SET status='active',updated_at=? WHERE id=?")
          .run(new Date().toISOString(), pair.account.id)
        for (const item of projected.results || []) {
          if (!item.instance_id) continue
          const stamp = new Date().toISOString()
          const status = item.ok ? 'synced' : 'drifted'
          platform.db
            .prepare(
              `INSERT INTO gateway_worker_account_bindings(id,account_resource_id,gateway_instance_id,runtime_account_id,credential_revision,projection_status,last_seen_at,created_at,updated_at) VALUES(?,?,?,?,?, ?,?,?,?) ON CONFLICT(account_resource_id,gateway_instance_id) DO UPDATE SET runtime_account_id=excluded.runtime_account_id,credential_revision=excluded.credential_revision,projection_status=excluded.projection_status,last_seen_at=excluded.last_seen_at,updated_at=excluded.updated_at`,
            )
            .run(
              `binding_${pair.account.id}_${item.instance_id}`,
              pair.account.id,
              item.instance_id,
              runtimeAccountId,
              credentialRevision,
              status,
              stamp,
              stamp,
              stamp,
            )
        }
        for (const groupId of draft.body.group_ids || []) {
          try {
            ctx.groupsRepo?.assignResource(
              'gateway_worker_account',
              pair.account.id,
              [Number(groupId)],
              ctx.groupsRepo.resourceVersion('gateway_worker_account', pair.account.id),
              identity.user_id,
            )
          } catch {}
        }
        const result = {
          account: resourceView(pair.account.id),
          vm: null,
          provisioning: { state: 'normal', schedulable: true },
          gateway_worker: { runtime_account_id: runtimeAccountId, instance_id: sourceInstanceId },
        }
        accountCommands.finalizeDraft(identity, draft.id, result)
        return result
      }
      const runtimeVmId = String(pair.vm.config?.runtime_vm_id || '')
      const vmPath = path.join(cfg.paths.project, 'vms', `${runtimeVmId}.json`)
      const existing = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
      existing.id = existing.id || runtimeVmId
      let committed
      if (draft.body.platform === 'openai') {
        committed = await commitImportedCodexVm({
          cfg,
          vmPath,
          existing,
          account: draft.credential,
          catalogClientVersion: ctx.routingConfig.codex?.catalog_client_version,
          routingConfig: ctx.routingConfig,
        })
      } else {
        committed = await commitImportedOauth({
          vmId: runtimeVmId,
          vmPath,
          existing,
          oauth: draft.credential,
          source: draft.credential.source || 'vendor-account-draft',
          skipOfficialCc: true,
        })
      }
      if (!committed?.ok && committed?.status)
        throw new VendorError('credential_commit_failed', '授权凭证写入失败', 502)
      const runtime = await startVendorRuntimeVm(runtimeVmId)
      const credentialReady =
        draft.body.platform === 'openai'
          ? vmHasSchedulableCredential(getVm(cfg.paths.project, runtimeVmId), cfg.paths.project)
          : vmHasClaudeCredential(getVm(cfg.paths.project, runtimeVmId))
      const ready = !!runtime.ok && credentialReady
      const stamp = new Date().toISOString()
      platform.db
        .prepare('UPDATE vendor_resources SET status=?,updated_at=? WHERE id IN (?,?)')
        .run(ready ? 'active' : 'provisioning', stamp, pair.account.id, pair.vm.id)
      if (ready) restoreSchedulableIfReady(runtimeVmId, { by: 'credential_import' })
      const result = {
        account: resourceView(pair.account.id),
        vm: resourceView(pair.vm.id),
        runtime_boot: { ok: !!runtime.ok, code: runtime.code || null, error: runtime.error || null },
        provisioning: {
          state: ready ? 'normal' : 'preparing',
          schedulable: ready,
        },
        ...(committed?.oauth_email ? { oauth_email: committed.oauth_email } : {}),
      }
      accountCommands.finalizeDraft(identity, draft.id, result)
      return result
    } catch (error) {
      if (!pair) throw error
      const stamp = new Date().toISOString()
      if (draft.body.execution_kind === 'gateway_worker') {
        platform.db
          .prepare("UPDATE vendor_resources SET status='provisioning',updated_at=? WHERE id=?")
          .run(stamp, pair.account.id)
        const result = {
          account: resourceView(pair.account.id),
          vm: null,
          runtime_boot: {
            ok: false,
            code: error.code || 'provisioning_failed',
            error: '账号已授权，Gateway Worker 账号正在同步',
          },
          provisioning: { state: 'preparing', schedulable: false },
        }
        accountCommands.finalizeDraft(identity, draft.id, result)
        return result
      }
      platform.db
        .prepare("UPDATE vendor_resources SET status='provisioning',updated_at=? WHERE id IN (?,?)")
        .run(stamp, pair.account.id, pair.vm.id)
      const result = {
        account: resourceView(pair.account.id),
        vm: resourceView(pair.vm.id),
        runtime_boot: { ok: false, code: error.code || 'provisioning_failed', error: '账号已授权，运行环境正在准备' },
        provisioning: { state: 'preparing', schedulable: false },
      }
      accountCommands.finalizeDraft(identity, draft.id, result)
      return result
    }
  }

  function presentVendorProxy(resource) {
    const row = proxyPool.findByVendorResource(resource.id)
    if (!row) return resource
    const view = proxyPool.publicProxy(row)
    return {
      ...resource,
      config: {
        ...resource.config,
        pool_id: view.id,
        host: view.host,
        port: view.port,
        has_auth: view.has_auth,
        pool_status: view.status,
        pool_enabled: view.enabled,
        latency_ms: view.latency_ms,
        last_probe_at: view.last_probe_at,
        last_error: view.last_error,
        quality: view.quality,
        geo: view.geo,
        expires_at: view.expires_at,
        region: view.geo?.country_code || '',
        region_name: view.geo?.country || '',
        city: view.geo?.city || '',
        bound_count: view.bound_count,
        bind_limit: view.bind_limit,
        bound_vm_ids: view.bound_vm_ids,
        available: view.enabled && !view.blocked_reason && !['dead', 'fail', 'expired'].includes(view.status),
      },
    }
  }

  async function vendorProxyAction(identity, resourceId, action) {
    const platform = vendorPlatform()
    const resource = platform.getResource(identity, resourceId, { write: true })
    if (resource.resource_type !== 'proxy') throw new VendorError('resource_not_found', '代理资源不存在', 404)
    const poolId = vendorProxyPoolId(identity, projectResource(resource))
    if (action === 'probe') return proxyPool.probeById(poolId, { connectivity: true })
    if (action === 'quality') return proxyPool.qualityById(poolId)
    if (action === 'geo') return proxyPool.detectGeo(poolId, { force: true })
    if (action === 'enable' || action === 'disable' || action === 'archive') {
      const enabled = action === 'enable'
      const current = proxyPool.state.proxies.find((item) => item.id === poolId)
      if (action === 'archive' && (current?.bound_vm_ids || []).length)
        throw new VendorError('proxy_in_use', '代理仍绑定账号，解除绑定后才能归档', 409)
      const result = proxyPool.setEnabled(poolId, enabled)
      if (!result.ok) throw new VendorError('proxy_not_found', '统一代理池中不存在该代理', 404)
      const updated = platform.updateProxyResource(identity, resourceId, {
        status: action === 'archive' ? 'archived' : enabled ? 'active' : 'paused',
      })
      return { resource: presentVendorProxy(updated), proxy: result.proxy }
    }
    throw new VendorError('invalid_proxy_action', '代理操作不受支持', 400)
  }
  const proxyCommands = createProxyCommandService(vendorProxyAction)

  async function updateVendorAccount(identity, resourceId, body) {
    const platform = vendorPlatform()
    platform.requireCapability(identity, 'vendor.resource.manage')
    const context = accountQueries.runtime(platform, identity, resourceId, { write: true })
    if (body.expected_updated_at && body.expected_updated_at !== context.row.updated_at)
      throw new VendorError('account_config_changed', '账号配置已变化，请重新打开编辑', 409)
    if (
      body.group_ids != null &&
      body.expected_group_version != null &&
      (context.executionKind === 'gateway_worker'
        ? ctx.groupsRepo?.resourceVersion('gateway_worker_account', resourceId)
        : ctx.groupsRepo?.resourceVersion('vm', context.vmId)) !== body.expected_group_version
    )
      throw new VendorError('group_config_changed', '账号分组已变化，请重新打开编辑', 409)
    if (context.row.status === 'archived' || context.linked?.status === 'archived')
      throw new VendorError('resource_archived', '已归档账号不可修改', 409)
    const vm = context.vmId ? getVm(cfg.paths.project, context.vmId) : null
    const gatewayAccount = context.executionKind === 'gateway_worker'
    if (gatewayAccount) {
      if (body.proxy_id && body.proxy_endpoint)
        throw new VendorError('proxy_source_conflict', '请选择已有代理或填写新代理')
      if (body.proxy_source === 'auto' || body.proxy_region)
        throw new VendorError('proxy_source_unsupported', 'Gateway Worker 账号请选择已有代理或填写代理地址')
      if (body.proxy_endpoint) vendorProxyAddress(body.proxy_endpoint)
      if (body.proxy_id) {
        const proxy = platform.getResource(identity, String(body.proxy_id), { write: true })
        if (proxy.resource_type !== 'proxy' || proxy.status !== 'active')
          throw new VendorError('proxy_unavailable', '代理不可用', 409)
      }
      const groupIds =
        body.group_ids == null
          ? null
          : platform.accountGroupIds(identity, body.group_ids, context.config.platform, { requireExplicitGroup: true })
      if (body.status && !identity.system_admin) {
        const policy = platform.db
          .prepare(
            "SELECT allow_runtime FROM vendor_execution_policies WHERE vendor_id IN (?,?) AND platform='openai' AND execution_kind='gateway_worker' ORDER BY vendor_id=? DESC LIMIT 1",
          )
          .get(identity.vendor.id, identity.vendor.parent_id || identity.vendor.id, identity.vendor.id)
        if (!policy?.allow_runtime)
          throw new VendorError('execution_kind_forbidden', '当前供应商未开放 Gateway Worker 运行控制', 403)
      }
      // 换代理时解析出完整地址下发 Worker 并加密保存（心跳投影据此重放）；配置里只留来源与不含认证的地址
      const proxyChanged = !!(body.proxy_id || body.proxy_endpoint)
      const proxyUrl = proxyChanged
        ? vendorDraftProxyUrl(platform, identity, {
            body: { proxy_id: body.proxy_id || '', proxy_endpoint: body.proxy_endpoint || '' },
          })
        : ''
      const proxyEndpoint = proxyUrl ? `${new URL(proxyUrl).protocol}//${new URL(proxyUrl).host}` : ''
      const nextConfig = {
        ...context.config,
        ...(groupIds ? { group_ids: groupIds } : {}),
        ...(proxyChanged
          ? { proxy_id: body.proxy_id || null, proxy_endpoint: body.proxy_id ? null : proxyEndpoint }
          : {}),
      }
      const updated = withTransaction(platform.db, () => {
        const next = platform.updateResource(identity, resourceId, {
          ...(body.status != null ? { status: body.status } : {}),
          ...(body.name != null ? { name: body.name } : {}),
          ...(body.notes != null ? { notes: body.notes } : {}),
        })
        platform.db
          .prepare('UPDATE vendor_resources SET config_json=? WHERE id=?')
          .run(JSON.stringify(nextConfig), resourceId)
        if (proxyChanged) {
          const stored = JSON.parse(
            maybeDecrypt(
              platform.db.prepare('SELECT secret_json FROM vendor_resources WHERE id=?').get(resourceId)?.secret_json,
            ) || '{}',
          )
          platform.db
            .prepare('UPDATE vendor_resources SET secret_json=? WHERE id=?')
            .run(maybeEncrypt(JSON.stringify({ ...stored, proxy_url: proxyUrl })), resourceId)
        }
        if (groupIds && ctx.groupsRepo)
          ctx.groupsRepo.assignResource(
            'gateway_worker_account',
            resourceId,
            groupIds,
            ctx.groupsRepo.resourceVersion('gateway_worker_account', resourceId),
            identity.user_id,
          )
        return { ...next, config: nextConfig }
      })
      // 分组、代理或状态变化时下发完整运行配置（含配置指纹），与心跳投影的期望一致
      const projectable =
        groupIds || proxyUrl || body.status != null ? gatewayWorkerService.projectableAccount(resourceId) : null
      if (projectable) {
        const projected = await gatewayWorkerService.patchAccount(
          resourceId,
          gatewayWorkerService.accountPatch(projectable),
        )
        if (!projected.ok) {
          platform.db
            .prepare(
              "UPDATE gateway_worker_account_bindings SET projection_status='drifted',updated_at=? WHERE account_resource_id=?",
            )
            .run(new Date().toISOString(), resourceId)
          throw new VendorError(
            projected.data?.error?.code || 'gateway_account_sync_failed',
            'Gateway Worker 账号同步失败',
            projected.status || 502,
          )
        }
      }
      if (body.status != null) {
        const action = body.status === 'active' ? 'resume' : 'pause'
        const control = await gatewayWorkerService.accountAction(resourceId, action)
        if (!control.ok)
          throw new VendorError(
            control.data?.error?.code || 'gateway_worker_unavailable',
            'Gateway Worker 账号状态更新失败',
            control.status || 502,
          )
      }
      return updated
    }
    const groupIds =
      body.group_ids == null
        ? null
        : platform.accountGroupIds(identity, body.group_ids, context.config.platform, {
            requireExplicitGroup: true,
          })
    let proxyId = body.proxy_id || null
    if (body.proxy_endpoint && proxyId) throw new VendorError('proxy_source_conflict', '请选择已有代理或填写新代理')
    if (body.proxy_source && !['auto', 'existing', 'new'].includes(body.proxy_source))
      throw new VendorError('invalid_proxy_source', '代理来源无效')
    if (
      (body.proxy_source === 'existing' && (!proxyId || body.proxy_endpoint)) ||
      (body.proxy_source === 'new' && (!body.proxy_endpoint || proxyId)) ||
      (body.proxy_source === 'auto' && (body.proxy_endpoint || proxyId))
    )
      throw new VendorError('proxy_source_conflict', '代理来源与地址不一致')
    if (body.proxy_source === 'auto') {
      const candidates = platform
        .listResources(identity, 'proxy')
        .map(presentVendorProxy)
        .filter(
          (r) =>
            r.status === 'active' &&
            r.config.available !== false &&
            (!body.proxy_region || r.config.region === body.proxy_region),
        )
      candidates.sort(
        (a, b) =>
          (a.config.pool_status === 'ok' ? 0 : 1) - (b.config.pool_status === 'ok' ? 0 : 1) ||
          Number(a.config.bound_count || 0) - Number(b.config.bound_count || 0),
      )
      const found = candidates.find(
        (r) =>
          r.id === context.config.proxy_id ||
          Number(r.config.bound_count || 0) < Number(r.config.bind_limit || proxyPool.bindLimit()),
      )
      if (!found) throw new VendorError('no_vendor_proxy', '当前地区没有可分配的供应商代理', 409)
      proxyId = found.id
    }
    let selectedPoolId = null
    const previousVendorProxyId = String(context.config.proxy_id || '').trim()
    const previousPoolProxyId = previousVendorProxyId
      ? proxyPool.findByVendorResource(previousVendorProxyId)?.id || null
      : null
    let result
    try {
      result = withTransaction(platform.db, () => {
        if (body.proxy_endpoint) {
          assertVendorProxyAvailable(identity, body.proxy_endpoint)
          proxyId = platform.inlineProxy(identity, body.proxy_endpoint).id
        }
        if (proxyId) {
          const own = platform.getResource(identity, proxyId, { write: true })
          if (own.resource_type !== 'proxy' || own.status !== 'active')
            throw new VendorError('proxy_unavailable', '代理不可用', 409)
          selectedPoolId = vendorProxyPoolId(identity, projectResource(own))
          const row = proxyPool.state.proxies.find((p) => p.id === selectedPoolId)
          const view = proxyPool.publicProxy(row)
          if (!view.enabled || view.blocked_reason || ['dead', 'fail', 'expired'].includes(view.status))
            throw new VendorError('proxy_unavailable', '代理不可用', 409)
          if (!vm) throw new VendorError('vm_not_found', '账号运行环境不存在', 409)
        }
        const updated = platform.updateResource(identity, resourceId, {
          ...(body.status != null ? { status: body.status } : {}),
          ...(body.name != null ? { name: body.name } : {}),
          ...(body.notes != null ? { notes: body.notes } : {}),
        })
        const nextConfig = {
          ...updated.config,
          ...(proxyId ? { proxy_id: proxyId } : {}),
          ...(groupIds ? { group_ids: groupIds } : {}),
        }
        platform.db
          .prepare('UPDATE vendor_resources SET config_json=? WHERE id=?')
          .run(JSON.stringify(nextConfig), resourceId)
        if (context.linked) {
          const linkedConfig = {
            ...JSON.parse(context.linked.config_json || '{}'),
            ...(proxyId ? { proxy_id: proxyId } : {}),
          }
          platform.db
            .prepare('UPDATE vendor_resources SET name=?,config_json=? WHERE id=?')
            .run(updated.name, JSON.stringify(linkedConfig), context.linked.id)
        }
        if (groupIds && context.vmId && ctx.groupsRepo)
          ctx.groupsRepo.assignResource(
            'vm',
            context.vmId,
            groupIds,
            ctx.groupsRepo.resourceVersion('vm', context.vmId),
            identity.user_id,
          )
        if (selectedPoolId) {
          const bound = proxyPool.bind(selectedPoolId, context.vmId)
          if (!bound.ok) throw new VendorError('proxy_bind_failed', '代理无法绑定到此账号', 409)
          proxyPool.addPlatform(selectedPoolId, context.config.platform)
          bindVmProxy(cfg.paths.project, context.vmId, proxyPool.getProxyForVm(context.vmId))
        }
        if (vm && body.name != null) patchVmRecord(cfg.paths.project, context.vmId, { name: updated.name })
        if (vm && body.status)
          patchVmRecord(cfg.paths.project, context.vmId, (next) => {
            if (next.schedule_off_reason === 'vendor_paused') {
              delete next.schedule_off
              delete next.schedule_off_reason
            }
            next.vendor_resource_paused = body.status !== 'active'
            return deriveScheduleFields(next, { preserveStatus: true })
          })
        return { ...updated, config: nextConfig }
      })
    } catch (error) {
      proxyPool.reload()
      if (vm) atomicWriteJson(path.join(cfg.paths.project, 'vms', context.vmId + '.json'), vm, { mode: 0o600 })
      throw error
    }
    let applied = true
    if (selectedPoolId) {
      try {
        if (previousPoolProxyId && previousPoolProxyId !== selectedPoolId) {
          const unbound = proxyPool.unbind(previousPoolProxyId, context.vmId)
          if (unbound.ok && !(unbound.proxy?.bound_vm_ids || []).length && egressEnabled())
            stopProxyEgress(cfg.paths.project, previousPoolProxyId)
        }
        if (egressEnabled()) await ensureProxyEgress(cfg.paths.project, proxyPool.getProxyForVm(context.vmId))
        if (process.env.KIN_CRS_MOCK !== '1')
          await syncVmTimezoneFromProxy(cfg.paths.project, proxyPool, context.vmId, { proxyId: selectedPoolId })
        if (vm?.status === 'running' && process.env.KIN_CRS_MOCK !== '1') {
          setScheduleHold(cfg.paths.project, context.vmId, HOLD_MAINTENANCE, { tag: 'proxy_rebind_worker_reload' })
          const ready = await reloadSlotReady(getVm(cfg.paths.project, context.vmId), cfg.paths.project, {
            routing: ctx.routingConfig,
          })
          applied = ready.ok === true
          if (applied) restoreSchedulableIfReady(context.vmId, { by: 'proxy_rebind' })
        }
      } catch {
        applied = false
        if (vm)
          setScheduleHold(cfg.paths.project, context.vmId, HOLD_MAINTENANCE, { tag: 'proxy_rebind_worker_reload' })
      }
    }
    return { ...result, runtime_apply: { ok: applied } }
  }

  async function archiveVendorAccount(identity, resourceId) {
    const platform = vendorPlatform()
    platform.requireCapability(identity, 'vendor.resource.manage')
    const context = accountQueries.runtime(platform, identity, resourceId, { write: true })
    if (context.row.status === 'archived') return projectResource(context.row)
    if (context.executionKind === 'gateway_worker') {
      let paused = null
      try {
        paused = await gatewayWorkerService.accountAction(resourceId, 'pause')
      } catch {}
      const archived = platform.updateResource(identity, resourceId, { status: 'archived' })
      // 只有确认已暂停（或实例上已不存在）的绑定记为 archived；其余记 drifted，由心跳补停用
      const retired = new Set(
        (paused?.results || []).filter((item) => item.ok || item.status === 404).map((item) => item.instance_id),
      )
      const stamp = new Date().toISOString()
      for (const binding of gatewayWorkerService.repo.listAccountBindings(resourceId))
        platform.db
          .prepare('UPDATE gateway_worker_account_bindings SET projection_status=?,updated_at=? WHERE id=?')
          .run(retired.has(binding.gateway_instance_id) ? 'archived' : 'drifted', stamp, binding.id)
      return archived
    }
    const vm = context.vmId ? getVm(cfg.paths.project, context.vmId) : null
    const vmProxyId = vm?.proxy?.id || null
    if (vm) {
      patchVmRecord(cfg.paths.project, context.vmId, (next) => {
        next.schedule_off = true
        next.schedule_off_reason = 'vendor_archived'
        return deriveScheduleFields(next, { preserveStatus: true })
      })
      if (vm.status === 'running' && process.env.KIN_CRS_MOCK !== '1') {
        const stopped = await stopSlot(getVm(cfg.paths.project, context.vmId))
        if (!stopped.ok) throw new VendorError('account_stop_failed', '账号已停止调度，但运行环境停止失败，请重试', 502)
      }
      patchVmRecord(cfg.paths.project, context.vmId, { status: 'stopped' })
    }
    const archived = withTransaction(platform.db, () => {
      const archived = platform.updateResource(identity, resourceId, { status: 'archived' })
      for (const proxy of proxyPool.state.proxies.filter((p) =>
        (p.bound_vm_ids || [p.bound_vm_id]).includes(context.vmId),
      ))
        proxyPool.unbind(proxy.id, context.vmId)
      return archived
    })
    if (vmProxyId && egressEnabled()) {
      const poolProxy = proxyPool.getProxyByIdWithAuth(vmProxyId)
      if (!(poolProxy?.bound_vm_ids || []).length) stopProxyEgress(cfg.paths.project, vmProxyId)
    }
    if (vm) {
      const gone = await destroySlot(vm)
      if (gone.ok) {
        try {
          fs.rmSync(path.join(cfg.paths.project, 'vms', context.vmId), { recursive: true, force: true })
          fs.unlinkSync(path.join(cfg.paths.project, 'vms', context.vmId + '.json'))
          invalidateVmSlotReadCache(cfg.paths.project, context.vmId)
        } catch {}
      }
    }
    return archived
  }

  function assertVendorProxyAvailable(identity, endpoint) {
    const parsed = parseSocks5Line(vendorProxyAddress(endpoint))
    const existing = proxyPool.findSocks(parsed)
    if (existing && existing.vendor_id !== identity.vendor.id)
      throw new VendorError('proxy_vendor_scope_forbidden', '此代理不属于当前供应商', 409)
  }

  function vendorProxyPoolId(identity, resource) {
    const config = resource?.config || {}
    const existing = proxyPool.findByVendorResource(resource.id)
    if (existing) return existing.id
    const secret = vendorPlatform().resourceSecret(identity, resource.id)
    const endpoint = secret.endpoint || config.endpoint
    if (!endpoint) throw new VendorError('proxy_endpoint_missing', '供应商代理地址不存在', 409)
    const parsed = parseSocks5Line(endpoint)
    const ensured = proxyPool.ensureSocks(parsed || {}, {
      vendorId: identity.vendor.id,
      vendorResourceId: resource.id,
      platforms: config.platforms || [],
    })
    if (!ensured.ok) throw new VendorError('proxy_pool_sync_failed', '供应商代理未能加入统一代理池', 409, ensured)
    const poolProxyId = proxyPool.findByVendorResource(resource.id)?.id || ensured.proxy?.id
    if (!poolProxyId) throw new VendorError('proxy_pool_sync_failed', '供应商代理未能加入统一代理池', 409)
    vendorPlatform().setResourcePoolProxy(identity, resource.id, poolProxyId)
    return poolProxyId
  }

  /**
   * Geo-probe through the slot's real exit: its bound SOCKS5, or the local row
   * of the VPS that runs it (control plane, or the node's own route). A local
   * probe refreshes that row's geo, so the pool page shows the same answer.
   */
  async function probeVmExitGeo(vm) {
    const proxy = vm?.proxy || null
    if (!hasBoundExit(proxy)) return { ok: false, code: 'proxy_required', error: '槽位未绑定出口' }
    const blocked = proxyBlockedReason(proxy)
    if (blocked) return { ok: false, code: blocked, error: blocked }
    if (!isLocalEgressProxy(proxy)) {
      const url = boundProxyUrl(proxy)
      if (!url) return { ok: false, code: 'proxy_url_missing', error: 'bound proxy has no URL' }
      const r = await proxyPool.geoLookup(url, { timeoutMs: proxyPool.state?.config?.geo_timeout_ms })
      if (!r?.ok) return { ok: false, code: 'geo_lookup_failed', error: String(r?.error || 'geo lookup failed') }
      return { ok: true, via: 'socks5', proxy_id: proxy.id || null, geo: r.geo }
    }
    const host = slotHost(vm)
    const via = host.nodeId ? 'node' : 'local'
    if (!host.nodeId) {
      // A control-plane Codex slot leaves through the deployment proxy, not the host route.
      let hostUrl = ''
      try {
        hostUrl = host.localExitProxyUrl(vm) || ''
      } catch {}
      if (hostUrl) {
        const r = await proxyPool.geoLookup(hostUrl, { timeoutMs: proxyPool.state?.config?.geo_timeout_ms })
        if (!r?.ok) return { ok: false, code: 'geo_lookup_failed', error: String(r?.error || 'geo lookup failed') }
        return { ok: true, via: 'deploy_proxy', node_id: null, proxy_id: proxy.id || null, geo: r.geo }
      }
    }
    const rowId = localEgressIdForNode(host.nodeId)
    if (proxyPool.getProxyByIdWithAuth(rowId)) {
      const r = await proxyPool.detectGeo(rowId, { force: true })
      if (!r?.ok) return { ok: false, code: 'geo_lookup_failed', error: String(r?.error || 'geo lookup failed') }
      return { ok: true, via, node_id: host.nodeId || null, proxy_id: rowId, geo: r.geo }
    }
    // Local egress never seeded as a row: look up over the host's route directly.
    let url
    try {
      url = host.localExitProxyUrl(vm)
    } catch (err) {
      return { ok: false, code: err?.code || 'node_egress_unavailable', error: String(err?.message || err) }
    }
    const r = await proxyPool.exitGeo(host.nodeId ? `node:${host.nodeId}` : 'local', url, { detect: true, force: true })
    if (!r?.ok) return { ok: false, code: 'geo_lookup_failed', error: String(r?.error || 'geo lookup failed') }
    return { ok: true, via, node_id: host.nodeId || null, proxy_id: proxy.id || null, geo: r.geo }
  }

  async function bringUpImportedVm(id) {
    let vm = getVm(cfg.paths.project, id)
    let startError = null
    if (!vm) return { start_error: 'vm not found', official_cc_bootstrap: null, probe: null }
    if (!hasBoundExit(vm.proxy)) {
      startError = 'no_exit'
    } else {
      const boot = await startSlotReady(vm, cfg.paths.project, { routing: ctx.routingConfig })
      vm = getVm(cfg.paths.project, id) || vm
      if (!boot?.ok) {
        startError = boot?.error || boot?.reason || 'runtime start failed'
        vm =
          (patchVmRecord(cfg.paths.project, id, { status: 'error' }),
          markUnschedulable(cfg.paths.project, id, 'runtime_start_failed', {
            message: String(startError).slice(0, 240),
          }),
          getVm(cfg.paths.project, id)) || vm
      } else {
        vm = patchVmRecord(cfg.paths.project, id, { status: 'running' }) || vm
      }
    }
    vm = getVm(cfg.paths.project, id) || vm
    let bootstrap
    if (startError) bootstrap = { scheduled: false, reason: startError === 'no_exit' ? 'no_exit' : 'start_failed' }
    else if (isCodexVm(vm)) bootstrap = { scheduled: false, reason: 'gpt_slot' }
    else if (!vmHasClaudeCredential(vm)) bootstrap = { scheduled: false, reason: 'no_credential' }
    else if (!canOfficialCc(credentialModeOfVm(vm))) {
      bootstrap = { scheduled: false, reason: 'credential_mode_unsupported' }
    } else {
      bootstrap = scheduleOfficialCcBootstrap({
        vmId: id,
        projectRoot: cfg.paths.project,
        vm,
        force: true,
        manual: true,
        collectIdentity: collectSlotIdentity,
        onStats: officialCcStatsHandler(id, vm.claude?.account_uuid),
        routingFile: routingConfigPath,
        config: ctx.routingConfig?.official_cc,
        credentialMode: credentialModeOfVm(vm),
      })
    }
    const probed = await panel.buildProbeOne({ cfg, accountQuota, id, routingConfig: ctx.routingConfig })
    const probe = probed?.status
      ? { ok: false, error: probed.body?.error?.message || probed.body?.error?.code || 'probe_failed' }
      : { ok: probed?.data?.ok !== false, source: probed?.data?.source || null }
    return { start_error: startError, official_cc_bootstrap: bootstrap, probe }
  }

  function normalizePanelApiKeyInput(body = {}) {
    const allowed = [
      'name',
      'status',
      'max_concurrency',
      'quota_requests',
      'quota',
      'quota_usd',
      'rate_limit_5h',
      'rate_limit_1d',
      'rate_limit_7d',
      'rpm',
      'expires_at',
      'group_id',
      'reset_quota',
      'ip_whitelist',
      'ip_blacklist',
      'peer_sharing',
      'codex_client_profile',
      'codex_route',
    ]
    const normalized = Object.fromEntries(Object.entries(body).filter(([key]) => allowed.includes(key)))
    const hasRequestQuota = Object.prototype.hasOwnProperty.call(body, 'quota_requests')
    const hasLegacyQuota = Object.prototype.hasOwnProperty.call(body, 'quota')
    const hasUsdQuota = Object.prototype.hasOwnProperty.call(body, 'quota_usd')
    delete normalized.quota
    delete normalized.quota_usd
    if (hasRequestQuota || hasLegacyQuota) {
      normalized.quota_requests = hasRequestQuota ? body.quota_requests : body.quota
    }
    if (hasUsdQuota) normalized.quota = body.quota_usd
    return normalized
  }

  function rulesFile() {
    return path.join(cfg.paths.root, 'config', 'intercept-rules.json')
  }

  function reloadRules() {
    try {
      const data = JSON.parse(fs.readFileSync(rulesFile(), 'utf8'))
      cfg.intercept.rules = Array.isArray(data) ? data : data.rules || []
    } catch {
      cfg.intercept.rules = []
    }
    return cfg.intercept.rules
  }

  function distillFile() {
    return path.join(cfg.paths.root, 'config', 'distill-rules.json')
  }

  function reloadDistill() {
    cfg.distill = loadDistillRules(distillFile())
    return cfg.distill
  }

  function refusalGuardSnapshot() {
    const settings = new SettingsRepo()
    const repo = new RefusalGuardsRepo()
    const devices = new RefusalDeviceBlocksRepo()
    const read = (key, fallback) => settings.get(key, fallback)
    return {
      ...refusalGuardPolicy(read),
      count: repo.count(),
      items: repo.list(),
      device_count: devices.count(),
      devices: devices.list(),
    }
  }

  /**
   * Account scope chips for the risk page: one entry per live platform+plan,
   * plus any selected pair that currently has no slot.
   */
  function jevScopeInventory(selectedKeys = []) {
    let vms = []
    try {
      vms = listVms(cfg.paths.project)
    } catch {
      vms = []
    }
    const inventory = buildScopeInventory(
      vms.map((vm) => ({ ...vm, quota: panel.findAccount(accountQuota, vm)?.unified || null })),
      selectedKeys,
    )
    return {
      ...inventory,
      account_type_options: [],
      account_plan_type_options: [],
    }
  }

  function jevInterceptSnapshot() {
    let config
    try {
      const settings = new SettingsRepo()
      config = publicJevConfig(readJevConfig((key, fallback) => settings.get(key, fallback)))
    } catch {
      config = publicJevConfig(null)
    }
    return { ...config, account_scope: jevScopeInventory(config.account_platform_plans) }
  }

  function deactivateVmSlot(id) {
    if (getActiveVmId(cfg.paths.project) === id) {
      clearActiveVmFromDb()
      clearActiveVm(cfg.paths.project)
      reloadActiveVm(cfg)
    }
    return { ok: true, active_vm: getActiveVmId(cfg.paths.project) }
  }

  function activateVmSlot(id) {
    setActiveVm(cfg.paths.project, id)
    reloadActiveVm(cfg)
    const vm = getVm(cfg.paths.project, id)
    accountQuota.ensure({
      account_id: vm?.account_uuid || vm?.claude?.account_uuid || id,
      vm_id: id,
      email: vm?.email || vm?.codex?.email || vm?.claude?.email || null,
      type: normalizeCredentialMode(vm?.claude?.mode),
      max_concurrency: vm?.policy?.maxConcurrency || 2,
      max_rpm: vm?.policy?.maxRpm ?? 0,
    })
    return {
      ok: true,
      active_vm: id,
      runtime: GATEWAY_CAPABILITIES.runtime,
      kernel: GATEWAY_CAPABILITIES.kernel,
    }
  }

  function workerExecForVm(id) {
    const vm = getVm(cfg.paths.project, id)
    if (!vm) return null
    return {
      vmId: id,
      accountId: vm.claude?.account_uuid || id,
      vm,
      homeDir: path.join(cfg.paths.project, 'vms', id, 'cli-home'),
      vmPath: path.join(cfg.paths.project, 'vms', `${id}.json`),
    }
  }

  async function panelKernelHealth({ id }) {
    const exec = workerExecForVm(id)
    const vm = exec?.vm || getVm(cfg.paths.project, id)
    if (!exec || !vm) {
      const missing = { reachable: false, status: null, error_code: 'vm_not_found' }
      return { go: missing, rust: missing }
    }
    if (isCodexVm(vm)) {
      const health = await codexKernelHealth(exec, { timeoutMs: 600 })
      return {
        codex: {
          ...toPublicKernelHealth(health, 'codex'),
          proxy_ok: health?.proxy_ok ?? null,
          accounts: health?.accounts ?? null,
          vm_id: health?.vm_id || id,
        },
      }
    }
    const rust = await rustKernelHealth(exec, { timeoutMs: 600 })
    return {
      rust: toPublicKernelHealth(rust, 'rust'),
    }
  }

  function vmWithSlotPolicyPatch(vm, patch) {
    const desired = structuredClone(vm)
    if (Object.prototype.hasOwnProperty.call(patch, 'inference_engine')) {
      if (patch.inference_engine) desired.inference_engine = patch.inference_engine
      else delete desired.inference_engine
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'persona_preset')) {
      if (patch.persona_preset) desired.persona_preset = patch.persona_preset
      else delete desired.persona_preset
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'dataplane')) {
      if (patch.dataplane) desired.dataplane = patch.dataplane
      else delete desired.dataplane
    }
    return desired
  }

  async function applySlotPolicyWithRuntime(id, patch) {
    const current = getVm(cfg.paths.project, id)
    if (!current) return { ok: false, id, code: 'vm_not_found', error: 'vm not found' }
    const desired = vmWithSlotPolicyPatch(current, patch)
    const previousEngine = resolveInferenceEngine(current, ctx.routingConfig)
    const targetEngine = resolveInferenceEngine(desired, ctx.routingConfig)
    const previousDataplane = resolveKernelDataplane(current, ctx.routingConfig)
    const targetDataplane = resolveKernelDataplane(desired, ctx.routingConfig)
    let switched = null
    if (Object.prototype.hasOwnProperty.call(patch, 'inference_engine') && previousEngine !== targetEngine) {
      switched = await switchSlotInferenceEngine(desired, cfg.paths.project, targetEngine)
      if (!switched.ok) {
        return { ok: false, id, code: switched.code || 'engine_switch_failed', error: switched.error, switch: switched }
      }
    }
    try {
      const saved = persistSlotEnginePolicy(cfg.paths.project, id, patch)
      if (!saved) return { ok: false, id, code: 'vm_not_found', error: 'vm not found' }
      if (
        !isCodexVm(saved) &&
        (Object.prototype.hasOwnProperty.call(patch, 'persona_preset') || previousDataplane !== targetDataplane)
      ) {
        if (previousDataplane !== targetDataplane) {
          const laid = materializeSlotDataplane(cfg.paths.project, saved, targetDataplane || 'wrap')
          if (!laid.ok) {
            persistSlotEnginePolicy(cfg.paths.project, id, { dataplane: current.dataplane || '' })
            return { ok: false, id, code: laid.code || 'dataplane_materialize_failed', error: laid.error }
          }
        }
        writeKernelConfig(cfg.paths.project, saved, { routing: ctx.routingConfig })
        if (previousDataplane !== targetDataplane && saved.status === 'running') {
          const exec = slotExec(cfg.paths.project, saved)
          const restarted = await restartRustKernel(exec).catch((e) => ({
            ok: false,
            error: String(e?.message || e).slice(0, 200),
          }))
          if (!restarted?.ok) {
            return {
              ok: false,
              id,
              code: 'kernel_restart_failed',
              error: restarted?.error || 'kernel restart failed',
            }
          }
        }
      }
      return {
        ok: true,
        id,
        vm: saved,
        configured_engine: saved.inference_engine || null,
        resolved_engine: resolveInferenceEngine(saved, ctx.routingConfig),
        dataplane: saved.dataplane || null,
        resolved_dataplane: resolveKernelDataplane(saved, ctx.routingConfig),
        active_engine: switched?.active_engine || targetEngine,
        runtime: switched?.runtime || null,
      }
    } catch (error) {
      let rollback = null
      if (switched) rollback = await switchSlotInferenceEngine(current, cfg.paths.project, previousEngine)
      return {
        ok: false,
        id,
        code: rollback && !rollback.ok ? 'engine_switch_rollback_failed' : 'engine_persist_failed',
        error: String(error?.message || error),
        rollback,
      }
    }
  }

  function projectSlotKernelConfig(vm) {
    if (!vm?.id || isCodexVm(vm)) return null
    const full = getVm(cfg.paths.project, vm.id) || vm
    return writeKernelConfig(cfg.paths.project, full, {
      routing: ctx.routingConfig,
      timezone: full.timezone,
    })
  }

  function restoreRoutingRuntime(previous) {
    ctx.routingConfig = previous
    const revision = currentConfigRevision()
    if (ctx.publishRuntimeSnapshot) ctx.publishRuntimeSnapshot(previous, revision)
    else ctx.runtimeSnapshot?.publish?.(previous, revision)
    ctx.healthMonitor?.setConfig(ctx.routingConfig.health_probe)
    ctx.usageProbeMonitor?.setConfig(ctx.routingConfig.usage_probe)
    ctx.notifyMonitor?.setConfig(ctx.routingConfig.notify)
    if (ctx.routingConfig.logging) {
      requestLog.setConfig({
        mode: ctx.routingConfig.logging.mode,
        retainDays: ctx.routingConfig.logging.retain_days,
        debugRetainDays: ctx.routingConfig.logging.debug_retain_days,
        maxMb: ctx.routingConfig.logging.max_mb,
        mutedErrorClasses: ctx.routingConfig.logging.muted_error_classes,
      })
    }
    stickyRouter.reloadConfig(ctx.routingConfig)
    accountQuota.reloadConfig(ctx.routingConfig)
    ctx.poolScheduler?.reloadConfig?.(poolSchedulerConfig())
  }

  async function prepareInheritedInferenceEngine(body) {
    if (!body?.inference) return { ok: true, changed: false, items: [] }
    const previous = normalizeInferenceConfig(ctx.routingConfig.inference || {}).engine
    const target = normalizeInferenceConfig({ ...(ctx.routingConfig.inference || {}), ...body.inference }).engine
    if (previous === target) return { ok: true, changed: false, items: [] }
    const previousRoutingConfig = structuredClone(ctx.routingConfig)
    return switchInheritedInferenceEngines({
      projectRoot: cfg.paths.project,
      previousEngine: previous,
      targetEngine: target,
      commit: () => {
        try {
          return persistRoutingPatch(body)
        } catch (error) {
          restoreRoutingRuntime(previousRoutingConfig)
          if (body.pool || body.failover) initPoolRuntime()
          throw error
        }
      },
    })
  }

  async function oauthStatusWithWorker(id = null) {
    const vmId = id || getActiveVmId(cfg.paths.project)
    const exec = workerExecForVm(vmId)
    if (!exec) return { ok: false, vm_id: vmId, error: 'vm_not_found' }
    const health = await rustKernelHealth(exec)
    return {
      ok: !!health.ok,
      vm_id: vmId,
      refresh_owner: 'go-slot-worker',
      proxy_required: true,
      worker: health,
      credential: health.credential || null,
    }
  }

  // Supplier account list, usage and portal views poll every 15s and need buildUsage's account rows, whose
  // billing aggregation takes 1–2s; they share one snapshot (see shared-snapshot.mjs for the freshness rule).
  const accountUsageRows = createSharedSnapshot(
    async () => (await panel.buildUsage({ accountQuota, cfg, requestLog }))?.data?.accounts || [],
  )

  async function readUsage(kind, method, args) {
    if (!usagePoolEnabled()) return null
    try {
      return await usageRead({
        kind,
        method,
        args,
        mutedErrorClasses: requestLog?.mutedErrorClasses || [],
      })
    } catch (err) {
      console.warn(`[sqlite-pool] ${kind}.${method}: ${err?.message || err}`)
      return null
    }
  }

  return async function handlePanel(req, res, url) {
    const p = url.pathname
    const json = (response, status, value) => ctx.json(response, status, projectPanelUsage(req, p, value))
    const vendorJson = (status, data) =>
      ctx.json(res, status, { ok: status < 400, ...(status < 400 ? { data } : { error: data }) })
    const vendorError = (error) => ({
      code: error.code || 'vendor_error',
      message: error.message || '供应商请求失败',
      ...(error.details ? { details: error.details } : {}),
    })
    const isVendorPath = p.startsWith('/api/vendor') || p.startsWith('/api/admin/vendors')
    if (!p.startsWith('/admin') && !p.startsWith('/api/panel') && !isVendorPath) return false

    if (isVendorPath) {
      if (!requireAuth(req, res)) return true
      const platform = vendorPlatform()
      try {
        const admin = p.startsWith('/api/admin/vendors')
        const actor = req.panelUserId || 'master'
        if (admin && panelIdentity(req).role !== 'super_admin')
          throw new VendorError('forbidden', '只有超级管理员可以管理供应商', 403)
        const resourcePath = admin ? p.replace('/api/admin/vendors', '/api/vendor') : p
        let identity = null
        const presentAccounts = async (rows) =>
          accountPortalRows(platform, rows, {
            usageAccounts: await accountUsageRows(),
            readVm: (id) => {
              const vm = getVm(cfg.paths.project, id)
              if (!vm) return null
              return {
                schedulable: vm.schedulable,
                summary: summarizeVm(vm, cfg.paths.project, ctx.routingConfig),
              }
            },
          })
        if (admin) {
          const query = Object.fromEntries(url.searchParams.entries())
          if (p === '/api/admin/vendors/pricing' && req.method === 'GET')
            return vendorJson(200, listGlobalPricing(platform))
          if (p === '/api/admin/vendors/pricing' && req.method === 'POST')
            return vendorJson(
              201,
              createGlobalPricing(platform, { system_admin: true, user_id: actor }, await readBody(req, 16384)),
            )
          if (req.method === 'GET' && p === '/api/admin/vendors') return vendorJson(200, adminVendors(platform))
          if (req.method === 'GET' && p === '/api/admin/vendors/account-groups') {
            const vendorId = String(query.vendor_id || '').trim()
            const rawPlatform = String(query.platform || '').trim() || 'anthropic'
            const requestedPlatform = { claude: 'anthropic', codex: 'openai' }[rawPlatform] || rawPlatform
            if (!vendorId) throw new VendorError('vendor_required', '请选择供应商')
            if (!['anthropic', 'openai'].includes(requestedPlatform))
              throw new VendorError('platform_invalid', '不支持的平台')
            const identity = adminVendorIdentity(platform, vendorId, actor)
            return vendorJson(200, {
              items: platform.availableAccountGroups(identity, requestedPlatform).map((group) => ({
                id: group.id,
                name: group.name,
                platform: group.platform,
                supported_platforms: [requestedPlatform],
              })),
            })
          }
          if (req.method === 'POST' && p === '/api/admin/vendors') {
            const body = await readBody(req, 32 * 1024)
            rejectInlinePricing(body)
            const created = withTransaction(platform.db, () => {
              let userId = body.user_id
              if (userId) {
                const user = platform.db.prepare('SELECT role FROM users WHERE id=? AND deleted_at IS NULL').get(userId)
                if (
                  !user ||
                  !['user', 'vendor'].includes(user.role) ||
                  platform.db.prepare("SELECT 1 FROM vendor_members WHERE user_id=? AND status='active'").get(userId)
                )
                  throw new VendorError('invalid_member', '请选择未绑定供应商的普通账号')
              } else {
                const user = panelUsers.create({
                  username: body.username,
                  password: body.password,
                  role: 'vendor',
                  actor: panelIdentity(req).user,
                  actorId: req.panelUserId,
                })
                userId = user.id
              }
              const vendor = platform.createRoot({ actorUserId: actor, userId, body })
              // Validate editable policy and monetary fields in the same transaction as login creation.
              const editable = Object.fromEntries(
                Object.entries(body).filter(([key]) =>
                  [
                    'groups',
                    'platforms',
                    'account_limit',
                    'proxy_limit',
                    'child_limit',
                    'remark',
                    'create_child',
                    'settlement_pay',
                  ].includes(key),
                ),
              )
              return updateAdminVendor(platform, vendor.id, editable, actor)
            })
            return vendorJson(201, created)
          }
          if (req.method === 'GET' && ['/api/admin/vendors/accounts', '/api/admin/vendors/proxies'].includes(p)) {
            const accounts = p.endsWith('/accounts')
            const rows = adminResources(platform, accounts ? 'account' : 'proxy', query)
            return vendorJson(
              200,
              accounts ? filterAccountRows(await presentAccounts(rows), query) : rows.map(presentVendorProxy),
            )
          }
          if (
            req.method === 'POST' &&
            [
              '/api/admin/vendors/proxies/probe',
              '/api/admin/vendors/proxies/quality-check',
              '/api/admin/vendors/proxies/geo',
            ].includes(p)
          ) {
            const body = await readBody(req, 16 * 1024)
            const action = p.endsWith('/probe') ? 'probe' : p.endsWith('/quality-check') ? 'quality' : 'geo'
            const rows = adminResources(platform, 'proxy', {
              vendor_id: body.vendor_id || query.vendor_id || 'all',
            })
            const results = []
            for (const resource of rows) {
              const identity = adminVendorIdentity(platform, resource.vendor_id, actor)
              try {
                results.push({ id: resource.id, ...(await proxyCommands.action(identity, resource.id, action)) })
              } catch (error) {
                results.push({ id: resource.id, ok: false, error: error.code || 'proxy_action_failed' })
              }
            }
            return vendorJson(200, { action, total: results.length, results })
          }
          const proxyAction = p.match(
            /^\/api\/admin\/vendors\/proxies\/([^/]+)\/(probe|quality-check|geo|enable|disable|archive)$/,
          )
          if (proxyAction && req.method === 'POST') {
            const row = platform.db
              .prepare("SELECT vendor_id FROM vendor_resources WHERE id=? AND resource_type='proxy'")
              .get(proxyAction[1])
            if (!row) throw new VendorError('resource_not_found', '代理资源不存在', 404)
            const identity = adminVendorIdentity(platform, row.vendor_id, actor)
            const action = proxyAction[2] === 'quality-check' ? 'quality' : proxyAction[2]
            return vendorJson(200, await proxyCommands.action(identity, proxyAction[1], action))
          }
          if (req.method === 'GET' && p === '/api/admin/vendors/usage') {
            const resources = adminResources(platform, 'account', {
              vendor_id: query.vendor_id || 'all',
              include_children: true,
            })
            // The report runs on a pool worker while account statuses are built on this thread.
            const [report, presented] = await Promise.all([
              usageQueries.admin(platform.db, vendorIds(platform, query.vendor_id), query),
              presentAccounts(resources),
            ])
            const statuses = new Map(presented.map((account) => [account.id, account]))
            return vendorJson(200, {
              ...report,
              accounts: report.accounts.map((account) => ({
                ...account,
                status: statuses.get(account.resource_id)?.status || account.resource_status || null,
                telemetry: statuses.get(account.resource_id)?.telemetry,
              })),
            })
          }
          if (req.method === 'GET' && p === '/api/admin/vendors/settlements')
            return vendorJson(200, listSettlements(platform, query))
          if (
            req.method === 'POST' &&
            ['/api/admin/vendors/settlements', '/api/admin/vendors/settlements/preview'].includes(p)
          ) {
            const body = await readBody(req, 16 * 1024)
            return vendorJson(
              p.endsWith('/preview') ? 200 : 201,
              p.endsWith('/preview')
                ? settlementQueries.adminPreview(platform, String(body.vendor_id || ''), body)
                : settlementCommands.createAdmin(platform, String(body.vendor_id || ''), body, actor),
            )
          }
          const settlementMatch = p.match(/^\/api\/admin\/vendors\/settlements\/([^/]+)\/(confirm|payments|void)$/)
          if (settlementMatch && req.method === 'POST')
            return vendorJson(
              200,
              settlementCommands.actionAdmin(
                platform,
                settlementMatch[1],
                settlementMatch[2],
                await readBody(req, 16 * 1024),
                actor,
              ),
            )
          const vendorMatch = p.match(/^\/api\/admin\/vendors\/([^/]+)$/)
          if (vendorMatch && !['accounts', 'proxies', 'usage', 'settlements'].includes(vendorMatch[1])) {
            if (req.method === 'GET')
              return vendorJson(200, adminVendorIdentity(platform, vendorMatch[1], actor).vendor)
            if (req.method === 'PATCH') {
              const body = await readBody(req, 16 * 1024)
              const updated = updateAdminVendor(platform, vendorMatch[1], body, actor)
              if (body.status) {
                for (const account of adminResources(platform, 'account', {
                  vendor_id: updated.id,
                  include_children: true,
                })) {
                  const pair = platform.db
                    .prepare('SELECT config_json FROM vendor_resources WHERE id=? AND vendor_id=?')
                    .get(account.config.vm_resource_id, account.vendor_id)
                  const vmId = pair && JSON.parse(pair.config_json).runtime_vm_id
                  if (!vmId) continue
                  const owner = platform.getVendor(account.vendor_id)
                  const parent = owner.parent_id ? platform.getVendor(owner.parent_id) : null
                  patchVmRecord(cfg.paths.project, vmId, (vm) => {
                    vm.vendor_disabled = owner.status !== 'active' || (!!parent && parent.status !== 'active')
                    return deriveScheduleFields(vm, { preserveStatus: true })
                  })
                }
              }
              return vendorJson(200, updated)
            }
          }
          const scopedResource = resourcePath.match(
            /^\/api\/vendor\/(accounts|proxies)(?:\/([^/]+))?(?:\/(pause|resume|usage|groups|cooldown\/clear|profile\/refresh|bps(?:\/(?:import|models|unblock|recovery\/stop))?|gateway-drafts(?:\/[^/]+\/(?:oauth\/generate-auth-url|oauth\/exchange-code|import))?))?$/,
          )
          if (!scopedResource) throw new VendorError('not_found', '供应商管理接口不存在', 404)
          let vendorId = query.vendor_id
          if (scopedResource[2]) {
            const resource = platform.db
              .prepare('SELECT vendor_id FROM vendor_resources WHERE id=? AND resource_type=?')
              .get(scopedResource[2], scopedResource[1] === 'accounts' ? 'account' : 'proxy')
            if (!resource) throw new VendorError('resource_not_found', '资源不存在', 404)
            if (vendorId && vendorId !== resource.vendor_id)
              throw new VendorError('vendor_scope_forbidden', '资源与供应商不匹配', 403)
            vendorId = resource.vendor_id
          }
          if (!vendorId) throw new VendorError('vendor_required', '请选择供应商')
          identity = adminVendorIdentity(platform, vendorId, actor)
        } else identity = platform.identity(req.panelUserId)

        // Supplier onboarding keeps all form data in an authorization draft. No
        // vendor resource or runtime VM is created until the credential exchange
        // has completed successfully.
        if (!admin && p === '/api/vendor/account-drafts' && req.method === 'POST') {
          const body = normalizeVendorDraft(platform, identity, await readBody(req, 32 * 1024))
          const draft = accountCommands.createDraft(identity, body)
          const reusedAccount = draft.result?.account?.id
            ? platform.db
                .prepare("SELECT status FROM vendor_resources WHERE id=? AND resource_type='account'")
                .get(draft.result.account.id)
            : null
          if (draft.result?.account?.status === 'archived' || reusedAccount?.status === 'archived')
            throw new VendorError('resource_archived', '账号已归档，不能重试开户', 409)
          if (draft.result)
            return vendorJson(200, { ...draft.result, reused: true, draft: accountCommands.projectDraft(draft) })
          return vendorJson(201, {
            draft: accountCommands.projectDraft(draft),
            vm: { id: '', platform: body.platform, family: body.platform === 'openai' ? 'codex' : 'claude' },
            provisioning: { state: 'awaiting_authorization', schedulable: false },
          })
        }
        if (!admin) {
          const draftAuth = p.match(
            /^\/api\/vendor\/account-drafts\/([^/]+)\/oauth\/(generate-auth-url|exchange-code)$/,
          )
          const draftImport = p.match(/^\/api\/vendor\/account-drafts\/([^/]+)\/import$/)
          if (draftAuth || draftImport) {
            const draftId = (draftAuth || draftImport)[1]
            const draft = accountCommands.requireDraft(identity, draftId)
            const proxyUrl = vendorDraftProxyUrl(platform, identity, draft)
            const fetchImpl = makeProxyFetch(proxyUrl || undefined)
            if (draftAuth?.[2] === 'generate-auth-url' && req.method === 'POST') {
              const body = await readBody(req, 8 * 1024)
              if (draft.body.platform === 'openai') {
                if (draft.body.execution_kind === 'gateway_worker') {
                  // PKCE 会话只存在于生成链接的实例上，换票必须回到同一实例
                  const instance = gatewayWorkerService.repo.pickInstance()
                  if (!instance) throw new VendorError('gateway_worker_unavailable', '暂无可用 Gateway Worker', 503)
                  const generated = await gatewayWorkerService.oauthStart(
                    {
                      draft_id: draftId,
                      runtime_account_id: `gwacct_${draftId}`,
                      proxy_url: proxyUrl,
                      idempotency_key: draft.body.idempotency_key || `vendor-draft:${draftId}`,
                    },
                    instance.id,
                  )
                  if (!generated?.ok)
                    throw new VendorError(
                      generated.data?.error?.code || 'gateway_worker_unavailable',
                      'Gateway Worker OAuth 初始化失败',
                      generated.status || 502,
                    )
                  if (generated.data?.session_id) {
                    platform.db
                      .prepare(
                        `INSERT INTO gateway_worker_oauth_sessions(session_id,account_resource_id,actor_user_id,gateway_instance_id,state_hash,provider,status,idempotency_key,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,'openai','pending',?,?,?,?) ON CONFLICT(gateway_instance_id,idempotency_key) DO UPDATE SET session_id=excluded.session_id,state_hash=excluded.state_hash,status='pending',expires_at=excluded.expires_at,updated_at=excluded.updated_at`,
                      )
                      .run(
                        generated.data.session_id,
                        null,
                        identity.user_id,
                        instance.id,
                        generated.data.state_hash ||
                          crypto.createHash('sha256').update(generated.data.session_id).digest('hex'),
                        draft.body.idempotency_key || `vendor-draft:${draftId}`,
                        generated.data.expires_at,
                        new Date().toISOString(),
                        new Date().toISOString(),
                      )
                  }
                  return vendorJson(200, generated.data)
                }
                const generated = generateCodexAuthUrl({ draftId, proxyUrl, installationId: null })
                return vendorJson(200, generated)
              }
              const flavor = body.flavor || body.type || 'cai'
              if (normalizeOauthFlavor(flavor) === 'claude_code')
                throw new VendorError(
                  'claude_code_requires_vm',
                  '官方 Claude Code 授权需要 VM 启动后执行，请改用 OAuth 或 Setup Token',
                )
              return vendorJson(200, generateAuthUrl({ draftId, proxyUrl, flavor }))
            }
            if (draftAuth?.[2] === 'exchange-code' && req.method === 'POST') {
              const body = await readBody(req, 16 * 1024)
              let credential
              if (draft.body.platform === 'openai') {
                if (draft.body.execution_kind === 'gateway_worker') {
                  const idempotencyKey = draft.body.idempotency_key || `vendor-draft:${draftId}`
                  const session = platform.db
                    .prepare(
                      'SELECT gateway_instance_id,actor_user_id,idempotency_key FROM gateway_worker_oauth_sessions WHERE session_id=?',
                    )
                    .get(String(body.session_id || body.sessionId || ''))
                  if (
                    !session ||
                    String(session.actor_user_id) !== String(identity.user_id) ||
                    session.idempotency_key !== idempotencyKey
                  )
                    throw new VendorError('oauth_session_mismatch', '授权会话不属于当前草稿，请重新生成授权链接', 409)
                  // Gateway Worker 只接受带 code 与 state 的完整回调链接，不能绕过 state 校验只交 code
                  const callback = String(
                    body.callback || body.callback_url || body.code || body.auth_code || '',
                  ).trim()
                  if (!/^https?:\/\//i.test(callback))
                    throw new VendorError('oauth_callback_required', '请粘贴包含 code 和 state 的完整回调链接', 400)
                  const completed = await gatewayWorkerService.oauthComplete(
                    {
                      session_id: body.session_id || body.sessionId,
                      callback,
                      draft_id: draftId,
                      expected_credential_revision: Number(body.expected_credential_revision ?? 0),
                      idempotency_key: idempotencyKey,
                    },
                    session.gateway_instance_id,
                  )
                  if (!completed?.ok)
                    throw new VendorError(
                      completed.data?.error?.code || 'oauth_exchange_failed',
                      'Gateway Worker OAuth 换票失败',
                      completed.status || 502,
                    )
                  credential = {
                    ...(completed.data?.account || {}),
                    ...(completed.data?.identity || {}),
                    runtime_account_id: completed.data?.account?.id,
                    credential_revision: completed.data?.credential_revision,
                    gateway_instance_id: completed.data?.gateway_instance_id || session.gateway_instance_id,
                    worker_authorized: true,
                  }
                  try {
                    platform.db
                      .prepare(
                        "UPDATE gateway_worker_oauth_sessions SET status='completed',result_json=?,updated_at=? WHERE session_id=?",
                      )
                      .run(
                        JSON.stringify({
                          identity: completed.data?.identity || {},
                          credential_revision: completed.data?.credential_revision || null,
                        }),
                        new Date().toISOString(),
                        body.session_id || body.sessionId,
                      )
                  } catch {}
                } else {
                  credential = await exchangeCodexAuthCode({
                    sessionId: body.session_id || body.sessionId,
                    code: body.code || body.auth_code || body.callback || body.callback_url,
                    proxyUrl,
                    draftId,
                    fetchImpl,
                  })
                }
              } else {
                credential = await exchangeAuthCode({
                  sessionId: body.session_id || body.sessionId,
                  code: body.code || body.auth_code || '',
                  proxyUrl,
                  draftId,
                  fetchImpl,
                })
                if (body.auth_scheme || body.authScheme) credential.auth_scheme = body.auth_scheme || body.authScheme
                if (credential.access_token) credential = await enrichOauthIdentity(credential, { proxyUrl, fetchImpl })
              }
              accountCommands.authorizeDraft(identity, draftId, credential)
              const result = await finalizeVendorDraft(identity, draft)
              return vendorJson(200, { ...result, draft: accountCommands.projectDraft(draft) })
            }
            if (draftImport && req.method === 'POST') {
              const body = await readBody(req, 1024 * 1024)
              let credential
              if (draft.body.platform === 'openai') {
                const parsed = parseCodexImportPayload(body)
                if (!parsed.ok)
                  throw new VendorError(parsed.error || 'invalid_codex_credential', parsed.message || 'Codex 凭证无效')
                credential = { ...parsed.account }
                if (!credential.access_token && credential.refresh_token) {
                  const refreshed = await refreshCodexAccessToken({
                    refreshToken: credential.refresh_token,
                    proxyUrl,
                    fetchImpl,
                  })
                  if (!refreshed.ok) throw new VendorError('refresh_failed', 'Refresh Token 换票失败', 502)
                  Object.assign(credential, refreshed)
                }
              } else {
                const sessionKey = String(body.sessionKey || body.session_key || body.sid || '').trim()
                const accessToken = String(body.access_token || body.token || '').trim()
                const apiKey = String(body.api_key || body.apiKey || '').trim()
                const wantsApiKey =
                  looksLikeConsoleApiKey(apiKey || sessionKey || accessToken) ||
                  String(body.type || body.credential_mode || '').toLowerCase() === 'apikey'
                if (wantsApiKey) {
                  if (!looksLikeConsoleApiKey(apiKey || sessionKey || accessToken))
                    throw new VendorError('invalid_api_key', '需要 sk-ant-api03-… Console API Key')
                  credential = {
                    type: 'apikey',
                    mode: 'apikey',
                    api_key: apiKey || sessionKey || accessToken,
                    access_token: apiKey || sessionKey || accessToken,
                    base_url: body.base_url || body.baseUrl || 'https://api.anthropic.com',
                    source: 'console-api-key',
                    auth_scheme: body.auth_scheme || body.authScheme,
                  }
                } else if (sessionKey) {
                  credential = await sessionKeyToOAuth(sessionKey, {
                    proxyUrl,
                    fetchImpl,
                    scope: String(body.scope || body.type || '')
                      .toLowerCase()
                      .includes('inference')
                      ? 'inference'
                      : 'full',
                  })
                } else if (accessToken) {
                  credential = pastedAccessTokenToOauth(accessToken, body)
                } else {
                  throw new VendorError('credential_required', '请填写授权凭证')
                }
                if (credential.access_token && credential.type !== 'apikey')
                  credential = await enrichOauthIdentity(credential, { proxyUrl, fetchImpl })
              }
              accountCommands.authorizeDraft(identity, draftId, credential)
              const result = await finalizeVendorDraft(identity, draft)
              return vendorJson(200, { ...result, draft: accountCommands.projectDraft(draft) })
            }
            throw new VendorError('method_not_allowed', '请求方法不受支持', 405)
          }
        }
        if (req.method === 'GET' && p === '/api/vendor/billing')
          return vendorJson(200, settlementQueries.supplierBilling(platform, identity))
        if (req.method === 'GET' && p === '/api/vendor/usage')
          return vendorJson(
            200,
            await usageQueries.supplier(platform, identity, Object.fromEntries(url.searchParams.entries())),
          )
        if (req.method === 'POST' && p === '/api/vendor/settlements/preview') {
          return vendorJson(
            200,
            settlementCommands.previewDownstream(platform, identity, await readBody(req, 32 * 1024)),
          )
        }
        const vendorBillAction = p.match(/^\/api\/vendor\/settlements\/([^/]+)\/(confirm|payments|void)$/)
        if (vendorBillAction && req.method === 'POST') {
          return vendorJson(
            200,
            settlementCommands.mutateDownstream(
              platform,
              identity,
              vendorBillAction[1],
              vendorBillAction[2],
              await readBody(req, 8192),
            ),
          )
        }
        if (req.method === 'POST' && p === '/api/vendor/settlements') {
          const body = await readBody(req, 32 * 1024)
          return vendorJson(201, settlementCommands.createDownstream(platform, identity, body))
        }
        if (req.method === 'GET' && p === '/api/vendor/me')
          return vendorJson(200, {
            user_id: identity.user_id,
            vendor: identity.vendor,
          })
        if (req.method === 'GET' && p === '/api/vendor/vendors') {
          platform.requireCapability(identity, 'vendor.create_child')
          return vendorJson(200, platform.listVendors(identity))
        }
        if (req.method === 'POST' && p === '/api/vendor/vendors') {
          const body = await readBody(req, 32 * 1024)
          if (body.user_id != null) throw new VendorError('member_binding_forbidden', '请创建独立的供应商登录账号', 403)
          return vendorJson(201, platform.createChild(identity, body))
        }
        const accountAction = resourcePath.match(
          /^\/api\/vendor\/accounts\/([^/]+)\/(usage|groups|cooldown\/clear|profile\/refresh)$/,
        )
        const gatewayAction = resourcePath.match(
          /^\/api\/vendor\/accounts\/([^/]+)\/(pause|resume|refresh|recover|reauthorize|test|quota)$/,
        )
        // 账号归属、执行方式、未归档与 Gateway 运行控制策略（超管不受供应商策略限制）
        const requireGatewayRuntime = (accountId) => {
          platform.requireCapability(identity, 'vendor.resource.manage')
          const linked = accountQueries.runtime(platform, identity, accountId, { write: true })
          if (linked.executionKind !== 'gateway_worker')
            throw new VendorError('execution_kind_mismatch', '该账号不是 Gateway Worker 账号', 409)
          if (linked.row.status === 'archived') throw new VendorError('resource_archived', '已归档账号不可修改', 409)
          if (!identity.system_admin) {
            const policy = platform.db
              .prepare(
                "SELECT allow_runtime FROM vendor_execution_policies WHERE vendor_id IN (?,?) AND platform='openai' AND execution_kind='gateway_worker' ORDER BY vendor_id=? DESC LIMIT 1",
              )
              .get(identity.vendor.id, identity.vendor.parent_id || identity.vendor.id, identity.vendor.id)
            if (!policy?.allow_runtime)
              throw new VendorError('execution_kind_forbidden', '当前供应商未开放 Gateway Worker 运行控制', 403)
          }
          return linked
        }
        // BPS 附加授权（Gateway 账号）：查看、保存设置、导入授权文件、撤销；授权链接复用 gateway-drafts（authorization_kind=bps_oauth）
        const bpsRoute = resourcePath.match(
          /^\/api\/vendor\/accounts\/([^/]+)\/bps(?:\/(import|models|unblock|recovery\/stop))?$/,
        )
        if (bpsRoute) {
          const id = bpsRoute[1]
          requireGatewayRuntime(id)
          const manager = vendorGatewayAccounts()
          const actor = `vendor:${identity.vendor?.id || 'system'}:${identity.user_id}`
          const view = () => {
            const account = manager.account(id)
            return {
              id: account.id,
              name: account.name,
              bps: account.config.bps || null,
              bps_grant: account.config.bps_grant || null,
              bps_state: account.bps_state || null,
              bps_error: account.bps_error || null,
              bps_blocked_at: account.bps_blocked_at || null,
              bps_recovery: account.bps_recovery || null,
              bps_next_probe_at: account.bps_next_probe_at || null,
              bps_cooldown_until: account.bps_cooldown_until || null,
              groups: manager.availableGroups(account).map((group) => ({ id: group.id, name: group.name })),
              bps_probes: manager.repo.listBpsProbes(account.id, 10),
              bps_catalog: account.config.bps_catalog || null,
              bps_verification: account.config.bps_verification || null,
            }
          }
          try {
            if (!bpsRoute[2] && req.method === 'GET') return vendorJson(200, view())
            if (!bpsRoute[2] && req.method === 'PATCH') {
              await manager.update(actor, id, { bps: await readBody(req, 16 * 1024) })
              return vendorJson(200, view())
            }
            if (!bpsRoute[2] && req.method === 'DELETE') {
              await manager.revokeBps(actor, id)
              return vendorJson(200, view())
            }
            if ((bpsRoute[2] === 'unblock' || bpsRoute[2] === 'recovery/stop') && req.method === 'POST') {
              await manager.bpsRecoveryAction(actor, id, bpsRoute[2] === 'unblock' ? 'unblock' : 'stop')
              return vendorJson(200, view())
            }
            if (bpsRoute[2] === 'models' && req.method === 'GET') {
              const refresh = new URL(req.url, 'http://local').searchParams.get('refresh') === '1'
              return vendorJson(200, await manager.bpsModels(id, { refresh }))
            }
            if (bpsRoute[2] === 'import' && req.method === 'POST') {
              await manager.importBps(actor, id, await readBody(req, 1024 * 1024))
              return vendorJson(200, view())
            }
          } catch (error) {
            if (error instanceof VendorError) throw error
            throw new VendorError(
              error.code || 'gateway_account_failed',
              error.message || 'BPS 操作失败',
              error.status || 502,
            )
          }
          throw new VendorError('method_not_allowed', '不支持的 BPS 操作', 405)
        }
        const reauthorizeDraft = resourcePath.match(/^\/api\/vendor\/accounts\/([^/]+)\/gateway-drafts$/)
        const gatewayDraft = resourcePath.match(
          /^\/api\/vendor\/accounts\/([^/]+)\/gateway-drafts\/([^/]+)\/(oauth\/generate-auth-url|oauth\/exchange-code|import)$/,
        )
        if ((reauthorizeDraft || gatewayDraft) && req.method === 'POST') {
          // 草稿只属于创建它的操作者；完成时重新校验账号仍属于该供应商且策略允许
          const manager = vendorGatewayAccounts()
          const actor = `vendor:${identity.vendor?.id || 'system'}:${identity.user_id}`
          const failure = (error) =>
            new VendorError(
              error.code || 'gateway_account_failed',
              error.message || 'Gateway Worker 账号授权失败',
              error.status || 502,
            )
          try {
            if (reauthorizeDraft) {
              requireGatewayRuntime(reauthorizeDraft[1])
              const body = await readBody(req, 8 * 1024)
              const draft = manager.createDraft(
                actor,
                {
                  idempotency_key: String(body.idempotency_key || ''),
                  ...(body.authorization_kind ? { authorization_kind: String(body.authorization_kind) } : {}),
                },
                reauthorizeDraft[1],
              )
              return vendorJson(201, { draft })
            }
            // 草稿必须属于路径中的账号，运营端据此确定供应商身份
            const draftId = decodeURIComponent(gatewayDraft[2])
            if (manager.draft(actor, draftId).resourceId !== gatewayDraft[1])
              throw new VendorError('draft_not_found', '授权草稿不存在或已过期，请重新发起授权', 404)
            requireGatewayRuntime(gatewayDraft[1])
            if (gatewayDraft[3] === 'oauth/generate-auth-url')
              return vendorJson(200, await manager.start(actor, draftId))
            const result =
              gatewayDraft[3] === 'import'
                ? await manager.import(actor, draftId, await readBody(req, 1024 * 1024))
                : await manager.complete(actor, draftId, await readBody(req, 16 * 1024))
            // 只回传结果摘要，不把运营端账号视图（含 Worker 运行信息）交给供应商
            return vendorJson(200, {
              account: { id: result.account?.id, name: result.account?.name, status: result.account?.status },
              projection_pending: !!result.projection_pending,
              oauth_email: result.oauth_email || null,
            })
          } catch (error) {
            if (error instanceof VendorError) throw error
            throw failure(error)
          }
        }
        if (gatewayAction && req.method === 'POST') {
          requireGatewayRuntime(gatewayAction[1])
          const result = await gatewayWorkerService.accountAction(
            gatewayAction[1],
            gatewayAction[2],
            await readBody(req, 64 * 1024),
          )
          if (!result.ok)
            throw new VendorError(
              result.data?.error?.code || 'gateway_worker_unavailable',
              'Gateway Worker 账号操作失败',
              result.status || 502,
            )
          return vendorJson(200, result.data || result)
        }
        if (accountAction?.[2] === 'profile/refresh' && req.method === 'POST') {
          platform.requireCapability(identity, 'vendor.resource.manage')
          const linked = accountQueries.runtime(platform, identity, accountAction[1], { write: true })
          if (linked.row.status === 'archived') throw new VendorError('resource_archived', '已归档账号不可修改', 409)
          if (linked.executionKind === 'gateway_worker') {
            const result = await gatewayWorkerService.accountAction(accountAction[1], 'refresh')
            if (!result.ok)
              throw new VendorError(
                result.data?.error?.code || 'gateway_refresh_failed',
                'Gateway Worker 账号资料刷新失败',
                result.status || 502,
              )
            return vendorJson(200, result.data || result)
          }
          const vm = linked.vmId ? getVm(cfg.paths.project, linked.vmId) : null
          if (!vm) throw new VendorError('vm_not_found', '账号运行环境不存在', 409)
          const result = await refreshAccountProfile(cfg.paths.project, vm.id)
          if (!result.ok)
            throw new VendorError(
              result.reason,
              '订阅资料未更新；已保留上次获取的信息',
              result.reason === 'profile_fetch_failed' ? 502 : 409,
            )
          platform.audit({
            actorUserId: identity.user_id,
            vendorId: linked.row.vendor_id,
            action: 'account.profile_refreshed',
            resourceType: 'account',
            resourceId: linked.row.id,
          })
          return vendorJson(200, { ok: true, updated_at: result.updated_at })
        }
        if (accountAction?.[2] === 'groups' && req.method === 'GET') {
          platform.requireCapability(identity, 'vendor.resource.manage')
          const account = accountQueries.runtime(platform, identity, accountAction[1], { write: true })
          return vendorJson(200, {
            items: platform.availableAccountGroups(identity, account.config.platform).map((g) => ({
              id: g.id,
              name: g.name,
              platform: g.platform,
              supported_platforms: [account.config.platform],
            })),
          })
        }
        if (accountAction?.[2] === 'usage' && req.method === 'GET')
          return vendorJson(
            200,
            await accountQueries.usage(platform, identity, accountAction[1], Object.fromEntries(url.searchParams)),
          )
        if (accountAction?.[2] === 'cooldown/clear' && req.method === 'POST') {
          platform.requireCapability(identity, 'vendor.resource.manage')
          const linked = accountQueries.runtime(platform, identity, accountAction[1], { write: true })
          if (linked.row.status === 'archived') throw new VendorError('resource_archived', '已归档账号不可修改', 409)
          if (linked.executionKind === 'gateway_worker') {
            const result = await gatewayWorkerService.accountAction(accountAction[1], 'recover')
            if (!result.ok)
              throw new VendorError(
                result.data?.error?.code || 'gateway_recover_failed',
                'Gateway Worker 账号恢复失败',
                result.status || 502,
              )
            platform.audit({
              actorUserId: identity.user_id,
              vendorId: linked.row.vendor_id,
              action: 'account.cooldown_cleared',
              resourceType: 'account',
              resourceId: linked.row.id,
            })
            return vendorJson(200, { cleared: true, worker: result.data || result })
          }
          const vm = linked.vmId ? getVm(cfg.paths.project, linked.vmId) : null
          if (!vm) throw new VendorError('vm_not_found', '账号运行环境不存在', 409)
          const account = panel.findAccount(accountQuota, vm)
          const key = account?.account_id || vm.claude?.account_uuid || vm.id
          const runtime = ctx.runtimeRepo?.get(key)
          if (
            runtime?.vm_id &&
            runtime.vm_id !== vm.id &&
            proxyPool.vendorIdForVm(runtime.vm_id) !== identity.vendor.id
          )
            throw new VendorError('shared_account_state', '此账号状态由平台统一维护', 409)
          const protectedReason = (reason) =>
            /protected|manual|disabled|banned|revoked|invalid_grant|credential_refresh_failed/i.test(
              String(reason || ''),
            )
          let cleared = false
          if (runtime && !protectedReason(runtime.cooldown_reason)) {
            cleared = !!(
              runtime.cooldown_until ||
              runtime.rate_limit_reset_at ||
              runtime.overload_until ||
              Object.values(runtime.model_states || {}).some((m) => m?.cooldown_until && !protectedReason(m.reason))
            )
            ctx.runtimeRepo.upsert({
              ...runtime,
              status: ['disabled', 'error', 'rate_limited'].includes(runtime.status) ? runtime.status : 'ready',
              cooldown_until: null,
              cooldown_reason: null,
              overload_until: null,
              model_states: Object.fromEntries(
                Object.entries(runtime.model_states || {}).map(([model, state]) => {
                  if (
                    !state?.cooldown_until ||
                    protectedReason(state.reason) ||
                    ['disabled', 'unsupported'].includes(state.status)
                  )
                    return [model, state]
                  const next = { ...state }
                  delete next.cooldown_until
                  delete next.reason
                  if (next.status === 'cooldown') next.status = 'ready'
                  return [model, next]
                }),
              ),
            })
          }

          patchVmRecord(cfg.paths.project, vm.id, (next) => {
            const reason = next.claude?.temp_unschedulable_reason || next.temp_unschedulable_reason
            if (!protectedReason(reason)) {
              cleared = cleared || !!(next.temp_unschedulable_until || next.claude?.temp_unschedulable_until)
              delete next.temp_unschedulable_until
              delete next.temp_unschedulable_reason
              if (next.claude) {
                delete next.claude.temp_unschedulable_until
                delete next.claude.temp_unschedulable_reason
              }
            }
            return next
          })
          ctx.poolScheduler?.notifyCapacity?.(key)
          platform.audit({
            actorUserId: identity.user_id,
            vendorId: identity.vendor.id,
            action: 'account.cooldown_cleared',
            resourceType: 'account',
            resourceId: linked.row.id,
          })
          return vendorJson(200, { cleared })
        }
        const vendorMatch = p.match(/^\/api\/vendor\/vendors\/([^/]+)$/)
        if (vendorMatch && req.method === 'GET') {
          platform.requireCapability(identity, 'vendor.create_child')
          const target = platform.getVendor(vendorMatch[1])
          if (!target || !platform.visibleVendorIds(identity, { aggregate: true }).includes(target.id))
            throw new VendorError('vendor_scope_forbidden', '供应商不属于当前范围', 403)
          return vendorJson(200, target)
        }

        const vendorProxyBatchActionMatch = p.match(/^\/api\/vendor\/proxies\/(probe|quality-check|geo)$/)
        if (vendorProxyBatchActionMatch && req.method === 'POST') {
          platform.requireActive(identity)
          platform.requireCapability(identity, 'vendor.resource.manage')
          const action = vendorProxyBatchActionMatch[1] === 'quality-check' ? 'quality' : vendorProxyBatchActionMatch[1]
          const rows = platform.listResources(identity, 'proxy')
          const results = []
          for (const resource of rows) {
            try {
              results.push({ id: resource.id, ...(await proxyCommands.action(identity, resource.id, action)) })
            } catch (error) {
              results.push({ id: resource.id, ok: false, error: error.code || 'proxy_action_failed' })
            }
          }
          return vendorJson(200, { action, total: results.length, results })
        }

        const vendorProxyActionMatch = p.match(
          /^\/api\/vendor\/proxies\/([^/]+)\/(probe|quality-check|geo|enable|disable|archive)$/,
        )
        if (vendorProxyActionMatch && req.method === 'POST') {
          const action = vendorProxyActionMatch[2] === 'quality-check' ? 'quality' : vendorProxyActionMatch[2]
          return vendorJson(200, await proxyCommands.action(identity, vendorProxyActionMatch[1], action))
        }

        const resourceMatch = resourcePath.match(
          /^\/api\/vendor\/(accounts|vms|proxies)(?:\/([^/]+))?(?:\/(start|stop|pause|resume))?$/,
        )
        if (resourceMatch) {
          const resourceType = resourceMatch[1] === 'accounts' ? 'account' : resourceMatch[1] === 'vms' ? 'vm' : 'proxy'
          const resourceId = resourceMatch[2]
          const command = resourceMatch[3]
          if (req.method === 'GET' && !resourceId) {
            const rows = platform.listResources(identity, resourceType, {
              vendorId: url.searchParams.get('vendor_id') || '',
              includeArchived: resourceType === 'account',
            })
            return vendorJson(
              200,
              resourceType === 'account'
                ? filterAccountRows(await presentAccounts(rows), Object.fromEntries(url.searchParams))
                : rows.map(presentVendorProxy),
            )
          }
          if (req.method === 'POST' && !resourceId && resourceType === 'account') {
            if (!admin)
              throw new VendorError('authorization_required', '请先完成授权，授权成功后系统才会创建账号和 VM', 409)
            const body = await readBody(req, 32 * 1024)
            if (!platform.vmProvisioner && String(body.execution_kind || 'vm') !== 'gateway_worker')
              throw new VendorError('vm_provisioner_unavailable', '虚拟机创建服务暂不可用', 503)
            if (body.proxy_endpoint) assertVendorProxyAvailable(identity, body.proxy_endpoint)
            let pair
            try {
              pair = platform.createAccount(identity, body, {
                requireExplicitGroup: true,
                configure: (runtime, account) => {
                  const proxyId = account.config?.proxy_id
                  if (proxyId) {
                    const proxyResource = platform.getResource(identity, proxyId, { write: true })
                    const poolId = vendorProxyPoolId(identity, projectResource(proxyResource))
                    proxyPool.addPlatform(poolId, account.config.platform)
                    const bound = proxyPool.bind(poolId, runtime.id)
                    if (!bound.ok) throw new VendorError('proxy_bind_failed', '代理不可用或已达到绑定上限', 409)
                    runtime.proxy = proxyPool.getProxyForVm(runtime.id)
                    runtime.proxy_required = true
                    runtime.proxy_cli_enabled = true
                  }
                  const groupIds = account.config?.group_ids || []
                  if (ctx.groupsRepo)
                    ctx.groupsRepo.assignResource(
                      'vm',
                      runtime.id,
                      groupIds,
                      ctx.groupsRepo.resourceVersion('vm', runtime.id),
                      identity.user_id,
                    )
                },
              })
            } catch (error) {
              proxyPool.reload()
              throw error
            }
            if (String(body.execution_kind || 'vm') === 'gateway_worker')
              return vendorJson(201, { ...pair, runtime_boot: null, gateway_worker: { enabled: true } })
            if (pair.reused) return vendorJson(200, { ...pair, runtime_boot: null })
            const runtimeVmId = pair.vm.config?.runtime_vm_id || null
            const runtime = runtimeVmId ? await startVendorRuntimeVm(runtimeVmId) : null
            return vendorJson(201, {
              ...pair,
              runtime_boot: runtime
                ? { ok: runtime.ok, code: runtime.code || null, error: runtime.error || null }
                : null,
            })
          }
          if (req.method === 'POST' && !resourceId && resourceType === 'vm') {
            throw new VendorError('account_creation_required', '供应商 VM 必须通过账号创建流程生成', 409)
          }
          if (req.method === 'POST' && !resourceId) {
            const body = await readBody(req, 32 * 1024)
            assertVendorProxyAvailable(identity, body.config?.endpoint)
            const resource = withTransaction(platform.db, () => {
              const created = platform.createProxy(identity, body)
              const poolProxyId = vendorProxyPoolId(identity, created)
              return platform.setResourcePoolProxy(identity, created.id, poolProxyId)
            })
            return vendorJson(201, resource)
          }
          if (resourceId) {
            const resource = platform.getResource(identity, resourceId)
            if (resource.resource_type !== resourceType) throw new VendorError('resource_not_found', '资源不存在', 404)
          }
          if (!admin && resourceType === 'vm' && ['PATCH', 'DELETE'].includes(req.method))
            throw new VendorError('vm_config_forbidden', '请通过账号操作修改授权、分组、名称、备注和代理', 403)
          if (resourceType === 'account' && resourceId && req.method === 'DELETE')
            return vendorJson(200, await archiveVendorAccount(identity, resourceId))
          if (command && req.method !== 'POST') throw new VendorError('method_not_allowed', '操作必须使用 POST', 405)
          if (resourceType === 'vm' && resourceId && ['start', 'stop'].includes(command)) {
            platform.requireActive(identity)
            platform.requireCapability(identity, 'vendor.resource.manage')
            const resource = platform.getResource(identity, resourceId, { write: true })
            const vmConfig = JSON.parse(resource.config_json || '{}')
            const account = platform.getResource(identity, vmConfig.account_resource_id, { write: true })
            if ([resource.status, account.status].includes('archived'))
              throw new VendorError('resource_archived', '账号已归档', 409)
            const vm = getVm(cfg.paths.project, vmConfig.runtime_vm_id)
            if (!vm) throw new VendorError('vm_not_found', '配对虚拟机不存在', 404)
            if (command === 'start') {
              const boot = await startVendorRuntimeVm(vm.id)
              if (!boot.ok) throw new VendorError(boot.code, boot.error, boot.status)
              return vendorJson(200, { vm_id: vm.id, status: 'running' })
            }
            const halt = await stopSlot(vm)
            if (!halt.ok) throw new VendorError('runtime_stop_failed', halt.error || '停止虚拟机失败', 500)
            patchVmRecord(cfg.paths.project, vm.id, { status: 'stopped' })
            return vendorJson(200, { vm_id: vm.id, status: 'stopped' })
          }
          if (resourceId && (req.method === 'PATCH' || req.method === 'DELETE' || command)) {
            platform.requireActive(identity)
            platform.requireCapability(identity, 'vendor.resource.manage')
            const ownedResource = platform.getResource(identity, resourceId, { write: true })
            if (ownedResource.status === 'archived')
              throw new VendorError('resource_archived', '已归档资源不可修改', 409)
            const body =
              req.method === 'DELETE'
                ? { status: 'archived' }
                : command
                  ? {
                      status: command === 'start' || command === 'resume' ? 'active' : 'paused',
                    }
                  : await readBody(req, 32 * 1024)
            const accountSettings = [
              'name',
              'notes',
              'group_ids',
              'proxy_id',
              'proxy_endpoint',
              'proxy_source',
              'proxy_region',
              'expected_updated_at',
              'expected_group_version',
              'status',
            ]
            if (resourceType === 'account' && body.status !== 'archived') {
              if (Object.keys(body).some((key) => !accountSettings.includes(key)))
                throw new VendorError('invalid_resource_patch', '账号配置字段无效')
              return vendorJson(200, await updateVendorAccount(identity, resourceId, body))
            }
            if (resourceType === 'account' && body.status === 'archived') {
              if (Object.keys(body).length !== 1)
                throw new VendorError('invalid_resource_patch', '归档不能同时修改账号配置')
              return vendorJson(200, await archiveVendorAccount(identity, resourceId))
            }
            if (resourceType === 'proxy' && body.status === 'archived') {
              const poolId = vendorProxyPoolId(identity, projectResource(ownedResource))
              const current = proxyPool.state.proxies.find((item) => item.id === poolId)
              if ((current?.bound_vm_ids || []).length)
                throw new VendorError('proxy_in_use', '代理仍绑定账号，解除绑定后才能归档', 409)
              const result = proxyPool.setEnabled(poolId, false)
              if (!result.ok) throw new VendorError('proxy_not_found', '统一代理池中不存在该代理', 404)
              const updated = platform.updateProxyResource(identity, resourceId, { status: 'archived' })
              return vendorJson(200, presentVendorProxy(updated))
            }
            if (resourceType === 'proxy' && body.status !== 'archived') {
              const allowed = ['name', 'status', 'endpoint', 'username', 'password', 'clear_auth', 'platforms', 'notes']
              if (Object.keys(body).some((key) => !allowed.includes(key)))
                throw new VendorError('invalid_resource_patch', '代理配置字段无效')
              if (body.status != null && !['active', 'paused'].includes(String(body.status)))
                throw new VendorError('invalid_resource_status', '代理状态无效')
              const poolId = vendorProxyPoolId(identity, projectResource(ownedResource))
              const poolPatch = {}
              if (body.endpoint != null) {
                const parsed = parseSocks5Line(vendorProxyAddress(body.endpoint))
                if (!parsed) throw new VendorError('invalid_proxy', '请输入有效代理地址')
                poolPatch.host = parsed.host
                poolPatch.port = parsed.port
                poolPatch.username = parsed.username || ''
                poolPatch.password = parsed.username ? parsed.password || '' : ''
              } else {
                for (const key of ['username', 'password']) if (Object.hasOwn(body, key)) poolPatch[key] = body[key]
                if (body.clear_auth) {
                  poolPatch.username = ''
                  poolPatch.password = ''
                }
              }
              if (body.status != null) poolPatch.enabled = body.status === 'active'
              const changed = Object.keys(poolPatch).length
                ? proxyPool.update(poolId, poolPatch)
                : { ok: true, proxy: proxyPool.publicProxy(proxyPool.state.proxies.find((p) => p.id === poolId)) }
              if (!changed.ok) throw new VendorError('proxy_update_failed', changed.error || '代理配置更新失败', 400)
              const updated = platform.updateProxyResource(identity, resourceId, body)
              const workers = []
              if (changed.connection_changed) {
                for (const vmId of changed.proxy.bound_vm_ids || []) {
                  bindVmProxy(cfg.paths.project, vmId, proxyPool.getProxyForVm(vmId))
                  const vm = getVm(cfg.paths.project, vmId)
                  if (vm?.status === 'running' && process.env.KIN_CRS_MOCK !== '1') {
                    setScheduleHold(cfg.paths.project, vmId, HOLD_MAINTENANCE, {
                      tag: 'vendor_proxy_edit_worker_reload',
                    })
                    const reloaded = await reloadSlotReady(getVm(cfg.paths.project, vmId), cfg.paths.project, {
                      routing: ctx.routingConfig,
                    })
                    if (reloaded.ok) restoreSchedulableIfReady(vmId, { by: 'vendor_proxy_edit' })
                    workers.push({ vm_id: vmId, ok: !!reloaded.ok, error: reloaded.ok ? null : reloaded.error || null })
                  } else workers.push({ vm_id: vmId, ok: true, error: null })
                }
              }
              return vendorJson(200, { ...presentVendorProxy(updated), runtime_apply: workers })
            }
            if (Object.keys(body).some((key) => !['name', 'status', 'notes'].includes(key)))
              throw new VendorError('invalid_resource_patch', '仅允许修改资源名称和状态')
            const updated = withTransaction(platform.db, () => {
              const result = platform.updateResource(identity, resourceId, body)
              if (resourceType === 'proxy' && body.status && result.config.pool_proxy_id) {
                const changed = proxyPool.setEnabled(result.config.pool_proxy_id, body.status === 'active')
                if (!changed.ok) throw new VendorError('proxy_update_failed', changed.error || '代理状态更新失败', 409)
              }
              return result
            })
            if (['account', 'vm'].includes(resourceType) && body.status) {
              const pair =
                resourceType === 'vm'
                  ? updated
                  : projectResource(platform.getResource(identity, updated.config.vm_resource_id))
              const vmId = pair?.config?.runtime_vm_id
              if (vmId)
                patchVmRecord(cfg.paths.project, vmId, (vm) => {
                  // Clean only the previous supplier-owned switch, preserving operator holds.
                  if (vm.schedule_off_reason === 'vendor_paused') {
                    delete vm.schedule_off
                    delete vm.schedule_off_reason
                  }
                  vm.vendor_resource_paused = body.status !== 'active'
                  return deriveScheduleFields(vm, { preserveStatus: true })
                })
            }
            return vendorJson(200, updated)
          }
          if (resourceId && req.method === 'GET') {
            const resource = projectResource(platform.getResource(identity, resourceId))
            if (resourceType !== 'account') return vendorJson(200, presentVendorProxy(resource))
            const account = (await presentAccounts([resource]))[0]
            const linked = accountQueries.runtime(platform, identity, resourceId)
            const owner = platform.getVendor(resource.vendor_id)
            const currentProxy = resource.config.proxy_id
              ? platform.db
                  .prepare("SELECT * FROM vendor_resources WHERE id=? AND vendor_id=? AND resource_type='proxy'")
                  .get(String(resource.config.proxy_id), resource.vendor_id)
              : null
            const proxyView = currentProxy ? presentVendorProxy(projectResource(currentProxy)) : null
            const detailProxy = account.proxy
              ? {
                  ...account.proxy,
                  region: proxyView?.config.region || '',
                  country: proxyView?.config.region_name || '',
                  city: proxyView?.config.city || '',
                }
              : null
            if (linked.executionKind === 'gateway_worker') {
              // 与虚拟机账号详情同形状：冷却取错误保护冻结与用尽的额度窗口；模型级冷却由 Worker 自管，不在此列出
              return vendorJson(200, {
                ...account,
                owner: { id: resource.vendor_id, name: owner?.name || '' },
                schedulable: account.telemetry?.state === 'available',
                proxy: detailProxy,
                cooldowns: account.telemetry?.cooldown_until
                  ? [
                      {
                        kind: account.telemetry.restriction_reason === 'cooldown' ? 'temporary' : 'quota',
                        until: account.telemetry.cooldown_until,
                      },
                    ]
                  : [],
                model_limits: null,
                group_version: ctx.groupsRepo?.resourceVersion('gateway_worker_account', resourceId) || 0,
                snapshot_at: new Date().toISOString(),
              })
            }
            const vm = linked.vmId ? getVm(cfg.paths.project, linked.vmId) : null
            const row = vm ? panel.findAccount(accountQuota, vm) : null
            const runtime = vm ? ctx.runtimeRepo?.get(row?.account_id || vm.claude?.account_uuid || vm.id) : null
            const asTime = (v) => {
              const n = typeof v === 'number' ? v : Date.parse(v || '')
              return Number.isFinite(n) && n > Date.now() ? new Date(n).toISOString() : null
            }
            const cooldowns = [
              [
                'temporary',
                [runtime?.cooldown_until, vm?.claude?.temp_unschedulable_until, vm?.temp_unschedulable_until]
                  .map(asTime)
                  .filter(Boolean)
                  .sort()
                  .at(-1),
              ],
              ['rate_limit', runtime?.rate_limit_reset_at],
              ['overload', runtime?.overload_until],
            ]
              .map(([kind, until]) => ({ kind, until: asTime(until) }))
              .filter((x) => x.until)
            const model_limits = runtime
              ? Object.entries(runtime.model_states || {})
                  .filter(([, m]) => asTime(m?.cooldown_until) || ['unsupported', 'disabled'].includes(m?.status))
                  .map(([model, m]) => ({ model, until: asTime(m.cooldown_until), status: m.status || 'cooldown' }))
              : null
            return vendorJson(200, {
              ...account,
              owner: { id: resource.vendor_id, name: owner?.name || '' },
              schedulable: account.telemetry.state === 'available',
              proxy: detailProxy,
              cooldowns,
              model_limits,
              group_version: ctx.groupsRepo?.resourceVersion('vm', linked.vmId) || 0,
              snapshot_at: new Date().toISOString(),
            })
          }
          if (resourceId && req.method === 'DELETE')
            return vendorJson(
              200,
              platform.updateResource(identity, resourceId, {
                status: 'archived',
              }),
            )
        }
        throw new VendorError('not_found', '供应商接口不存在', 404)
      } catch (error) {
        const e =
          error instanceof VendorError
            ? error
            : error?.code && error?.status
              ? new VendorError(error.code, error.message || '供应商请求失败', error.status)
              : new VendorError('vendor_internal_error', '供应商操作失败，请稍后重试或联系管理员', 500)
        return vendorJson(e.status, vendorError(e))
      }
    }

    if (p.startsWith('/admin')) {
      if (!requireAuth(req, res)) return true
      if (panelIdentity(req).role !== 'super_admin') {
        json(
          res,
          403,
          makeError({
            type: ErrorType.PERMISSION,
            code: 'forbidden',
            message: 'Admin routes require an administrator',
            status: 403,
          }).body,
        )
        return true
      }
    }
    if (p === '/admin/models/refresh') return false

    if (p === '/admin/routing' && req.method === 'GET') {
      if (!requireAuth(req, res)) return
      return json(res, 200, {
        config_revision: currentConfigRevision(),
        routing: publicRoutingNotify(ctx.routingConfig),
        sticky: stickyRouter.stats(),
        pool: ctx.poolScheduler.snapshot(),
        account_runtime: ctx.runtimeRepo.list(),
      })
    }
    if (p === '/admin/routing' && (req.method === 'PUT' || req.method === 'POST')) {
      if (!requireAuth(req, res)) return
      const body = await readBody(req, cfg.limits.max_body_bytes)
      let applied
      try {
        applied = await persistRoutingPatch(body, { expectedRevision: body?.config_revision })
      } catch (error) {
        if (error?.code === 'config_revision_conflict') {
          return json(res, 409, {
            ok: false,
            error: {
              type: 'conflict',
              code: error.code,
              message: error.message,
              current_revision: error.current_revision ?? currentConfigRevision(),
            },
          })
        }
        if (error instanceof TypeError || error instanceof RangeError) {
          return json(res, 400, {
            ok: false,
            error: {
              type: 'invalid_request_error',
              code: error.code || 'invalid_openai_quota',
              message: error.message,
            },
          })
        }
        throw error
      }
      return json(res, 200, {
        ok: true,
        config_revision: applied.config_revision ?? currentConfigRevision(),
        routing: publicRoutingNotify(ctx.routingConfig),
        applied_concurrency: applied.concurrency,
        applied_rpm: applied.rpm,
      })
    }
    if (p === '/admin/quota' && req.method === 'GET') {
      if (!requireAuth(req, res)) return
      return json(res, 200, accountQuota.snapshot())
    }

    // ---- Multi-VM + usage management ----
    if (req.method === 'GET' && p === '/admin/vms') {
      if (!requireAuth(req, res)) return
      const active = getActiveVmId(cfg.paths.project)
      const vms = listVms(cfg.paths.project, ctx.routingConfig).map((v) => ({ ...v, active: v.id === active }))
      return json(res, 200, { vms, active_vm: active, total: vms.length })
    }
    if (req.method === 'GET' && p.startsWith('/admin/vms/') && !p.includes('/probe') && !p.endsWith('/activate')) {
      if (!requireAuth(req, res)) return
      const id = p.split('/')[3]
      const vm = getVm(cfg.paths.project, id)
      if (!vm) return json(res, 404, { error: { message: 'vm not found' } })
      return json(res, 200, {
        vm: summarizeVm(vm, cfg.paths.project, ctx.routingConfig),
        active: getActiveVmId(cfg.paths.project) === id,
      })
    }
    if (req.method === 'POST' && /^\/admin\/vms\/[^/]+\/activate$/.test(p)) {
      if (!requireAuth(req, res)) return
      const id = p.split('/')[3]
      if (!getVm(cfg.paths.project, id)) return json(res, 404, { error: { message: 'vm not found' } })
      return json(res, 200, activateVmSlot(id))
    }
    if (req.method === 'POST' && /^\/admin\/vms\/[^/]+\/deactivate$/.test(p)) {
      if (!requireAuth(req, res)) return
      const id = p.split('/')[3]
      if (!getVm(cfg.paths.project, id)) return json(res, 404, { error: { message: 'vm not found' } })
      return json(res, 200, deactivateVmSlot(id))
    }
    if (req.method === 'POST' && /^\/admin\/vms\/[^/]+\/probe$/.test(p)) {
      if (!requireAuth(req, res)) return
      const id = p.split('/')[3]
      const hop = (await readBody(req, 4096).catch(() => ({})))?.hop !== false
      const result = await panel.buildProbeOne({ cfg, accountQuota, id, hop, routingConfig: ctx.routingConfig })
      if (result.status) return json(res, result.status, result.body)
      return json(res, 200, { vm_id: id, account_uuid: result.data?.account_uuid, probe: result.data })
    }
    if (req.method === 'POST' && p === '/admin/vms/probe-all') {
      if (!requireAuth(req, res)) return
      const hop = (await readBody(req, 4096).catch(() => ({})))?.hop === true
      const result = await panel.buildProbeAll({ cfg, accountQuota, hop, routingConfig: ctx.routingConfig })
      return json(res, 200, result)
    }
    if (req.method === 'GET' && p === '/admin/usage/summary') {
      if (!requireAuth(req, res)) return
      const snap = accountQuota.snapshot()
      const vms = listVms(cfg.paths.project, ctx.routingConfig)
      const accounts = snap.accounts || []
      const max5 = Math.max(0, ...accounts.map((a) => Number(a.unified?.['5h']?.utilization || 0)))
      const max7 = Math.max(0, ...accounts.map((a) => Number(a.unified?.['7d']?.utilization || 0)))
      const sumTokensIn = accounts.reduce((s, a) => s + (a.tokens_in || 0), 0)
      const sumTokensOut = accounts.reduce((s, a) => s + (a.tokens_out || 0), 0)
      const sumReq = accounts.reduce((s, a) => s + (a.requests || 0), 0)
      const nearLimit = accounts.filter(
        (a) =>
          Number(a.unified?.['5h']?.utilization || 0) >= snap.safety_ratio ||
          Number(a.unified?.['7d']?.utilization || 0) >= snap.safety_ratio,
      )
      return json(res, 200, {
        safety_ratio: snap.safety_ratio,
        vm_count: vms.length,
        account_count: accounts.length,
        totals: {
          requests: sumReq,
          tokens_in: sumTokensIn,
          tokens_out: sumTokensOut,
          peak_5h_utilization: max5,
          peak_7d_utilization: max7,
          near_limit_count: nearLimit.length,
        },
        accounts,
        vms,
      })
    }

    // ========== Panel login (public) ==========
    if (req.method === 'GET' && p === '/api/panel/site')
      return json(res, 200, { ok: true, data: siteBranding(panelUsers.db) })
    if (req.method === 'POST' && p === '/api/panel/login') {
      const body = await readBody(req, 4096)
      const username = body.username || body.user || body.u || ''
      const password = body.password || body.pass || body.p || ''
      const authed = verifyPanelLogin(username, password)
      if (!authed) {
        return json(res, 401, { ok: false, error: { message: '用户名或密码错误', type: 'auth' } })
      }
      if (authed.source === 'env') {
        try {
          panelUsers.bootstrapFromEnv({ username: authed.username, password })
        } catch {}
      }
      const token = createPanelSession(authed.username, { role: authed.role })
      const secure = panelCookieSecure(req)
      res.setHeader('Set-Cookie', panelSessionCookie(token, { secure }))
      const me = { user: authed.username, role: authed.role }
      return json(res, 200, {
        ok: true,
        token,
        user: me.user,
        role: me.role,
        views: mePayload({ panelUser: me.user, panelRole: me.role }).views,
        capabilities: mePayload({ panelUser: me.user, panelRole: me.role }).capabilities,
        expires_in: 7 * 24 * 3600,
      })
    }
    if (req.method === 'POST' && p === '/api/panel/logout') {
      const tok = extractPanelToken(req)
      if (tok) revokePanelSession(tok)
      const secure = panelCookieSecure(req)
      res.setHeader('Set-Cookie', clearPanelSessionCookie({ secure }))
      return json(res, 200, { ok: true })
    }

    if (p.startsWith('/api/panel')) {
      if (!requireAuth(req, res)) return
      // Managed client keys may only call protocol endpoints — never panel/admin.
      // Only panel session or master KIN_API_KEY may administer.
      const isPanelOperator = !!req.panelUser || req.apiKeyKind === 'master'
      if (!isPanelOperator) {
        return json(
          res,
          403,
          makeError({
            type: ErrorType.PERMISSION,
            code: 'forbidden',
            message: 'Panel requires admin login or master API key',
            status: 403,
          }).body,
        )
      }
      if (req.panelUserId && panelIdentity(req).role === 'admin') {
        req.panelManagedUserIds = panelUsers.repo.scopeIds(req.panelUserId)
        req.panelScopeRootId = panelUsers.repo.scopeRootId(req.panelUserId)
      }
      if (
        p.startsWith('/api/panel/gateway-workers') ||
        p.startsWith('/api/panel/codex-accounts') ||
        p.startsWith('/api/panel/gateway-execution-policies')
      ) {
        return handleGatewayWorkerRoutes(req, res, url)
      }
      if (req.method === 'GET' && p === '/api/panel/me') {
        const me = mePayload(req)
        const version = runningVersion
        const user = req.panelUserId ? panelUsers.getById(req.panelUserId) : null
        let vendor = null
        if (req.panelUserId) {
          try {
            vendor = vendorPlatform().identity(req.panelUserId).vendor
          } catch {}
        }
        const payload = {
          ...me,
          version,
          vendor,
          ...(user ? { display_name: user.display_name || '', email: profileView(user).email } : {}),
        }
        return json(res, 200, { ok: true, ...payload, data: payload })
      }
      const gate = authorizePanelRoute(req.method, p, panelIdentity(req).role)
      if (!gate.ok) {
        return json(
          res,
          403,
          makeError({
            type: ErrorType.PERMISSION,
            code: gate.code || 'forbidden',
            message: gate.message || '当前权限无法执行此操作',
            status: 403,
          }).body,
        )
      }
      if (panelIdentity(req).role === 'vendor') {
        const ownedVmPath = p.match(
          /^\/api\/panel\/vms\/([^/]+)\/(?:start|shell-ticket|oauth\/generate-auth-url|oauth\/exchange-code|oauth\/credential|oauth\/setup-token-session)$/,
        )
        if (ownedVmPath) assertVendorRuntimeVm(req, decodeURIComponent(ownedVmPath[1]))
      }
      if (p.startsWith('/api/panel/codex-client-profile') || p.startsWith('/api/panel/codex-privacy')) {
        if (panelIdentity(req).role !== 'super_admin') {
          return json(res, 403, {
            ok: false,
            error: { code: 'forbidden', message: '只有超级管理员可以管理上游客户端画像与隐私规则' },
          })
        }
        const settings = settingsRepo()
        const invalidBody = (error) =>
          json(res, 400, {
            ok: false,
            error: { type: 'invalid_request_error', code: error.code || 'invalid_request', message: error.message },
          })
        // 预览与发布状态由在线 Worker 计算（官方发布资料与 RE2 编译都在 Worker 内）
        const workerCall = async (path, options) => {
          try {
            const result = await gatewayWorkerService.internal(path, options)
            return json(res, result.status || (result.ok ? 200 : 502), result.data || { ok: false })
          } catch (error) {
            return json(res, 502, {
              ok: false,
              error: { code: 'gateway_worker_unavailable', message: String(error.message || error) },
            })
          }
        }
        if (p === '/api/panel/codex-client-profile') {
          if (req.method === 'GET') return json(res, 200, { ok: true, ...readClientProfileSetting(settings.db) })
          if (req.method !== 'PUT') return false
          const body = await readBody(req, 64 * 1024)
          let next
          try {
            next = {
              selection: validateClientProfileSelection(body?.selection || {}),
              deployment: validateProfileDeployment(body?.deployment || {}),
            }
          } catch (error) {
            return invalidBody(error)
          }
          const previous = settings.get(CLIENT_PROFILE_SETTING, null)
          settings.set(CLIENT_PROFILE_SETTING, next)
          try {
            audit(settings.db, panelIdentity(req).user, 'codex.client_profile.update', 'global', previous, next)
          } catch {}
          return json(res, 200, { ok: true, ...next })
        }
        if (p === '/api/panel/codex-client-profile/preview' && req.method === 'POST') {
          const body = await readBody(req, 64 * 1024)
          let input
          try {
            input = {
              selection: validateClientProfileSelection(body?.selection || {}),
              deployment: validateProfileDeployment(body?.deployment || {}),
            }
          } catch (error) {
            return invalidBody(error)
          }
          return workerCall('/internal/v1/profile/preview', { method: 'POST', body: input })
        }
        if (p === '/api/panel/codex-client-profile/releases' && req.method === 'GET') {
          return workerCall('/internal/v1/profile/releases')
        }
        if (p === '/api/panel/codex-privacy') {
          if (req.method === 'GET') return json(res, 200, { ok: true, policy: readPrivacyPolicySetting(settings.db) })
          if (req.method !== 'PUT') return false
          const body = await readBody(req, 512 * 1024)
          let policy
          try {
            policy = validatePrivacyPolicy(body?.policy ?? body)
          } catch (error) {
            return invalidBody(error)
          }
          // 正则按 Worker 的 RE2 编译确认；没有在线 Worker 时只做结构校验
          if (policy.rules.length) {
            try {
              const checked = await gatewayWorkerService.internal('/internal/v1/privacy/preview', {
                method: 'POST',
                body: { policy, body: {}, headers: {} },
              })
              if (checked.status === 400) {
                const failure = checked.data?.error || {}
                return json(res, 400, {
                  ok: false,
                  error: {
                    type: 'invalid_request_error',
                    code: 'invalid_privacy_policy',
                    message: `第 ${(failure.rule_index ?? 0) + 1} 条规则：${failure.reason || '规则无效'}`,
                  },
                })
              }
            } catch {}
          }
          const previous = settings.get(PRIVACY_POLICY_SETTING, null)
          settings.set(PRIVACY_POLICY_SETTING, policy)
          try {
            audit(
              settings.db,
              panelIdentity(req).user,
              'codex.privacy.update',
              'global',
              previous ? { rules: previous.rules?.length || 0, enabled: previous.enabled } : null,
              { rules: policy.rules.length, enabled: policy.enabled },
            )
          } catch {}
          return json(res, 200, { ok: true, policy })
        }
        if (p === '/api/panel/codex-privacy/preview' && req.method === 'POST') {
          const body = await readBody(req, 600 * 1024)
          let policy
          try {
            policy = validatePrivacyPolicy(body?.policy || {})
          } catch (error) {
            return invalidBody(error)
          }
          return workerCall('/internal/v1/privacy/preview', {
            method: 'POST',
            body: {
              policy,
              body: body?.body ?? {},
              headers: body?.headers || {},
              turnMetadata: body?.turnMetadata ?? null,
            },
          })
        }
        return false
      }
      if (p === '/api/panel/codex-request-location') {
        if (panelIdentity(req).role !== 'super_admin') {
          return json(res, 403, { ok: false, error: { code: 'forbidden', message: '只有超级管理员可以管理请求位置' } })
        }
        const settings = settingsRepo()
        if (req.method === 'GET') return json(res, 200, { ok: true, ...readRequestLocationSetting(settings.db) })
        if (req.method !== 'PUT') return false
        const body = await readBody(req, 16 * 1024)
        let next
        try {
          if (body?.enabled != null && typeof body.enabled !== 'boolean')
            throw Object.assign(new TypeError('enabled 必须是布尔'), { code: 'invalid_request_location' })
          next = {
            enabled: body?.enabled === true,
            location: normalizeRequestLocation(body?.location || DEFAULT_REQUEST_LOCATION),
          }
        } catch (error) {
          return json(res, 400, {
            ok: false,
            error: {
              type: 'invalid_request_error',
              code: error.code || 'invalid_request_location',
              message: error.message,
            },
          })
        }
        const previous = settings.get(REQUEST_LOCATION_SETTING, null)
        settings.set(REQUEST_LOCATION_SETTING, next)
        try {
          audit(settings.db, panelIdentity(req).user, 'codex.request_location.update', 'global', previous, next)
        } catch {}
        return json(res, 200, { ok: true, ...next })
      }
      if (p === '/api/panel/account-error-protection') {
        if (panelIdentity(req).role !== 'super_admin') {
          return json(res, 403, {
            ok: false,
            error: { code: 'forbidden', message: '只有超级管理员可以管理账号错误保护' },
          })
        }
        const settings = settingsRepo()
        if (req.method === 'GET') {
          const raw = settings.get('account_error_protection', DEFAULT_ACCOUNT_ERROR_PROTECTION)
          const validation = validateAccountErrorProtection(raw)
          return json(res, 200, {
            ok: true,
            enabled: validation.ok ? validation.policy.enabled : false,
            policy: validation.ok
              ? validation.policy
              : normalizeAccountErrorProtection(DEFAULT_ACCOUNT_ERROR_PROTECTION),
            fingerprint: validation.ok ? compileAccountErrorProtection(validation.policy).fingerprint : null,
            ...(validation.ok
              ? {}
              : { error: { code: validation.code, message: '账号错误保护配置无效，当前按关闭处理' } }),
          })
        }
        if (req.method !== 'PUT') return false
        const body = await readBody(req, 128 * 1024)
        const candidate = body?.account_error_protection ?? body?.accountErrorProtection ?? body
        const validation = validateAccountErrorProtection(candidate || {})
        if (!validation.ok) {
          return json(res, 400, {
            ok: false,
            error: { type: 'invalid_request_error', code: validation.code, message: '账号错误保护配置无效' },
          })
        }
        const previous = settings.get('account_error_protection', DEFAULT_ACCOUNT_ERROR_PROTECTION)
        const compiled = compileAccountErrorProtection(validation.policy)
        settings.set('account_error_protection', compiled.policy)
        if (typeof ctx.reloadAccountErrorProtection === 'function') ctx.reloadAccountErrorProtection(compiled)
        else if (ctx.failoverRunner) ctx.failoverRunner.accountErrorProtection = compiled
        try {
          audit(
            settings.db,
            panelIdentity(req).user,
            'account.error_protection.update',
            'global',
            previous,
            compiled.policy,
          )
        } catch {}
        return json(res, 200, { ok: true, policy: validation.policy, fingerprint: compiled.fingerprint })
      }
      const clearProtection = p.match(/^\/api\/panel\/accounts\/([^/]+)\/error-protection\/clear$/)
      if (clearProtection && req.method === 'POST') {
        if (panelIdentity(req).role !== 'super_admin') {
          return json(res, 403, { ok: false, error: { code: 'forbidden', message: '只有超级管理员可以解除账号保护' } })
        }
        const accountId = decodeURIComponent(clearProtection[1])
        const body = await readBody(req, 16 * 1024)
        const expected = Number(body?.protection_generation ?? body?.protectionGeneration)
        if (!Number.isSafeInteger(expected) || expected < 0) {
          return json(res, 400, {
            ok: false,
            error: {
              type: 'invalid_request_error',
              code: 'invalid_protection_generation',
              message: '需要有效的 protection_generation',
            },
          })
        }
        const current = ctx.runtimeRepo?.getProtectionState?.(accountId)
        if (!current) {
          return json(res, 404, {
            ok: false,
            error: { type: 'not_found_error', code: 'account_runtime_not_found', message: '账号运行状态不存在' },
          })
        }
        if (current.generation !== expected) {
          return json(res, 409, {
            ok: false,
            error: {
              type: 'conflict',
              code: 'protection_generation_conflict',
              current_generation: current.generation,
            },
          })
        }
        const cleared =
          current.state == null
            ? null
            : clearProtectionState(current.state, { expectedGeneration: current.state?.generation })
        const nextGeneration = ctx.runtimeRepo.clearProtectionState?.(accountId, {
          expectedGeneration: expected,
          state: cleared,
        })
        if (nextGeneration == null) {
          const latest = ctx.runtimeRepo.getProtectionState?.(accountId)
          return json(res, 409, {
            ok: false,
            error: {
              type: 'conflict',
              code: 'protection_generation_conflict',
              current_generation: latest?.generation ?? null,
            },
          })
        }
        const account = ctx.runtimeRepo.get?.(accountId)
        const cooldownCleared = account?.cooldown_reason === 'account_error_protected'
        if (cooldownCleared) {
          ctx.runtimeRepo.upsert?.({
            ...account,
            status: 'ready',
            cooldown_until: null,
            cooldown_reason: null,
          })
        }
        try {
          audit(
            getDb(),
            panelIdentity(req).user,
            'account.error_protection.clear',
            accountId,
            current.state,
            cleared,
            'manual account protection clear',
          )
        } catch {}
        wakeOpenAIWaiter(account?.vm_id || accountId)
        return json(res, 200, {
          ok: true,
          account_id: accountId,
          protection_state: cleared,
          protection_generation: nextGeneration,
          cooldown_cleared: cooldownCleared,
        })
      }
      if (p === '/api/panel/site' && req.method === 'PUT') {
        try {
          return json(res, 200, {
            ok: true,
            data: saveSiteBranding(panelUsers.db, await readBody(req, 1024 * 1024), panelIdentity(req).user),
          })
        } catch (e) {
          return json(res, e.status || 400, { ok: false, error: { code: e.code, message: e.message } })
        }
      }
      if (
        (p === '/api/panel/me/profile' && ['GET', 'PATCH'].includes(req.method)) ||
        (p === '/api/panel/me/password' && req.method === 'POST')
      ) {
        try {
          const id = req.panelUserId
          if (req.method === 'GET') return json(res, 200, { ok: true, data: profileView(ownProfile(panelUsers, id)) })
          const input = await readBody(req, 4096)
          if (p.endsWith('/password')) {
            const username = changeOwnPassword(panelUsers, id, input)
            revokePanelSessionsForUser(username, { exceptToken: extractPanelToken(req) })
            return json(res, 200, { ok: true, data: { changed: true } })
          }
          return json(res, 200, { ok: true, data: updateOwnProfile(panelUsers, id, input) })
        } catch (e) {
          return json(res, e.status || 400, { ok: false, error: { code: e.code, message: e.message } })
        }
      }
      if (await handleVmBulk(req, res, url)) return true
      if (await handleRelay(req, res, url)) return true
      if ((req.method === 'GET' || req.method === 'PUT') && p === '/api/panel/onboarding') {
        if (req.method === 'PUT') {
          const body = await readBody(req, 4096).catch(() => ({}))
          if (body?.action === 'profile' && panelIdentity(req).role !== 'super_admin') {
            return json(res, 403, {
              ok: false,
              error: { code: 'forbidden', message: '当前权限无法执行此操作' },
            })
          }
          try {
            const settings = new SettingsRepo()
            const user = onboardingUserOf(req)
            const state = loadOnboardingState(settings)
            let next
            if (body?.action === 'profile') {
              applyUsageProfile({
                mode: body?.mode,
                persistRouting: (patch) => persistRoutingPatch(patch),
                settings,
                distillFile: distillFile(),
                setDistill: (rules) => {
                  cfg.distill = rules
                },
              })
              next = setOnboardingProfile(state, user, body?.mode)
            } else {
              next = applyOnboardingAction(state, user, body?.action)
            }
            saveOnboardingState(settings, next)
          } catch (e) {
            if (e.code === 'invalid_action' || e.code === 'invalid_profile') {
              return json(res, 400, {
                ok: false,
                error: { message: String(e.message || e), code: e.code },
              })
            }
            throw e
          }
        }
        return json(res, 200, panel.ok(onboardingPayloadFor(req, ctx)))
      }
      if (p.startsWith('/api/panel/cluster/')) return ctx.clusterRoutes.handle(req, res, url)
      if (req.method === 'GET' && p === '/api/panel/database/metrics') {
        const snapshot = snapshotDatabaseMetrics({
          db: getDb(),
          dbPath: getDbPath(),
          usageCache: getUsageCache(),
        })
        return json(res, 200, panel.ok({ ...snapshot, runtime: runtimeMetrics.snapshot() }))
      }
      if (req.method === 'GET' && p === '/api/panel/version') {
        res.setHeader?.('Cache-Control', 'no-store')
        const upgrade = await readHostUpgradeStatus()
        const status = await buildUpdateStatus({
          projectRoot: cfg?.paths?.project,
          currentVersion: runningVersion,
          force: url.searchParams.get('force') === '1',
          upgrade,
          skipRemote: url.searchParams.get('status') === '1' || upgrade?.state === 'running',
        })
        return json(res, 200, panel.ok(status))
      }
      if (req.method === 'GET' && p === '/api/panel/changelog') {
        const current = runningVersion
        const entries = loadChangelog(cfg?.paths?.project)
        return json(res, 200, panel.ok({ current, current_tag: `v${current}`, entries }))
      }
      if (req.method === 'POST' && p === '/api/panel/update') {
        const body = await readBody(req, 8192).catch(() => ({}))
        const result = await startHostUpgrade({
          projectRoot: cfg?.paths?.project,
          currentVersion: runningVersion,
          confirm: body?.confirm === true,
          version: body?.version,
        })
        if (result.error) {
          return json(res, result.status, {
            ok: false,
            error: result.error,
            data: result.data || null,
          })
        }
        return json(res, result.status, panel.ok(result.data))
      }
      if (await handlePanelUsers(req, res, p)) return true
      if (await handlePanelApiKeys(req, res, p, url)) return true
      if (await handlePanelApiEndpoints(req, res, p)) return true
      if (await handlePanelVmReadRoutes(req, res, p)) return true
      if (await handlePanelVmProvisionRoutes(req, res, p)) return true
      if (await handlePanelVmImportRoutes(req, res, p)) return true
      if (await handlePanelVmCommandRoutes(req, res, p)) return true
      if (await handlePanelVmLifecycleRoutes(req, res, p)) return true
      if (await handlePanelVmDiagnoseRoutes(req, res, p)) return true
      if (await handlePanelVmProbeRoutes(req, res, p)) return true
      if (await handlePanelVmQuotaRoutes(req, res, p)) return true
      if (await handlePanelVmTestRoutes(req, res, p, url)) return true
      if (await handlePanelVmCredentialRoutes(req, res, p)) return true
      if (await handlePanelVmRuntimeRoutes(req, res, p)) return true
      if (await handlePanelVmOauthQueryRoutes(req, res, p)) return true
      if (await handlePanelVmOauthMutationRoutes(req, res, p)) return true
      if (await handlePanelVmSeedRoutes(req, res, p)) return true
      if (await handlePanelVmPackageRoutes(req, res, p)) return true
      if (await handlePanelVmResetRoutes(req, res, p)) return true
      if (await handlePanelVmMaintenanceRoutes(req, res, p)) return true
      if (req.method === 'POST' && p === '/api/panel/anthropic/messages') {
        const body = await readBody(req, 64 * 1024).catch(() => ({}))
        try {
          const result = await runAnthropicConsole({
            cfg,
            scheduler: apiScheduler,
            proxyPool,
            store: apiEndpointStore,
            input: body || {},
            forward: ctx.forwardApi,
          })
          return json(res, 200, { ok: true, data: result })
        } catch (e) {
          const status = e.status && e.status < 600 ? e.status : 400
          return json(res, status, {
            ok: false,
            error: { message: String(e.message || e), code: e.code || 'anthropic_console_failed' },
          })
        }
      }

      // ---- Request logs (normal summary + debug full; DB-backed filters/pagination) ----
      if (req.method === 'GET' && p === '/api/panel/request-logs') {
        const u = new URL(req.url, 'http://x')
        const mode = (u.searchParams.get('mode') || 'normal').toLowerCase()
        const limit = Number(u.searchParams.get('limit') || 50)
        if (mode === 'debug' && panelIdentity(req).role !== 'super_admin')
          return json(res, 403, { ok: false, error: { code: 'forbidden', message: '调试原文仅超级管理员可查看' } })
        if (mode === 'debug') {
          return json(res, 200, {
            ok: true,
            mode: 'debug',
            config: requestLog.snapshot(),
            items: requestLog.listDebug({
              limit,
              error_class: u.searchParams.get('error_class') || null,
              exclude_error_class: u.searchParams.get('exclude_error_class') || null,
              include_muted: u.searchParams.get('include_muted') === '1',
              owner_user_id: logsOwner(req, u),
            }),
          })
        }
        const filters = {
          limit,
          offset: Number(u.searchParams.get('offset') || 0),
          api_key_id: u.searchParams.get('api_key_id') || null,
          vm_id: u.searchParams.get('vm_id') || null,
          account_id: u.searchParams.get('account_id') || null,
          model: u.searchParams.get('model') || null,
          protocol: u.searchParams.get('protocol') || null,
          status: u.searchParams.get('status') || null,
          error_class: u.searchParams.get('error_class') || null,
          exclude_error_class: u.searchParams.get('exclude_error_class') || null,
          include_muted: u.searchParams.get('include_muted') === '1',
          since: u.searchParams.get('since') || null,
          until: u.searchParams.get('until') || null,
          q: u.searchParams.get('q') || null,
          owner_user_id: logsOwner(req, u),
        }
        const { items, total } = requestLog.queryNormal(filters)
        return json(res, 200, {
          ok: true,
          mode: 'normal',
          config: requestLog.snapshot(),
          items,
          total,
          limit: filters.limit,
          offset: filters.offset,
        })
      }
      if (req.method === 'GET' && p === '/api/panel/request-logs/export') {
        const u = new URL(req.url, 'http://x')
        const format = (u.searchParams.get('format') || 'jsonl').toLowerCase() === 'csv' ? 'csv' : 'jsonl'
        // Same filter parsing as the scrolling list, so "export current view" matches the page.
        // Older `/request-logs` keys stay accepted as fallbacks.
        const legacy = (k) => u.searchParams.get(k) || null
        const listed = usageLogFilters(req, u, cfg.paths.project)
        const legacyStatus = legacy('status')
        const filters = {
          ...listed,
          limit: legacy('limit') || 2000,
          key_id: listed.key_id || legacy('api_key_id'),
          start_time: listed.start_time || legacy('since'),
          end_time: listed.end_time || legacy('until'),
          status_code: listed.status_code || (/^\d+$/.test(legacyStatus || '') ? legacyStatus : null),
          errors_only: listed.errors_only || legacyStatus === 'error',
        }
        const exported =
          (await readUsage('view', 'exportRows', [filters])) ||
          new UsageLogsView(ctx.db || getDb(), { mutedErrorClasses: requestLog?.mutedErrorClasses }).exportRows(filters)
        const { items, total, capped } = exported
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')
        const safeItems = projectUsage(items, panelIdentity(req).role)
        const body = format === 'csv' ? logsToCsv(safeItems) : logsToJsonl(safeItems)
        const filename = `tapmodels-logs-${stamp}.${format}`
        res.writeHead(
          200,
          corsHeadersForRequest(req, {
            'content-type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8',
            'content-disposition': `attachment; filename="${filename}"`,
            'x-kin-export-count': String(items.length),
            'x-kin-export-total': String(total),
            'x-kin-export-truncated': items.length < total || capped ? '1' : '0',
            'access-control-expose-headers':
              'content-disposition, x-kin-export-count, x-kin-export-total, x-kin-export-truncated',
          }),
        )
        res.end(body)
        return
      }
      // ---- Aggregated usage stats from request_logs (charts) ----
      if (req.method === 'GET' && p === '/api/panel/request-logs/stats') {
        const u = new URL(req.url, 'http://x')
        const bucket = (u.searchParams.get('bucket') || 'day').toLowerCase() === 'hour' ? 'hour' : 'day'
        const since = u.searchParams.get('since') || new Date(Date.now() - 7 * 86400_000).toISOString()
        const until = u.searchParams.get('until') || null
        const tenant = panelIdentity(req).role !== 'super_admin'
        const owner_user_id = logsOwner(req, u)
        let totals
        let buckets
        let window
        if (usagePoolEnabled()) {
          try {
            const jobs = [
              usageRead({ kind: 'repo', method: 'aggregate', args: [{ since, until, bucket, owner_user_id }] }),
              usageRead({ kind: 'repo', method: 'windowStats', args: [{ since, until, owner_user_id }] }),
            ]
            if (!tenant) jobs.unshift(usageRead({ kind: 'repo', method: 'totals' }))
            const out = await Promise.all(jobs)
            if (tenant) [buckets, window] = out
            else [totals, buckets, window] = out
          } catch (err) {
            console.warn(`[sqlite-pool] repo.stats: ${err?.message || err}`)
          }
        }
        if (buckets === undefined) {
          totals = tenant ? null : requestLog.totals()
          buckets = requestLog.aggregate({ since, until, bucket, owner_user_id })
          window = requestLog.windowStats({ since, until, owner_user_id })
        }
        return json(res, 200, {
          ok: true,
          bucket,
          since,
          until,
          totals: totals ?? null,
          buckets,
          window,
          muted_error_classes: requestLog.snapshot().muted_error_classes,
          config: tenant ? null : requestLog.snapshot(),
        })
      }
      if (req.method === 'GET' && /^\/api\/panel\/request-logs\/[^/]+\/attempts$/.test(p)) {
        if (panelIdentity(req).role === 'user')
          return json(res, 403, { ok: false, error: { code: 'forbidden', message: '内部尝试仅运维可查看' } })
        const requestId = p.split('/')[4]
        const owner_user_id = logsOwner(req, url)
        if (owner_user_id && !requestLog.getDebug(requestId, { owner_user_id })) {
          return json(res, 404, { ok: false, error: { message: 'debug log not found' } })
        }
        return json(
          res,
          200,
          panel.ok({
            request_id: requestId,
            attempts:
              (typeof ctx.getAttemptsRepo === 'function' ? ctx.getAttemptsRepo() : ctx.attemptsRepo)?.list?.(
                requestId,
              ) || [],
          }),
        )
      }
      if (req.method === 'GET' && /^\/api\/panel\/request-logs\/[^/]+$/.test(p)) {
        const id = p.split('/').pop()
        const owner_user_id = logsOwner(req, url)
        const rec = requestLog.getDebug(id, { owner_user_id })
        if (!rec) return json(res, 404, { ok: false, error: { message: 'debug log not found' } })
        return json(res, 200, { ok: true, item: rec })
      }

      // ---- Scrolling usage logs (keyset cursor, camelCase rows) ----
      // Lives beside /request-logs (offset + snake_case, still used by error
      // collection and export); this surface never COUNTs the table.
      const usageLogsView = () =>
        new UsageLogsView(ctx.db || getDb(), { mutedErrorClasses: requestLog?.mutedErrorClasses })
      const readView = async (method, ...args) =>
        (await readUsage('view', method, args)) ?? usageLogsView()[method](...args)
      const tenantId = () => logsOwner(req, url)
      if (req.method === 'GET' && p === '/api/panel/usage-logs') {
        const u = new URL(req.url, 'http://x')
        return json(res, 200, panel.ok(await readView('listBatch', usageLogFilters(req, u, cfg.paths.project))))
      }
      if (req.method === 'GET' && p === '/api/panel/usage-logs/ranking') {
        const scope = (url.searchParams.get('rank_by') || url.searchParams.get('scope')) === 'user' ? 'user' : 'key'
        if (scope === 'user' && panelIdentity(req).role === 'user')
          return json(res, 403, { ok: false, error: { code: 'forbidden', message: '只能查看本人 Key 排行' } })
        const out = await readView('ranking', usageLogFilters(req, url, cfg.paths.project), scope)
        if (panelIdentity(req).role === 'user') out.entries = out.entries.map(({ owner, ...entry }) => entry)
        return json(res, 200, panel.ok(out))
      }
      if (req.method === 'GET' && p === '/api/panel/usage-logs/summary') {
        const u = new URL(req.url, 'http://x')
        return json(res, 200, panel.ok(await readView('summary', usageLogFilters(req, u, cfg.paths.project))))
      }
      if (req.method === 'GET' && p === '/api/panel/usage-logs/filter-options') {
        return json(
          res,
          200,
          panel.ok(
            await readView('filterOptions', {
              owner_user_id: tenantId(),
              vm_platforms: vmPlatforms(cfg.paths.project),
            }),
          ),
        )
      }
      if (req.method === 'GET' && p === '/api/panel/usage-logs/active-sessions') {
        const u = new URL(req.url, 'http://x')
        const minutes = u.searchParams.get('minutes')
        const limit = u.searchParams.get('limit')
        return json(res, 200, panel.ok(await readView('activeSessions', { minutes, limit, owner_user_id: tenantId() })))
      }
      if (req.method === 'GET' && p === '/api/panel/usage-logs/overview') {
        return json(res, 200, panel.ok(await readView('overview', { owner_user_id: tenantId() })))
      }

      // ---- Statistics page ----
      if (req.method === 'GET' && p === '/api/panel/statistics') {
        const u = new URL(req.url, 'http://x')
        const q = statsParams(req, u, 'dimension')
        if (q.error) return json(res, 400, { ok: false, error: { message: q.error } })
        const { range, dimension, tz, owner_user_id } = q
        return json(res, 200, panel.ok(new StatisticsRepo(getDb()).statistics({ range, dimension, tz, owner_user_id })))
      }
      if (req.method === 'GET' && p === '/api/panel/statistics/leaderboard') {
        const u = new URL(req.url, 'http://x')
        const q = statsParams(req, u, 'scope')
        if (q.error) return json(res, 400, { ok: false, error: { message: q.error } })
        const { range, dimension: scope, tz, owner_user_id } = q
        const limit = u.searchParams.get('limit')
        return json(
          res,
          200,
          panel.ok(new StatisticsRepo(getDb()).leaderboard({ range, scope, limit, tz, owner_user_id })),
        )
      }

      if (await handlePanelBackups(req, res, p)) return true

      // GET /api/panel/dashboard
      if (req.method === 'GET' && p === '/api/panel/dashboard') {
        return json(
          res,
          200,
          await panel.buildDashboard({
            cfg,
            accountQuota,
            stickyRouter,
            routingConfig: ctx.routingConfig,
            stats,
            requestLog,
            poolScheduler: ctx.poolScheduler,
            proxyPool,
            clusterNodes: clusterNodesOf(ctx),
          }),
        )
      }
      // GET /api/panel/pool/stream — live seat / queue snapshots (SSE over fetch).
      if (req.method === 'GET' && p === '/api/panel/pool/stream') {
        const ident = panelIdentity(req)
        const ownerUserId = ident.role === 'user' ? req.panelUserId : null
        return servePoolSeatStream({
          req,
          res,
          getScheduler: () => ctx.poolScheduler,
          proxyPool,
          writeSSEHeaders: ctx.writeSSEHeaders,
          visibleVmIds:
            ident.role === 'user'
              ? () =>
                  new Set(
                    filterVmsForPanel(listVms(cfg.paths.project, ctx.routingConfig), {
                      role: ident.role,
                      userId: ownerUserId,
                    }).map((vm) => vm.id),
                  )
              : null,
        })
      }
      if (req.method === 'GET' && p === '/api/panel/wrap-cli') {
        const sample = describeWrapSample(cfg.paths.project)
        return json(
          res,
          200,
          panel.ok({
            ...sample,
            dataplane: resolveKernelDataplane({}, ctx.routingConfig) || 'wrap',
          }),
        )
      }
      if (req.method === 'POST' && p === '/api/panel/dataplane') {
        const body = await readBody(req, 8 * 1024).catch(() => ({}))
        const parsed = parseKernelDataplanePatch(body.dataplane)
        if (!parsed.ok || !parsed.value) {
          return json(res, 400, {
            ok: false,
            error: { code: 'invalid_dataplane', message: parsed.error || 'dataplane must be wrap, cc, or crag' },
          })
        }
        const targets = parseSlotPolicyTargets({
          ids: body.ids,
          all: body.all === true || !Array.isArray(body.ids),
        })
        if (!targets.ok) {
          return json(res, 400, { ok: false, error: { message: targets.error } })
        }
        const previous = structuredClone(ctx.routingConfig)
        try {
          if (targets.all) {
            persistRoutingPatch({
              inference: {
                ...(ctx.routingConfig.inference || {}),
                dataplane: parsed.value,
              },
            })
          } else {
            for (const id of targets.ids) {
              persistSlotEnginePolicy(cfg.paths.project, id, { dataplane: parsed.value })
            }
          }
        } catch (error) {
          ctx.routingConfig = previous
          return json(res, 503, {
            ok: false,
            error: { code: 'dataplane_persist_failed', message: String(error?.message || error) },
          })
        }
        const report = await syncInstalledKernels({
          project: cfg.paths.project,
          routingConfig: ctx.routingConfig,
          body: {
            ids: targets.all ? undefined : targets.ids,
            restart: body.restart !== false,
          },
        })
        return json(
          res,
          report.ok ? 200 : 503,
          panel.ok({
            dataplane: parsed.value,
            ...report,
          }),
        )
      }
      if (req.method === 'POST' && p === '/api/panel/wrap-cli/crag-kernel') {
        const raw = await readRawBody(req, 32 * 1024 * 1024)
        const written = replaceCragKernelBinary(cfg.paths.project, raw)
        if (!written.ok) {
          return json(res, 400, { ok: false, error: { code: written.code, message: written.error } })
        }
        return json(res, 200, panel.ok(written))
      }
      if (req.method === 'POST' && p === '/api/panel/wrap-cli/make') {
        const body = await readBody(req, 8 * 1024).catch(() => ({}))
        const glibcVm = String(body.glibc_vm || body.glibcVm || '').trim()
        let glibcFromDir = ''
        if (glibcVm) {
          const candidate = path.join(wrapCliHomeDir(cfg.paths.project, glibcVm), 'glibc239')
          if (fs.existsSync(candidate)) glibcFromDir = candidate
        }
        const made = makeWrapSample(cfg.paths.project, { glibcFromDir })
        if (!made.ok) {
          return json(res, 400, { ok: false, error: { code: made.code, message: made.error } })
        }
        return json(res, 200, panel.ok(made))
      }
      if (req.method === 'POST' && p === '/api/panel/wrap-cli/kernel/release') {
        const body = await readBody(req, 8 * 1024).catch(() => ({}))
        const downloaded = await downloadReleaseKernel({
          tag: body.tag,
          fetchImpl: ctx.fetchImpl,
        })
        if (!downloaded.ok) {
          return json(res, kernelReleaseHttpStatus(downloaded.code), {
            ok: false,
            error: { code: downloaded.code, message: downloaded.error },
          })
        }
        const replaced = replaceKernelBinary(cfg.paths.project, downloaded.bytes, {
          source: 'github',
          release_tag: downloaded.tag,
        })
        if (!replaced.ok) {
          return json(res, 400, { ok: false, error: { code: replaced.code, message: replaced.error } })
        }
        const cliNode = replaceCliNodeBinary(cfg.paths.project, downloaded.cliNode?.bytes)
        if (!cliNode.ok) {
          return json(res, 400, { ok: false, error: { code: cliNode.code, message: cliNode.error } })
        }
        const ccNode = replaceCcNodeBinary(cfg.paths.project, downloaded.ccNode?.bytes)
        if (!ccNode.ok) {
          return json(res, 400, { ok: false, error: { code: ccNode.code, message: ccNode.error } })
        }
        const cragWritten = replaceCragKernelBinary(cfg.paths.project, downloaded.crag?.bytes)
        if (!cragWritten.ok) {
          return json(res, 400, { ok: false, error: { code: cragWritten.code, message: cragWritten.error } })
        }
        const report = await syncInstalledKernels({
          project: cfg.paths.project,
          routingConfig: ctx.routingConfig,
          body,
        })
        const release = {
          tag: downloaded.tag,
          version: downloaded.version,
          asset: downloaded.asset,
          size: downloaded.size,
          cli_node: downloaded.cliNode?.asset,
          cli_node_size: cliNode.size,
          cc_node: downloaded.ccNode?.asset,
          cc_node_size: ccNode.size,
          crag: downloaded.crag?.asset || null,
          crag_size: cragWritten.size || 0,
          crag_skipped: false,
        }
        if (!report.ok) {
          return json(res, 400, {
            ok: false,
            error: {
              code: 'kernel_sync_failed',
              message: `已写入 ${downloaded.tag}，槽同步 ${report.ok_count}/${report.total} 失败`,
            },
            data: { release, kernel: replaced, sync: report },
          })
        }
        return json(res, 200, panel.ok({ release, kernel: replaced, sync: report }))
      }

      if (req.method === 'POST' && p === '/api/panel/wrap-cli/kernel') {
        let buf
        try {
          buf = await readRawBody(req, cfg.limits?.max_body_bytes || 32 * 1024 * 1024)
        } catch (error) {
          const status = error?.status || 400
          const body = error?.body || { error: { message: String(error?.message || error) } }
          return json(res, status, { ok: false, ...body })
        }
        if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf || [])
        if (!buf.length) {
          return json(res, 400, { ok: false, error: { code: 'kernel_empty', message: 'kernel binary required' } })
        }
        const replaced = replaceKernelBinary(cfg.paths.project, buf)
        if (!replaced.ok) {
          return json(res, 400, { ok: false, error: { code: replaced.code, message: replaced.error } })
        }
        return json(res, 200, panel.ok(replaced))
      }

      if (req.method === 'POST' && p === '/api/panel/wrap-cli/sync') {
        const body = await readBody(req, 32 * 1024).catch(() => ({}))
        const report = await syncInstalledKernels({
          project: cfg.paths.project,
          routingConfig: ctx.routingConfig,
          body,
          refreshCluster,
        })
        return json(res, report.ok ? 200 : 400, panel.ok(report))
      }
      if (req.method === 'POST' && p === '/api/panel/vms/slot-policy') {
        const body = await readBody(req, 32 * 1024).catch(() => ({}))
        const parsed = parseSlotEnginePolicyPatch(body)
        if (!parsed.ok) return json(res, 400, { ok: false, error: { message: parsed.error } })
        const targets = parseSlotPolicyTargets(body)
        if (!targets.ok) return json(res, 400, { ok: false, error: { message: targets.error } })
        const ids = targets.all ? listVms(cfg.paths.project).map((vm) => vm.id) : targets.ids
        const results = []
        for (const id of ids) results.push(await applySlotPolicyWithRuntime(id, parsed.patch))
        const failed = results.filter((item) => !item.ok)
        const report = {
          updated: results.length - failed.length,
          missing: failed.filter((item) => item.code === 'vm_not_found').map((item) => item.id),
          failed: failed.map(({ id, code, error }) => ({ id, code, error })),
          items: results
            .filter((item) => item.ok)
            .map((item) => summarizeVm(item.vm, cfg.paths.project, ctx.routingConfig)),
        }
        return json(res, 200, panel.ok(report))
      }
      // POST /api/panel/vms/pool-policy — batch slot policy
      // ({ ids: [...] } or { all: true }, plus any of weight / schedule_level /
      //  max_concurrency / max_rpm / max_sessions). Same pins and inherit
      //  semantics as the single-slot PATCH, but it only writes the records:
      //  the PATCH rebuilds a full slot detail (~4s each on a busy host), so
      //  fanning that out over 100+ slots starves the control plane.
      if (req.method === 'POST' && p === '/api/panel/vms/pool-policy') {
        const body = await readBody(req, 64 * 1024).catch(() => ({}))
        const targets = parseSlotPolicyTargets(body)
        if (!targets.ok) return json(res, 400, { ok: false, error: { message: targets.error } })
        const has = (key) => Object.prototype.hasOwnProperty.call(body, key)
        const hasWeight = has('weight')
        const hasLevel = has('schedule_level')
        const hasConc = has('max_concurrency')
        const hasRpm = has('max_rpm')
        const hasSessions = has('max_sessions')
        if (!hasWeight && !hasLevel && !hasConc && !hasRpm && !hasSessions) {
          return json(res, 400, {
            ok: false,
            error: { message: 'weight, schedule_level, max_concurrency, max_rpm or max_sessions required' },
          })
        }
        // null (or '') unpins a slot: weight goes back to the default 1,
        // schedule_level to auto, and the runtime caps to their tier / global
        // default — exactly what the single-slot PATCH does.
        const readIntOrNull = (value, min, max, label) => {
          if (value === null || value === '') return { ok: true, value: null }
          if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
            return { ok: false, error: `${label} must be an integer from ${min} to ${max}, or null` }
          }
          return { ok: true, value }
        }
        let nextWeight = null
        if (hasWeight) {
          const parsed = readIntOrNull(body.weight, 1, 100, 'weight')
          if (!parsed.ok) {
            return json(res, 400, { ok: false, error: { code: 'invalid_weight', message: parsed.error } })
          }
          nextWeight = parsed.value === null ? 1 : parsed.value
        }
        let nextLevel = null
        if (hasLevel) {
          const parsed = parseScheduleLevelInput(body.schedule_level)
          if (!parsed.ok) return json(res, 400, { ok: false, error: { message: parsed.error } })
          nextLevel = parsed.value
        }
        let nextConc = null
        if (hasConc) {
          const parsed = readIntOrNull(body.max_concurrency, 1, 256, 'max_concurrency')
          if (!parsed.ok) {
            return json(res, 400, { ok: false, error: { code: 'invalid_concurrency', message: parsed.error } })
          }
          nextConc = parsed.value
        }
        let nextRpm = null
        if (hasRpm) {
          const parsed = readIntOrNull(body.max_rpm, 0, 1_000_000, 'max_rpm')
          if (!parsed.ok) {
            return json(res, 400, { ok: false, error: { code: 'invalid_rpm', message: parsed.error } })
          }
          nextRpm = parsed.value
        }
        let nextSessions = null
        if (hasSessions) {
          const parsed = readIntOrNull(body.max_sessions, 0, 256, 'max_sessions')
          if (!parsed.ok) {
            return json(res, 400, { ok: false, error: { code: 'invalid_sessions', message: parsed.error } })
          }
          nextSessions = parsed.value
        }
        const ids = targets.all ? listVms(cfg.paths.project).map((vm) => vm.id) : targets.ids
        const missing = []
        const failed = []
        const items = []
        for (const id of ids) {
          try {
            let record = null
            if (hasWeight || hasLevel) {
              record = patchVmRecord(cfg.paths.project, id, (current) => {
                const policy = { ...(current.policy || {}) }
                if (hasWeight) policy.weight = nextWeight
                if (hasLevel) {
                  if (nextLevel == null) delete policy.priority
                  else policy.priority = nextLevel
                }
                return { policy }
              })
            } else {
              record = getVm(cfg.paths.project, id)
            }
            if (!record) {
              missing.push(id)
              continue
            }
            if (hasConc && nextConc !== null) applyVmConcurrency(id, nextConc, { override: true })
            if (hasRpm && nextRpm !== null) applyVmRpm(id, nextRpm, { override: true })
            if (hasSessions && nextSessions !== null) ctx.applyVmMaxSessions(id, nextSessions, { override: true })
            const inherit = {}
            if (hasConc && nextConc === null) inherit.concurrency = true
            if (hasRpm && nextRpm === null) inherit.rpm = true
            if (hasSessions && nextSessions === null) inherit.maxSessions = true
            if (Object.keys(inherit).length) inheritVmScheduling(id, inherit)
            const fresh = getVm(cfg.paths.project, id) || record
            const policy = fresh.policy || {}
            items.push({
              id,
              weight: Number(policy.weight ?? 1),
              schedule_level: manualScheduleLevelOf(fresh) ?? 'auto',
              max_concurrency: policy.maxConcurrency ?? null,
              concurrency_override: !!policy.concurrencyOverride,
              max_rpm: policy.maxRpm ?? null,
              max_sessions: policy.maxSessions ?? null,
            })
          } catch (error) {
            failed.push({ id, error: (error && error.message) || String(error) })
          }
        }
        return json(res, 200, panel.ok({ updated: items.length, missing, failed, items }))
      }
      // PATCH /api/panel/vms/:id — hot concurrency / allowed models (no VM restart)
      if (req.method === 'PATCH' && /^\/api\/panel\/vms\/[^/]+$/.test(p)) {
        const id = p.split('/').pop()
        const body = await readBody(req, 8192).catch(() => ({}))
        const currentVm = getVm(cfg.paths.project, id)
        if (!currentVm) return json(res, 404, { ok: false, error: { message: 'vm not found' } })
        const strictInteger = (value, min, max, label, { nullable = false } = {}) => {
          if (nullable && value === null) return null
          if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
            throw new TypeError(`${label} must be an integer`)
          }
          if (value < min || value > max) throw new RangeError(`${label} must be between ${min} and ${max}`)
          return value
        }
        const hasConcurrency =
          Object.prototype.hasOwnProperty.call(body || {}, 'max_concurrency') ||
          Object.prototype.hasOwnProperty.call(body || {}, 'maxConcurrency')
        const hasRpm =
          Object.prototype.hasOwnProperty.call(body || {}, 'max_rpm') ||
          Object.prototype.hasOwnProperty.call(body || {}, 'maxRpm')
        const next = Object.prototype.hasOwnProperty.call(body || {}, 'max_concurrency')
          ? body.max_concurrency
          : body.maxConcurrency
        const nextRpm = Object.prototype.hasOwnProperty.call(body || {}, 'max_rpm') ? body.max_rpm : body.maxRpm
        const hasMaxSessions = body && Object.prototype.hasOwnProperty.call(body, 'max_sessions')
        // Explicit null = drop the slot's pin and follow its tier / global default again.
        const inheritConc = body?.max_concurrency === null
        const inheritRpm = body?.max_rpm === null
        const hasSessionSlots = body && Object.prototype.hasOwnProperty.call(body, 'session_slots')
        const hasQuotaOverride = body && Object.prototype.hasOwnProperty.call(body, 'quota_override')
        const hasModels = body && Object.prototype.hasOwnProperty.call(body, 'allowed_models')
        const hasAuthScheme = body && (body.auth_scheme != null || body.authScheme != null)
        const hasScheduleLevel = body && Object.prototype.hasOwnProperty.call(body, 'schedule_level')
        const hasActiveHours = body && Object.prototype.hasOwnProperty.call(body, 'active_hours')
        const hasTimezone = body && Object.prototype.hasOwnProperty.call(body, 'timezone')
        const hasWeight = body && Object.prototype.hasOwnProperty.call(body, 'weight')
        const hasMemory =
          body &&
          (Object.prototype.hasOwnProperty.call(body, 'memory') ||
            (body.machine &&
              typeof body.machine === 'object' &&
              !Array.isArray(body.machine) &&
              Object.prototype.hasOwnProperty.call(body.machine, 'memory')))
        // `timezone_follow_proxy: true` re-attaches the slot to its exit node's
        // zone, undoing an earlier hand-pinned value.
        const followProxyTz = body?.timezone_follow_proxy === true || body?.timezoneFollowProxy === true
        const hasSlotPolicy =
          body &&
          (Object.prototype.hasOwnProperty.call(body, 'inference_engine') ||
            Object.prototype.hasOwnProperty.call(body, 'persona_preset'))
        if (
          !hasConcurrency &&
          !hasRpm &&
          !inheritConc &&
          !inheritRpm &&
          !hasSessionSlots &&
          !hasMaxSessions &&
          !hasQuotaOverride &&
          !hasModels &&
          !hasAuthScheme &&
          !hasSlotPolicy &&
          !hasScheduleLevel &&
          !hasActiveHours &&
          !hasTimezone &&
          !hasWeight &&
          !hasMemory &&
          !followProxyTz
        ) {
          return json(res, 400, {
            ok: false,
            error: {
              message:
                'max_concurrency, max_rpm, max_sessions, session_slots, quota_override, allowed_models, auth_scheme, inference_engine, persona_preset, schedule_level, active_hours, timezone, weight, machine.memory or timezone_follow_proxy required',
            },
          })
        }
        try {
          if (hasConcurrency && next !== null) strictInteger(next, 1, 256, 'max_concurrency')
          if (hasRpm && nextRpm !== null) strictInteger(nextRpm, 0, 1_000_000, 'max_rpm')
          if (hasSessionSlots && body.session_slots !== null)
            strictInteger(body.session_slots, SESSION_SLOT_MIN, SESSION_SLOT_MAX, 'session_slots')
          if (hasMaxSessions && body.max_sessions !== null) strictInteger(body.max_sessions, 0, 256, 'max_sessions')
          // null puts the slot back on the default weight of 1
          if (hasWeight && body.weight !== null) strictInteger(body.weight, 1, 100, 'weight')
        } catch (error) {
          return json(res, 400, {
            ok: false,
            error: { code: 'invalid_scheduling_value', message: error.message },
          })
        }
        const parsedScheduleLevel = hasScheduleLevel ? parseScheduleLevelInput(body.schedule_level) : null
        if (parsedScheduleLevel && !parsedScheduleLevel.ok) {
          return json(res, 400, { ok: false, error: { message: parsedScheduleLevel.error } })
        }
        const parsedActiveHours = hasActiveHours ? parseActiveHoursInput(body.active_hours) : null
        if (parsedActiveHours && !parsedActiveHours.ok) {
          return json(res, 400, { ok: false, error: { message: parsedActiveHours.error } })
        }
        const parsedQuotaOverride = hasQuotaOverride ? parseVmQuotaOverride(body.quota_override) : null
        if (parsedQuotaOverride && !parsedQuotaOverride.ok) {
          return json(res, 400, { ok: false, error: { message: parsedQuotaOverride.error } })
        }
        if (parsedQuotaOverride) {
          if (isCodexVm(currentVm)) {
            return json(res, 400, {
              ok: false,
              error: { code: 'gpt_quota_override_forbidden', message: 'GPT slots do not use Claude quota tiers' },
            })
          }
        }
        if (hasSessionSlots && isCodexVm(currentVm)) {
          return json(res, 400, {
            ok: false,
            error: { code: 'gpt_session_slots_forbidden', message: 'GPT slots do not use native session slots' },
          })
        }
        if (hasMaxSessions && !isCodexVm(currentVm)) {
          return json(res, 400, {
            ok: false,
            error: { code: 'claude_max_sessions_forbidden', message: 'Claude 槽不使用 OpenAI 会话容量上限' },
          })
        }
        if (hasAuthScheme && hostUnsupported(res, currentVm, 'auth_scheme')) return
        if (
          hasSlotPolicy &&
          Object.prototype.hasOwnProperty.call(body, 'inference_engine') &&
          (isCodexVm(currentVm) || hostUnsupported(res, currentVm, 'engine_switch'))
        ) {
          if (isCodexVm(currentVm)) {
            return json(res, 400, {
              ok: false,
              error: { code: 'gpt_engine_forbidden', message: 'GPT slots do not use go or rust inference engines' },
            })
          }
          return
        }
        if (hasModels) {
          const parsed = parseAllowedModelsPatch(body.allowed_models, { vm: currentVm })
          if (!parsed.ok) return json(res, 400, { ok: false, error: { message: parsed.error } })
        }
        if (hasSlotPolicy) {
          const parsed = parseSlotEnginePolicyPatch(body)
          if (!parsed.ok) return json(res, 400, { ok: false, error: { message: parsed.error } })
        }
        let timezoneSync = null
        if (hasTimezone) {
          // Any IANA zone is allowed — the US presets are UI defaults, not a
          // whitelist. Reject only what Intl (and therefore the container TZ)
          // cannot resolve, so a typo never reaches `docker run -e TZ=`.
          const zone = validTimezone(body.timezone)
          if (!zone) {
            return json(res, 400, {
              ok: false,
              error: {
                type: 'invalid_request_error',
                code: 'invalid_timezone',
                message: '时区必须是有效的 IANA 名称，如 Asia/Tokyo',
                param: 'timezone',
              },
            })
          }
          timezoneSync = { timezone: zone, source: 'manual' }
        } else if (followProxyTz) {
          const synced = await syncVmTimezoneFromProxy(cfg.paths.project, proxyPool, id, {
            force: true,
            persist: false,
          })
          if (!synced.ok) {
            return json(res, 400, {
              ok: false,
              error: {
                type: 'invalid_request_error',
                code: synced.reason || 'proxy_timezone_unknown',
                message: '未能从代理节点取到时区，请先检测代理地理位置',
              },
            })
          }
          timezoneSync = { applied: false, timezone: synced.timezone, source: 'proxy_geo' }
        }
        if (hasConcurrency && next !== null) {
          const vm = applyVmConcurrency(id, next, { override: true })
          if (!vm) return json(res, 404, { ok: false, error: { message: 'vm not found' } })
        }
        if (hasRpm && nextRpm !== null) {
          const vm = applyVmRpm(id, nextRpm, { override: true })
          if (!vm) return json(res, 404, { ok: false, error: { message: 'vm not found' } })
        }
        if ((hasConcurrency && next === null) || (hasRpm && nextRpm === null)) {
          const vm = inheritVmScheduling(id, {
            concurrency: hasConcurrency && next === null,
            rpm: hasRpm && nextRpm === null,
          })
          if (!vm) return json(res, 404, { ok: false, error: { message: 'vm not found' } })
        }
        if (hasSessionSlots) {
          if (body.session_slots === null) {
            inheritVmScheduling(id, { sessionSlots: true })
          } else {
            const vm = applyVmSessionSlots(id, normalizeSessionSlots(body.session_slots), { override: true })
            if (!vm) return json(res, 404, { ok: false, error: { message: 'vm not found' } })
          }
        }
        if (hasMaxSessions) {
          if (body.max_sessions === null) {
            const vm = inheritVmScheduling(id, { maxSessions: true })
            if (!vm) return json(res, 404, { ok: false, error: { message: 'vm not found' } })
          } else {
            const vm = ctx.applyVmMaxSessions(id, body.max_sessions, { override: true })
            if (!vm) return json(res, 404, { ok: false, error: { message: 'vm not found' } })
          }
        }
        if (parsedQuotaOverride) {
          const vm = applyVmQuotaOverride(id, parsedQuotaOverride.value)
          if (!vm) return json(res, 404, { ok: false, error: { message: 'vm not found' } })
        }
        if (hasModels) {
          const parsed = parseAllowedModelsPatch(body.allowed_models, { vm: currentVm })
          const vm = persistAllowedModels(cfg.paths.project, id, parsed.value)
          if (!vm) return json(res, 404, { ok: false, error: { message: 'vm not found' } })
        }
        if (hasAuthScheme) {
          const vm = persistSlotAuthScheme(cfg.paths.project, id, body.auth_scheme || body.authScheme)
          if (!vm) return json(res, 404, { ok: false, error: { message: 'vm not found' } })
        }
        let slotPolicyResult = null
        if (hasSlotPolicy) {
          const parsed = parseSlotEnginePolicyPatch(body)
          slotPolicyResult = await applySlotPolicyWithRuntime(id, parsed.patch)
          if (!slotPolicyResult.ok) {
            const status =
              slotPolicyResult.code === 'vm_not_found'
                ? 404
                : slotPolicyResult.code === 'gpt_engine_forbidden'
                  ? 400
                  : 503
            return json(res, status, {
              ok: false,
              error: {
                code: slotPolicyResult.code,
                message: slotPolicyResult.error || 'inference engine switch failed',
              },
            })
          }
        }
        if (parsedScheduleLevel) {
          const vm = persistVmScheduleLevel(cfg.paths.project, id, parsedScheduleLevel.value)
          if (!vm) return json(res, 404, { ok: false, error: { message: 'vm not found' } })
        }
        if (parsedActiveHours) {
          const vm = persistVmActiveHours(cfg.paths.project, id, parsedActiveHours.value)
          if (!vm) return json(res, 404, { ok: false, error: { message: 'vm not found' } })
        }
        if (hasTimezone) {
          const vm = persistVmTimezone(cfg.paths.project, id, timezoneSync.timezone, { source: 'manual' })
          if (!vm) return json(res, 404, { ok: false, error: { message: 'vm not found' } })
          const kernel = projectSlotKernelConfig(vm)
          timezoneSync.applied = true
          timezoneSync.kernel_hot = kernel?.changed === true
        } else if (followProxyTz) {
          const synced = await syncVmTimezoneFromProxy(cfg.paths.project, proxyPool, id, { force: true })
          timezoneSync = { applied: synced.applied, timezone: synced.timezone, source: 'proxy_geo' }
          if (synced.applied) {
            const kernel = projectSlotKernelConfig({ id })
            timezoneSync.kernel_hot = kernel?.changed === true
          }
        }
        if (hasWeight) {
          const nextWeight = body.weight === null ? 1 : body.weight
          const vm = patchVmRecord(cfg.paths.project, id, (record) => ({
            policy: { ...(record.policy || {}), weight: nextWeight },
          }))
          if (!vm) return json(res, 404, { ok: false, error: { message: 'vm not found' } })
        }
        let memoryRaiseResult = null
        if (hasMemory) {
          const requestedMemory =
            body.machine && typeof body.machine === 'object' && !Array.isArray(body.machine)
              ? body.machine.memory
              : body.memory
          const liveVm = getVm(cfg.paths.project, id) || currentVm
          const raiseMemory = ctx.raiseDockerSlotMemory || raiseDockerSlotMemory
          const raised = raiseMemory(cfg.paths.project, liveVm, requestedMemory, {
            routing: ctx.routingConfig,
          })
          if (!raised.ok) {
            const status =
              raised.code === 'vm_not_found'
                ? 404
                : raised.code === 'invalid_memory' ||
                    raised.code === 'memory_not_increased' ||
                    raised.code === 'kvm_memory_raise_forbidden'
                  ? 400
                  : 502
            return json(res, status, {
              ok: false,
              error: {
                code: raised.code,
                message: raised.message,
                requested: raised.requested ?? requestedMemory ?? null,
                container_memory: raised.container_memory ?? null,
                current: raised.current ?? null,
              },
            })
          }
          memoryRaiseResult = {
            previous: raised.previous,
            memory: raised.memory,
            container_memory: raised.container_memory,
          }
        }
        const detail = await panel.buildVmDetail({
          cfg,
          accountQuota,
          id,
          routingConfig: ctx.routingConfig,
          poolScheduler: ctx.poolScheduler,
          requestLog,
          proxyPool,
          kernelHealth: panelKernelHealth,
          clusterNodes: clusterNodesOf(ctx),
          role: panelIdentity(req).role,
        })
        if (slotPolicyResult && detail?.data) {
          detail.data.engine_switch = {
            configured_engine: slotPolicyResult.configured_engine,
            resolved_engine: slotPolicyResult.resolved_engine,
            active_engine: slotPolicyResult.active_engine,
            runtime: slotPolicyResult.runtime,
          }
        }
        if (timezoneSync && detail?.data) detail.data.timezone_sync = timezoneSync
        if (memoryRaiseResult && detail?.data) detail.data.memory_raise = memoryRaiseResult
        return json(res, 200, detail)
      }

      if (req.method === 'POST' && /^\/api\/panel\/vms\/[^/]+\/count-tokens$/.test(p)) {
        return json(res, 404, { ok: false, error: { code: 'not_found', message: 'not found' } })
      }
      if (req.method === 'POST' && /^\/api\/panel\/vms\/[^/]+\/wrap-cli\/promote$/.test(p)) {
        const id = p.split('/')[4]
        const vm = getVm(cfg.paths.project, id)
        if (!vm) return json(res, 404, { ok: false, error: { message: 'vm not found' } })
        if (hostUnsupported(res, vm, 'wrap_cli')) return
        const captured = captureWrapSample(cfg.paths.project, vm)
        if (!captured.ok) return json(res, 400, { ok: false, error: { code: captured.code, message: captured.error } })
        return json(res, 200, panel.ok(captured))
      }
      if (req.method === 'POST' && /^\/api\/panel\/vms\/[^/]+\/wrap-cli\/repair$/.test(p)) {
        const id = p.split('/')[4]
        const body = await readBody(req, 8 * 1024).catch(() => ({}))
        const mode = body.mode === 'traits' ? 'traits' : 'keep'
        const vm = getVm(cfg.paths.project, id)
        if (!vm) return json(res, 404, { ok: false, error: { message: 'vm not found' } })
        if (isCodexVm(vm)) {
          return json(res, 409, {
            ok: false,
            error: { code: 'codex_kernel_only', message: 'Codex 槽只使用控制面 Codex kernel' },
          })
        }
        if (slotHost(vm).bakedKernel) {
          const refreshed = await refreshCluster(cfg.paths.project, [vm], { routing: ctx.routingConfig })
          const item = refreshed.items[0] || {
            ok: false,
            code: 'slot_payload_refresh_failed',
            error: '集群槽换镜像失败',
          }
          if (!item.ok) return json(res, 400, { ok: false, error: { code: item.code, message: item.error } })
          return json(
            res,
            200,
            panel.ok({ mode, wrap: { ok: true, baked: true, image: item.image }, kernel: item.kernel }),
          )
        }
        if (mode === 'traits') {
          const gone = await destroySlot(vm)
          if (!gone.ok)
            return json(res, 500, { ok: false, error: { code: gone.code, message: gone.error || '重建新特征失败' } })
          const rebuilt = recreateVmFiles(cfg.paths.project, vm, { mode: 'traits' })
          const boot = await startSlotReady(rebuilt.vm, cfg.paths.project, {
            recreate: true,
            routing: ctx.routingConfig,
          })
          if (!boot.ok)
            return json(res, 500, {
              ok: false,
              error: { code: boot.code, message: boot.error || '重建新特征后启动失败' },
            })
          return json(res, 200, panel.ok({ mode, rebuild: 'traits', boot: panel.publicSlotBoot(boot) }))
        }
        const wrap = materializeWrapCli(cfg.paths.project, vm)
        if (!wrap.ok) return json(res, 400, { ok: false, error: { code: wrap.code, message: wrap.error } })
        writeKernelConfig(cfg.paths.project, vm, { routing: ctx.routingConfig })

        let kernel = { ok: false, skipped: true, reason: 'engine_not_rust' }
        if (resolveInferenceEngine(vm, ctx.routingConfig) === 'rust') {
          kernel = await restartRustKernel(slotExec(cfg.paths.project, vm))
        }

        return json(res, 200, panel.ok({ mode, wrap, kernel }))
      }

      if (req.method === 'GET' && /^\/api\/panel\/vms\/[^/]+\/official-cc-bootstrap$/.test(p)) {
        const id = p.split('/')[4]
        const vm = getVm(cfg.paths.project, id)
        if (!vm) return json(res, 404, { ok: false, error: { message: 'vm not found' } })
        return json(
          res,
          200,
          panel.ok({
            vm_id: id,
            status: readOfficialCcStatus(officialCcHome(cfg.paths.project, id)),
          }),
        )
      }
      if (req.method === 'POST' && /^\/api\/panel\/vms\/[^/]+\/official-cc-bootstrap$/.test(p)) {
        const id = p.split('/')[4]
        const vm = getVm(cfg.paths.project, id)
        if (!vm) return json(res, 404, { ok: false, error: { message: 'vm not found' } })
        if (hostUnsupported(res, vm, 'official_cc')) return
        if (!canOfficialCc(vm.claude?.mode)) {
          return json(res, 400, {
            ok: false,
            error: { code: 'credential_mode_unsupported', message: '官方初装只支持完整 OAuth' },
          })
        }
        const body = await readBody(req, 8 * 1024)
        const scheduled = scheduleOfficialCcBootstrap({
          vmId: id,
          projectRoot: cfg.paths.project,
          force: body.force !== false,
          collectIdentity: collectSlotIdentity,
          onStats: officialCcStatsHandler(id, vm.claude?.account_uuid),
          routingFile: routingConfigPath,
          config: ctx.routingConfig.official_cc,
          credentialMode: vm.claude?.mode,
          vm,
          manual: true,
        })
        return json(
          res,
          200,
          panel.ok({
            vm_id: id,
            ...scheduled,
            status: readOfficialCcStatus(officialCcHome(cfg.paths.project, id)),
          }),
        )
      }

      if (req.method === 'GET' && p === '/api/panel/oauth') {
        return json(res, 200, panel.ok(await oauthStatusWithWorker()))
      }

      // POST /api/panel/probe
      if (req.method === 'POST' && p === '/api/panel/probe') {
        const body = await readBody(req, 4096).catch(() => ({}))
        const hop = body?.hop ?? true
        const force = body?.force ?? true
        const result = await panel.buildProbeAll({ cfg, accountQuota, hop, force })
        // Gateway Worker 账号没有 VM 槽，额度由 Worker 读取上游 /wham/usage
        const gatewayItems = await gatewayWorkerService.probeAccountQuotas().catch(() => [])
        if (gatewayItems.length && result?.data) {
          result.data.items = [...(result.data.items || []), ...gatewayItems]
          result.data.total = result.data.items.length
        }
        return json(res, 200, result)
      }
      if (req.method === 'GET' && p === '/api/panel/health-probe') {
        return json(
          res,
          200,
          panel.ok({
            config: ctx.healthMonitor?.getConfig?.() || ctx.routingConfig.health_probe,
            snapshot: ctx.healthMonitor?.getSnapshot?.() || null,
            snapshots: ctx.healthMonitor?.getSnapshots?.() || null,
          }),
        )
      }
      if (req.method === 'POST' && p === '/api/panel/health-probe') {
        const snapshot = await ctx.healthMonitor.runRealProbe()
        return json(
          res,
          200,
          panel.ok({
            config: ctx.healthMonitor.getConfig(),
            snapshot,
            snapshots: ctx.healthMonitor.getSnapshots?.() || null,
          }),
        )
      }
      if (req.method === 'GET' && p === '/api/panel/usage-probe') {
        return json(
          res,
          200,
          panel.ok({
            config: ctx.usageProbeMonitor?.getConfig?.() || ctx.routingConfig.usage_probe,
            snapshot: ctx.usageProbeMonitor?.getSnapshot?.() || null,
          }),
        )
      }
      if (req.method === 'POST' && p === '/api/panel/usage-probe') {
        const snapshot = await ctx.usageProbeMonitor.runOnce()
        return json(
          res,
          200,
          panel.ok({
            config: ctx.usageProbeMonitor.getConfig(),
            snapshot,
          }),
        )
      }
      // GET /api/panel/usage
      if (req.method === 'GET' && p === '/api/panel/usage') {
        return json(res, 200, await panel.buildUsage({ accountQuota, cfg, requestLog }))
      }
      // GET /api/panel/models
      if (req.method === 'GET' && p === '/api/panel/models') {
        return json(res, 200, panel.ok(await fetchWorkerModels()))
      }

      if (req.method === 'GET' && p === '/api/panel/model-policy') {
        const platform = String(url.searchParams.get('platform') || '').toLowerCase()
        if (platform === 'openai' || platform === 'gpt' || platform === 'codex') {
          const pol = getGptModelPolicy()
          const models = listGptPolicyModels()
          return json(
            res,
            200,
            panel.ok({
              policy: pol,
              models,
              effective: models,
              image_tools: listImageToolModels(),
              platform: 'openai',
            }),
          )
        }
        const pol = getModelPolicy()
        return json(
          res,
          200,
          panel.ok({
            policy: pol,
            models: listPolicyModels(),
            effective: listOfficialModels(),
            platform: 'anthropic',
          }),
        )
      }
      if (req.method === 'PUT' && p === '/api/panel/model-policy') {
        const body = await readBody(req, 2 * 1024 * 1024)
        const platform = String(body.platform || url.searchParams.get('platform') || '').toLowerCase()
        if (platform === 'openai' || platform === 'gpt' || platform === 'codex') {
          const saved = saveGptModelPolicy(body.policy || body)
          const models = listGptPolicyModels()
          return json(
            res,
            200,
            panel.ok({
              policy: saved,
              models,
              effective: models,
              image_tools: listImageToolModels(),
              platform: 'openai',
            }),
          )
        }
        const saved = saveModelPolicy(body.policy || body)
        seedModelCatalog()
        syncClaudeKernelConfigs(cfg.paths.project, ctx.routingConfig)
        return json(
          res,
          200,
          panel.ok({
            policy: saved,
            models: listPolicyModels(),
            effective: listOfficialModels(),
            platform: 'anthropic',
          }),
        )
      }
      // POST /api/panel/model-policy/reset
      if (req.method === 'POST' && p === '/api/panel/model-policy/reset') {
        const body = await readBody(req, 8192).catch(() => ({}))
        const platform = String(body.platform || url.searchParams.get('platform') || '').toLowerCase()
        if (platform === 'openai' || platform === 'gpt' || platform === 'codex') {
          const saved = resetGptModelPolicy()
          const models = listGptPolicyModels()
          return json(
            res,
            200,
            panel.ok({
              policy: saved,
              models,
              effective: models,
              image_tools: listImageToolModels(),
              platform: 'openai',
            }),
          )
        }
        const saved = resetModelPolicy()
        seedModelCatalog()
        syncClaudeKernelConfigs(cfg.paths.project, ctx.routingConfig)
        return json(
          res,
          200,
          panel.ok({
            policy: saved,
            models: listPolicyModels(),
            effective: listOfficialModels(),
            platform: 'anthropic',
          }),
        )
      }
      // POST /api/panel/model-policy/sync-worker — live Anthropic /v1/models through a Claude OAuth slot
      if (req.method === 'POST' && p === '/api/panel/model-policy/sync-worker') {
        const status = await syncClaudeCatalog({ projectRoot: cfg.paths.project })
        if (status.status !== 'ok') {
          return json(res, status.status === 'skipped' ? 400 : 502, {
            ok: false,
            error: { code: status.error, message: status.error },
            data: { synced: 0, catalog_sync: readCatalogSync() },
          })
        }
        return json(
          res,
          200,
          panel.ok({
            policy: getModelPolicy(),
            models: listPolicyModels(),
            effective: listOfficialModels(),
            synced: status.added.length,
            added: status.added,
            catalog_sync: readCatalogSync(),
          }),
        )
      }
      // GET /api/panel/pricing — effective price catalog for the 计费 tab
      if (req.method === 'GET' && p === '/api/panel/pricing') {
        return json(res, 200, panel.ok(buildPricing({ requestLog })))
      }
      // PUT /api/panel/pricing/overrides { key, price|null }
      if (req.method === 'PUT' && p === '/api/panel/pricing/overrides') {
        const body = await readBody(req, 256 * 1024)
        const saved = setPriceOverride(String(body?.key || ''), body?.price ?? null)
        if (!saved.ok) {
          return json(res, 400, { ok: false, error: { code: 'invalid_price', message: saved.error } })
        }
        return json(res, 200, panel.ok({ ok: true, overrides: listPriceOverrides() }))
      }
      // POST /api/panel/pricing/sync — pull models.dev now
      if (req.method === 'POST' && p === '/api/panel/pricing/sync') {
        return json(res, 200, panel.ok({ models_dev: await syncModelsDev() }))
      }
      // POST /api/panel/pricing/reprice { since, until } — rewrite official cost only
      if (req.method === 'POST' && p === '/api/panel/pricing/reprice') {
        const body = await readBody(req, 8192)
        const since = Date.parse(body?.since || '')
        const until = Date.parse(body?.until || '')
        if (!Number.isFinite(since) || !Number.isFinite(until) || since >= until) {
          return json(res, 400, {
            ok: false,
            error: { code: 'invalid_range', message: 'since/until must be ISO times with since < until' },
          })
        }
        const result = requestLog.repo.repriceRange({
          since: new Date(since).toISOString(),
          until: new Date(until).toISOString(),
        })
        return json(res, 200, panel.ok(result))
      }
      // POST /api/panel/model-policy/sync-codex — ChatGPT GPT catalog via a Codex OAuth slot
      if (req.method === 'POST' && p === '/api/panel/model-policy/sync-codex') {
        const body = await readBody(req, 8192).catch(() => ({}))
        const result = await syncGptCatalog({
          projectRoot: cfg.paths.project,
          vmId: body?.vm_id || body?.vmId || url.searchParams.get('vm_id') || '',
          rotate: true,
          gatewayWorker: gatewayWorkerService,
          catalogClientVersion:
            body?.catalog_client_version ||
            body?.catalogClientVersion ||
            ctx.routingConfig.codex?.catalog_client_version ||
            'auto',
        })
        if (!result.ok) {
          const status =
            result.error === 'no_codex_slot' ||
            result.error === 'proxy_required' ||
            result.error === 'invalid_request' ||
            result.error === 'invalid_catalog_version'
              ? 400
              : 502
          return json(res, status, {
            ok: false,
            error: { code: result.error, message: result.message || result.error },
            data: {
              vm_id: result.vm_id || null,
              catalog_version: result.catalog_version || null,
              synced: 0,
            },
          })
        }
        return json(
          res,
          200,
          panel.ok({
            policy: getGptModelPolicy(),
            models: listGptPolicyModels(),
            effective: listGptPolicyModels(),
            image_tools: listImageToolModels(),
            platform: 'openai',
            synced: result.synced,
            source: result.source,
            vm_id: result.vm_id,
            catalog_version: result.catalog_version,
            ids: result.ids,
            added: result.added || [],
            catalog_sync: readCatalogSync(),
          }),
        )
      }

      // GET /api/panel/routing
      if (req.method === 'GET' && p === '/api/panel/routing') {
        const routingConfig = {
          ...ctx.routingConfig,
          compatibility: canonicalPersonaCompat(ctx.routingConfig?.compatibility),
        }
        const response = panel.buildRouting({ routingConfig, stickyRouter })
        const configRevision = currentConfigRevision()
        return json(res, 200, {
          ...response,
          config_revision: configRevision,
          data: response.data ? { ...response.data, config_revision: configRevision } : response.data,
        })
      }
      // GET /api/panel/outbound-profile — read-only outbound reference for the global preset
      if (req.method === 'GET' && p === '/api/panel/outbound-profile') {
        return json(res, 200, panel.ok({ profile: buildOutboundProfile(ctx.routingConfig || {}) }))
      }
      // GET /api/panel/persona/preview-vars?timezone= — real template constants for the system prompt preview
      if (req.method === 'GET' && p === '/api/panel/persona/preview-vars') {
        const timezone = validTimezone(url.searchParams.get('timezone')) || 'UTC'
        return json(res, 200, panel.ok({ vars: personaPreviewVars({ timezone }) }))
      }
      // PUT /api/panel/routing
      if (req.method === 'PUT' && p === '/api/panel/routing') {
        const body = await readBody(req, cfg.limits.max_body_bytes)
        if (body?.compatibility) body.compatibility = canonicalPersonaCompat(body.compatibility)
        const previousRoutingConfig = structuredClone(ctx.routingConfig)
        try {
          if (body?.codex && Object.prototype.hasOwnProperty.call(body.codex, 'quota')) {
            validateOpenAIQuotaPatch(body.codex.quota)
          }
          validateInferenceWebsocketPatch(body)
        } catch (error) {
          if (error instanceof TypeError || error instanceof RangeError) {
            return json(res, 400, {
              ok: false,
              error: {
                type: 'invalid_request_error',
                code: error.code || 'invalid_openai_quota',
                message: error.message,
              },
            })
          }
          throw error
        }
        if (body && Object.prototype.hasOwnProperty.call(body, 'vm')) {
          const checked = validateVmConfigPatch(body.vm)
          if (!checked.ok) {
            return json(res, 400, {
              ok: false,
              error: { type: 'invalid_request_error', code: 'invalid_vm_config', message: checked.error },
            })
          }
        }
        const personaProblems = [
          ...panel.validatePersonaRoutingPatch(body),
          ...validateInferenceRoutingPatch(body),
          ...validateTelemetryRoutingPatch(body),
        ]
        if (personaProblems.length) {
          return json(res, 400, {
            ok: false,
            error: {
              type: 'invalid_request_error',
              code: 'invalid_persona_template',
              message: personaProblems.join('；'),
              problems: personaProblems,
            },
          })
        }
        if (Object.prototype.hasOwnProperty.call(body || {}, 'config_revision')) {
          const expectedRevision = numericRevision(body.config_revision)
          const currentRevision = currentConfigRevision()
          if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
            return json(res, 400, {
              ok: false,
              error: {
                type: 'invalid_request_error',
                code: 'invalid_config_revision',
                message: 'config_revision must be a positive integer',
              },
            })
          }
          if (expectedRevision !== currentRevision) {
            return json(res, 409, {
              ok: false,
              error: {
                type: 'conflict',
                code: 'config_revision_conflict',
                message: `Configuration revision ${expectedRevision} is stale; current revision is ${currentRevision}`,
                current_revision: currentRevision,
              },
            })
          }
        }
        const engineRuntime = await prepareInheritedInferenceEngine(body)
        if (!engineRuntime.ok) {
          return json(res, 503, {
            ok: false,
            error: {
              code: engineRuntime.code,
              message: engineRuntime.error,
              failed_vm: engineRuntime.failed_vm,
            },
          })
        }
        const { applied: appliedDuringSwitch, ...publicEngineRuntime } = engineRuntime
        let applied
        try {
          applied =
            appliedDuringSwitch ?? (await persistRoutingPatch(body, { expectedRevision: body?.config_revision }))
        } catch (error) {
          if (error?.code === 'config_revision_conflict') {
            restoreRoutingRuntime(previousRoutingConfig)
            return json(res, 409, {
              ok: false,
              error: {
                type: 'conflict',
                code: error.code,
                message: error.message,
                current_revision: error.current_revision ?? currentConfigRevision(),
              },
            })
          }
          if (error instanceof TypeError || error instanceof RangeError) {
            return json(res, 400, {
              ok: false,
              error: {
                type: 'invalid_request_error',
                code: error.code || 'invalid_request',
                message: error.message,
              },
            })
          }
          restoreRoutingRuntime(previousRoutingConfig)
          return json(res, 503, {
            ok: false,
            error: { code: 'routing_persist_failed', message: String(error?.message || error) },
          })
        }
        return json(
          res,
          200,
          panel.ok({
            config_revision: applied.config_revision ?? currentConfigRevision(),
            ...publicRoutingNotify(ctx.routingConfig),
            applied_concurrency: applied.concurrency,
            applied_rpm: applied.rpm,
            applied_session_slots: applied.session_slots,
            kernel_persona: applied.kernel_persona || null,
            inference_runtime: publicEngineRuntime,
          }),
        )
      }
      if (req.method === 'GET' && p === '/api/panel/distill') {
        return json(res, 200, panel.ok(reloadDistill()))
      }
      if (req.method === 'PUT' && p === '/api/panel/distill') {
        const body = await readBody(req, 256 * 1024)
        const problems = validateDistillPatch(body)
        if (problems.length) {
          return json(res, 400, {
            ok: false,
            error: {
              type: 'invalid_request_error',
              code: 'invalid_distill_rules',
              message: problems.join('；'),
              problems,
            },
          })
        }
        cfg.distill = saveDistillRules(distillFile(), body)
        return json(res, 200, panel.ok(cfg.distill))
      }
      if (req.method === 'GET' && p === '/api/panel/refusal-guards') {
        return json(res, 200, panel.ok(refusalGuardSnapshot()))
      }
      if (req.method === 'PUT' && p === '/api/panel/refusal-guards') {
        const body = await readBody(req, 8 * 1024).catch(() => ({}))
        const patched = applyRefusalGuardPatch(new SettingsRepo(), body || {})
        if (!patched.ok) {
          return json(res, 400, {
            ok: false,
            error: {
              type: 'invalid_request_error',
              code: 'invalid_refusal_guard',
              message: patched.problems.join('；'),
            },
          })
        }
        return json(res, 200, panel.ok(refusalGuardSnapshot()))
      }
      if (req.method === 'DELETE' && /^\/api\/panel\/refusal-guards\/[0-9a-f]{64}$/i.test(p)) {
        const fp = p.split('/').pop()
        const removed = new RefusalGuardsRepo().remove(fp)
        if (!removed) {
          return json(res, 404, {
            ok: false,
            error: { type: 'not_found_error', code: 'refusal_guard_not_found', message: '指纹不存在' },
          })
        }
        return json(res, 200, panel.ok(refusalGuardSnapshot()))
      }
      if (req.method === 'DELETE' && p === '/api/panel/refusal-guards') {
        const body = await readBody(req, 8 * 1024).catch(() => ({}))
        if (body?.confirm !== true) {
          return json(res, 400, {
            ok: false,
            error: {
              type: 'invalid_request_error',
              code: 'confirm_required',
              message: '清空拒答缓存须 confirm: true',
            },
          })
        }
        new RefusalGuardsRepo().clear()
        return json(res, 200, panel.ok(refusalGuardSnapshot()))
      }
      if (req.method === 'DELETE' && p === '/api/panel/refusal-device-blocks') {
        const body = await readBody(req, 8 * 1024).catch(() => ({}))
        const repo = new RefusalDeviceBlocksRepo()
        const deviceId = String(body?.device_id || '').trim()
        if (deviceId) {
          if (!repo.remove(deviceId)) {
            return json(res, 404, {
              ok: false,
              error: { type: 'not_found_error', code: 'refusal_device_not_found', message: 'device 不存在' },
            })
          }
          return json(res, 200, panel.ok(refusalGuardSnapshot()))
        }
        if (body?.confirm !== true) {
          return json(res, 400, {
            ok: false,
            error: {
              type: 'invalid_request_error',
              code: 'confirm_required',
              message: '清空 device 封禁须 confirm: true，或传 device_id',
            },
          })
        }
        repo.clear()
        return json(res, 200, panel.ok(refusalGuardSnapshot()))
      }
      if (req.method === 'GET' && p === '/api/panel/protocol-entry') {
        return json(res, 200, panel.ok(requestLog.protocolEntryStats()))
      }
      if (req.method === 'GET' && p === '/api/panel/jev-usage') {
        if (panelIdentity(req).role !== 'super_admin')
          return json(res, 403, { ok: false, error: { code: 'forbidden', message: '仅管理员可查看审核用量' } })
        try {
          const repo = new JevUsageRepo()
          const page = repo.list(Object.fromEntries(url.searchParams))
          const settings = new SettingsRepo()
          const keys = repo.configuredKeys(publicJevKeys(readJevConfig((key, fallback) => settings.get(key, fallback))))
          return json(
            res,
            200,
            panel.ok({ ...repo.overview(), ...page, keys, storage_errors_since_start: jevUsageStorageErrors() }),
          )
        } catch (error) {
          if (error instanceof TypeError)
            return json(res, 400, {
              ok: false,
              error: { code: 'invalid_jev_usage_query', message: '用量查询参数不正确' },
            })
          throw error
        }
      }
      if (req.method === 'GET' && p === '/api/panel/jev-intercept') {
        return json(res, 200, panel.ok(jevInterceptSnapshot()))
      }
      if (req.method === 'PUT' && p === '/api/panel/jev-intercept') {
        const body = await readBody(req, 64 * 1024).catch(() => ({}))
        const patched = applyJevPatch(new SettingsRepo(), body || {})
        if (!patched.ok) {
          return json(res, 400, {
            ok: false,
            error: {
              type: 'invalid_request_error',
              code: 'invalid_jev_intercept',
              message: patched.problems.join('；'),
            },
          })
        }
        return json(
          res,
          200,
          panel.ok({ ...patched.config, account_scope: jevScopeInventory(patched.config.account_platform_plans) }),
        )
      }
      if (req.method === 'POST' && p === '/api/panel/jev-intercept/models') {
        const body = await readBody(req, 8192).catch(() => ({}))
        const current = jevInterceptSnapshot()
        const baseUrl = String(body?.base_url || current.base_url || '').trim()
        const typedKey = String(body?.api_key || '').trim()
        const stored = readJevConfig((key, fallback) => new SettingsRepo().get(key, fallback))
        const apiKey = typedKey || stored.api_keys[0] || ''
        try {
          const listed = await listDecisionModels(baseUrl, apiKey, Number(body?.timeout_ms) || current.timeout_ms)
          return json(res, 200, panel.ok({ models: listed.models, url: listed.url }))
        } catch (error) {
          return json(res, 502, {
            ok: false,
            error: {
              type: 'api_error',
              code: error?.code || 'fetch_models_failed',
              message: error?.message || '获取模型失败',
            },
          })
        }
      }
      if (req.method === 'GET' && p === '/api/panel/notify') {
        return json(
          res,
          200,
          panel.ok(notificationStatus(ctx.notifyMonitor, publicNotifyConfig(ctx.routingConfig.notify))),
        )
      }
      if (req.method === 'POST' && p === '/api/panel/notify/check') {
        const body = await readBody(req, 64 * 1024).catch(() => ({}))
        const digest = body?.digest === true
        const result = await ctx.notifyMonitor.runOnce({ send: true, force: false, digest })
        return json(
          res,
          200,
          panel.ok({
            ...(ctx.notifyMonitor.getStatus() || {}),
            events: result?.events || [],
            dispatched: result?.dispatched || [],
          }),
        )
      }
      if (req.method === 'POST' && p === '/api/panel/notify/test') {
        const body = await readBody(req, 64 * 1024)
        const channel = String(body.channel || '').toLowerCase()
        if (channel !== 'email' && channel !== 'telegram' && channel !== 'wecom') {
          return json(res, 400, {
            ok: false,
            error: {
              type: 'invalid_request_error',
              code: 'missing_field',
              message: 'channel must be email, telegram or wecom',
              param: 'channel',
            },
          })
        }
        const trial = notificationTestConfig(ctx.routingConfig.notify, body, mergeNotifyConfig)
        try {
          const result = await sendNotifyTest(trial, channel, {
            baseUrl: cfg.base_url,
            snapshot:
              ctx.notifyMonitor?.getSnapshot?.() ||
              (await panel.snapshotAccountPool({
                cfg,
                accountQuota,
                routingConfig: ctx.routingConfig,
                poolScheduler: ctx.poolScheduler,
                proxyPool,
                requestLog,
              })),
          })
          return json(res, 200, panel.ok(result))
        } catch (e) {
          return json(res, 400, {
            ok: false,
            error: {
              type: 'invalid_request_error',
              code: 'notify_test_failed',
              message: String(e?.message || e).slice(0, 180),
            },
          })
        }
      }
      // ---- Proxy Pool ----
      if (req.method === 'GET' && p === '/api/panel/proxies') {
        const ident = panelIdentity(req)
        const snap = proxyPool.panelSnapshot({
          role: ident.role,
          ownerUserId: ident.role === 'user' ? req.panelUserId : undefined,
          vms: listVms(cfg.paths.project, ctx.routingConfig),
          nodes: clusterNodesOf(ctx),
          vendorId: ident.role === 'super_admin' ? url.searchParams.get('vendor_id') || '' : '',
          platform: ident.role === 'super_admin' ? url.searchParams.get('platform') || '' : '',
        })
        if (ident.role === 'super_admin')
          snap.vendors = getDb()
            .prepare('SELECT id, name, tier FROM vendors WHERE deleted_at IS NULL ORDER BY tier, name')
            .all()
        if (ident.role !== 'super_admin') delete snap.config.dns_primary
        return json(res, 200, panel.ok(snap))
      }
      if (req.method === 'POST' && p === '/api/panel/proxies/local') {
        const result = proxyPool.ensureLocal()
        if (result.created) await ensureProxyEgress(cfg.paths.project, proxyPool.getProxyByIdWithAuth(result.proxy.id))
        // Enabling local egress on a cluster that already has nodes: each VPS gets its row now.
        proxyPool.syncLocalNodes(clusterNodesOf(ctx).map((node) => node.id))
        return json(res, 200, panel.ok(result))
      }
      if (req.method === 'POST' && p === '/api/panel/proxies/import') {
        const body = await readBody(req, 2 * 1024 * 1024)
        const text = body.text || body.lines || (Array.isArray(body) ? body.join('\n') : '')
        const ident = panelIdentity(req)
        let result
        try {
          result = proxyPool.importLines(text, {
            fields: body.proxies || body.entries || null,
            host: body.host,
            expires_at: body.expires_at,
            fallback_mode: body.fallback_mode || 'none',
            backup_proxy_id: body.backup_proxy_id,
            label: body.label ?? body.name,
            port: body.port,
            username: body.username ?? body.user,
            password: body.password ?? body.pass,
            ownerUserId: ident.role === 'user' ? req.panelUserId : null,
          })
        } catch (e) {
          return json(res, 400, {
            ok: false,
            error: { code: e.message || 'invalid_proxy', message: '代理配置无效，请检查有效期或备用代理' },
          })
        }
        const bindVmId = String(body.bind_vm_id || body.vm_id || '').trim()
        let bound = null
        let worker = null
        let timezone = null
        if (bindVmId && result.items?.[0]?.id) {
          const bind = proxyPool.bind(result.items[0].id, bindVmId)
          if (bind.ok) {
            bindVmProxy(cfg.paths.project, bindVmId, proxyPool.getProxyForVm(bindVmId))
            bound = bind.proxy
            // Before the reload: the worker reads vm.timezone when it starts.
            timezone = await syncVmTimezoneFromProxy(cfg.paths.project, proxyPool, bindVmId, {
              proxyId: result.items[0].id,
            })
            const vm = getVm(cfg.paths.project, bindVmId)
            if (vm?.status === 'running' && process.env.KIN_CRS_MOCK !== '1') {
              setScheduleHold(cfg.paths.project, bindVmId, HOLD_MAINTENANCE, { tag: 'proxy_rebind_worker_reload' })
              worker = await reloadSlotReady(getVm(cfg.paths.project, bindVmId), cfg.paths.project, {
                routing: ctx.routingConfig,
              })
              if (worker.ok) restoreSchedulableIfReady(bindVmId, { by: 'proxy_rebind' })
            }
          }
        }
        return json(res, 200, panel.ok({ ...result, bound, worker, timezone }))
      }
      if (req.method === 'POST' && p === '/api/panel/proxies/geo') {
        const body = await readBody(req, 8192).catch(() => ({}))
        const result = await proxyPool.detectGeoAll({
          onlyEnabled: body?.only_enabled !== false,
          force: body?.force === true,
        })
        return json(res, 200, panel.ok(result))
      }
      if (req.method === 'POST' && p === '/api/panel/proxies/probe') {
        const result = await proxyPool.probeAll({ onlyEnabled: true })
        return json(res, 200, panel.ok(result))
      }
      if (req.method === 'GET' && p === '/api/panel/proxies/config') {
        const config = proxyPool.snapshot().config
        if (panelIdentity(req).role !== 'super_admin') delete config.dns_primary
        return json(res, 200, panel.ok(config))
      }
      if (req.method === 'PUT' && p === '/api/panel/proxies/config') {
        const body = await readBody(req, 64 * 1024)
        const previousConfig = proxyPool.snapshot().config
        const result = proxyPool.updateConfig(body)
        if (!result.ok)
          return json(res, 400, {
            ok: false,
            error: { type: 'invalid_request_error', code: result.error, message: result.error, details: result },
          })
        // DNS changes must reach running egress helpers; slots stay intact.
        const egress = []
        if (
          ((body.dns_primary != null && body.dns_primary !== previousConfig.dns_primary) ||
            (body.dns_disable_svcb_https != null &&
              body.dns_disable_svcb_https !== previousConfig.dns_disable_svcb_https)) &&
          egressEnabled() &&
          process.env.KIN_CRS_MOCK !== '1'
        ) {
          const dnsUpstream = dnsUpstreamChain(result.config.dns_primary)
          const dnsEmptyTypes = result.config.dns_disable_svcb_https ? [64, 65] : []
          for (const proxy of proxyPool.snapshot().proxies) {
            if (isLocalEgressProxy(proxy) || !proxy.bound_vm_ids?.length) continue
            const r = await ensureProxyEgress(cfg.paths.project, proxyPool.getProxyByIdWithAuth(proxy.id), {
              dnsUpstream,
              dnsEmptyTypes,
            })
            egress.push({ proxy_id: proxy.id, ok: r.ok, error: r.ok ? null : r.error })
          }
        }
        if (body.ipv6_enabled != null && process.env.KIN_CRS_MOCK !== '1') {
          egress.push(...(await syncIpv6ProxyEgress(cfg.paths.project, proxyPool)))
        }
        return json(res, 200, panel.ok({ ...result.config, egress }))
      }
      // Must stay BELOW /proxies/config: `[^/]+` matches "config" too, and this
      // route shares its method, so ordering alone decides the winner. The
      // negative lookahead makes that dependency explicit rather than positional.
      if (req.method === 'PUT' && /^\/api\/panel\/proxies\/(?!config$)[^/]+$/.test(p)) {
        const id = p.split('/')[4]
        const body = await readBody(req, 64 * 1024)
        // Forward only the keys the caller actually sent — update() reads
        // presence, not value, to tell "leave alone" from "clear".
        const patch = {}
        for (const key of [
          'host',
          'port',
          'username',
          'password',
          'label',
          'domain_forward',
          'enabled',
          'expires_at',
          'fallback_mode',
          'backup_proxy_id',
          'max_websocket_connections',
          'request_location_mode',
          'location',
        ]) {
          if (Object.prototype.hasOwnProperty.call(body, key)) patch[key] = body[key]
        }
        const result = proxyPool.update(id, patch)
        if (!result.ok) {
          const status = result.error === 'proxy_not_found' ? 404 : 400
          const type = status === 404 ? 'not_found_error' : 'invalid_request_error'
          return json(res, status, { ok: false, error: { type, code: result.error, message: result.error } })
        }
        // Hostname mode and SOCKS upstream both live inside kin-egress.
        // Domain-forward-only: restart the helper; slots keep the same bridge.
        // Same-id connection change: network name is unchanged so reload would
        // only docker restart — the helper must pick up the new proxy_url or
        // transparent traffic keeps the old exit.
        let egress = null
        if (
          (result.domain_forward_changed || result.connection_changed) &&
          egressEnabled() &&
          process.env.KIN_CRS_MOCK !== '1' &&
          (result.proxy.bound_vm_ids || []).length
        ) {
          const restarted = await ensureProxyEgress(cfg.paths.project, proxyPool.getProxyByIdWithAuth(id))
          egress = { ok: !!restarted.ok, error: restarted.ok ? null : restarted.error || 'egress_restart_failed' }
        }
        // A label is display-only; reloading every bound worker for it would
        // pull live slots out of scheduling for nothing.
        if (!result.connection_changed && !result.metadata_changed)
          return json(res, 200, panel.ok({ proxy: result.proxy, workers: [], egress }))
        // The pool store is only one of three places the credentials live
        // (pool -> vms/<id>.json -> worker.json). Without this the edit looks
        // like it worked while every bound slot keeps dialing the old proxy.
        const workers = []
        for (const vmId of result.proxy.bound_vm_ids || []) {
          bindVmProxy(cfg.paths.project, vmId, proxyPool.getProxyByIdWithAuth(id))
          const vm = getVm(cfg.paths.project, vmId)
          if (result.connection_changed && vm?.status === 'running' && process.env.KIN_CRS_MOCK !== '1') {
            setScheduleHold(cfg.paths.project, vmId, HOLD_MAINTENANCE, { tag: 'proxy_edit_worker_reload' })
            const reloaded = await reloadSlotReady(getVm(cfg.paths.project, vmId), cfg.paths.project, {
              routing: ctx.routingConfig,
            })
            if (reloaded.ok) restoreSchedulableIfReady(vmId, { by: 'proxy_rebind' })
            // A slot that fails to reload does not fail the request: the store
            // is already updated, so report per-slot and let ops retry.
            workers.push({ vm_id: vmId, ok: !!reloaded.ok, error: reloaded.ok ? null : reloaded.error || null })
          } else {
            workers.push({ vm_id: vmId, ok: true, error: null })
          }
        }
        return json(res, 200, panel.ok({ proxy: result.proxy, workers, egress }))
      }
      // The one endpoint allowed to return proxy credentials. Mirrors
      // POST /api/panel/api-keys/:id/reveal: POST so it never lands in browser
      // history or a cache, no body, no confirmation step.
      if (req.method === 'POST' && /^\/api\/panel\/proxies\/[^/]+\/reveal$/.test(p)) {
        const id = p.split('/')[4]
        // Deliberately not getProxyForVm(): that one filters out disabled and
        // dead rows, which are the ones an operator most needs to read back.
        const full = proxyPool.getProxyByIdWithAuth(id)
        if (!full)
          return json(res, 404, {
            ok: false,
            error: { type: 'not_found_error', code: 'proxy_not_found', message: 'proxy not found' },
          })
        // URI only — no split username/password fields, so there is nothing for
        // a caller to render into the DOM piecemeal.
        return json(res, 200, { ok: true, id: full.id, uri: full.url })
      }
      if (req.method === 'POST' && /^\/api\/panel\/proxies\/[^/]+\/quality-check$/.test(p)) {
        const controller = new AbortController()
        const abort = () => {
          if (!res.writableEnded) controller.abort()
        }
        res.on('close', abort)
        try {
          const result = await proxyPool.qualityById(p.split('/')[4], { signal: controller.signal })
          if (!result.ok)
            return json(res, result.error === 'proxy_not_found' ? 404 : 409, {
              ok: false,
              error: {
                code: result.error,
                message:
                  result.error === 'quality_check_busy'
                    ? '检测进行中，请稍后重试'
                    : '代理配置已改变或当前出口不可用，请刷新后重试',
              },
            })
          return json(res, 200, panel.ok(result))
        } finally {
          res.off('close', abort)
        }
      }
      if (req.method === 'POST' && /^\/api\/panel\/proxies\/[^/]+\/probe$/.test(p)) {
        const id = p.split('/')[4]
        const result = await proxyPool.probeById(id, { connectivity: true })
        if (result.probe?.scope === 'policy') {
          return json(res, 409, {
            ok: false,
            error: {
              code: result.probe.error,
              message:
                result.probe.error === 'proxy_expired'
                  ? '代理已到期'
                  : 'IPv6 已关闭，请在设置 → SOCKS5 开启 IPv6 代理出口',
            },
          })
        }
        if (!result.ok)
          return json(res, result.error === 'proxy_not_found' ? 404 : 409, {
            ok: false,
            error: {
              code: result.error,
              message: result.error === 'proxy_changed_during_check' ? '代理配置已修改，请重新测试' : '代理不存在',
            },
          })
        return json(res, 200, panel.ok(result))
      }
      if (req.method === 'POST' && /^\/api\/panel\/proxies\/[^/]+\/geo$/.test(p)) {
        const id = p.split('/')[4]
        const body = await readBody(req, 8192).catch(() => ({}))
        const result = await proxyPool.detectGeo(id, { force: body?.force !== false })
        if (result.error === 'ipv6_disabled') {
          return json(res, 409, {
            ok: false,
            error: {
              code: result.error,
              message: 'IPv6 已关闭，请在设置 → SOCKS5 开启 IPv6 代理出口',
            },
          })
        }
        if (!result.ok && result.error === 'proxy_not_found') {
          return json(res, 404, {
            ok: false,
            error: { type: 'not_found_error', code: result.error, message: result.error },
          })
        }
        if (!result.ok) {
          return json(res, 502, {
            ok: false,
            error: {
              type: 'upstream_error',
              code: 'geo_lookup_failed',
              message: String(result.error || 'geo lookup failed').slice(0, 200),
              details: { proxy: result.proxy || null },
            },
          })
        }
        // A slot already bound to this proxy adopts the freshly learned zone.
        const timezones = []
        for (const vmId of result.proxy?.bound_vm_ids || []) {
          const synced = await syncVmTimezoneFromProxy(cfg.paths.project, proxyPool, vmId, {
            proxyId: id,
            detect: false,
          })
          timezones.push({ vm_id: vmId, applied: synced.applied, timezone: synced.timezone, reason: synced.reason })
        }
        return json(res, 200, panel.ok({ ...result, timezones }))
      }
      if (req.method === 'POST' && /^\/api\/panel\/proxies\/[^/]+\/enable$/.test(p)) {
        const id = p.split('/')[4]
        const result = proxyPool.setEnabled(id, true)
        if (!result.ok)
          return json(res, 404, {
            ok: false,
            error: { type: 'not_found_error', code: result.error, message: result.error },
          })
        // re-enable bound VM scheduling if any
        for (const vmId of result.proxy?.bound_vm_ids ||
          (result.proxy?.bound_vm_id ? [result.proxy.bound_vm_id] : [])) {
          // Only the hold this proxy put on the slot; 调度关 / 不可调度 stay.
          clearScheduleHold(cfg.paths.project, vmId, HOLD_PROXY, { tag: id })
        }
        return json(res, 200, panel.ok(result.proxy))
      }
      if (req.method === 'POST' && /^\/api\/panel\/proxies\/[^/]+\/disable$/.test(p)) {
        const id = p.split('/')[4]
        const result = proxyPool.setEnabled(id, false)
        if (!result.ok)
          return json(res, 404, {
            ok: false,
            error: { type: 'not_found_error', code: result.error, message: result.error },
          })
        return json(res, 200, panel.ok(result.proxy))
      }
      if (req.method === 'POST' && /^\/api\/panel\/proxies\/[^/]+\/bind$/.test(p)) {
        const id = p.split('/')[4]
        const body = await readBody(req, 64 * 1024)
        const vmId = body.vm_id
        if (!vmId)
          return json(res, 400, {
            ok: false,
            error: { type: 'invalid_request_error', code: 'missing_field', message: 'vm_id required', param: 'vm_id' },
          })
        const result = proxyPool.bind(id, vmId)
        if (!result.ok) {
          const message =
            result.error === 'proxy_bind_limit'
              ? `SOCKS5 最多绑定 ${result.max || 5} 台虚拟机`
              : result.error === 'local_proxy_node_mismatch'
                ? LOCAL_PROXY_MISMATCH_MESSAGE
                : result.error
          return json(res, 400, {
            ok: false,
            error: { type: 'invalid_request_error', code: result.error, message, details: result },
          })
        }
        bindVmProxy(cfg.paths.project, vmId, proxyPool.getProxyForVm(vmId))
        if (egressEnabled()) {
          await ensureProxyEgress(
            cfg.paths.project,
            proxyPool.getProxyForVm(vmId) || proxyPool.getProxyByIdWithAuth(id),
          )
        }
        let worker = null
        // Runs before the reload so the worker starts with the exit node's zone.
        const timezone = await syncVmTimezoneFromProxy(cfg.paths.project, proxyPool, vmId, { proxyId: id })
        const vm = getVm(cfg.paths.project, vmId)
        if (vm?.status === 'running' && process.env.KIN_CRS_MOCK !== '1') {
          setScheduleHold(cfg.paths.project, vmId, HOLD_MAINTENANCE, { tag: 'proxy_rebind_worker_reload' })
          worker = await reloadSlotReady(getVm(cfg.paths.project, vmId), cfg.paths.project, {
            routing: ctx.routingConfig,
          })
          if (worker.ok) restoreSchedulableIfReady(vmId, { by: 'proxy_rebind' })
        }
        return json(res, 200, panel.ok({ proxy: result.proxy, worker, timezone }))
      }
      if (req.method === 'POST' && /^\/api\/panel\/proxies\/[^/]+\/unbind$/.test(p)) {
        const id = p.split('/')[4]
        const body = await readBody(req, 64 * 1024)
        const vmId = String(body.vm_id || '').trim()
        const snap = proxyPool.snapshot().proxies.find((proxy) => proxy.id === id)
        const targets = vmId
          ? [vmId]
          : snap?.bound_vm_ids?.length
            ? snap.bound_vm_ids
            : snap?.bound_vm_id
              ? [snap.bound_vm_id]
              : []
        const result = proxyPool.unbind(id, vmId || null)
        if (!result.ok)
          return json(res, 404, {
            ok: false,
            error: { type: 'not_found_error', code: result.error, message: result.error },
          })
        for (const unboundId of result.unbound_vm_ids || targets) {
          bindVmProxy(cfg.paths.project, unboundId, null)
          markUnschedulable(cfg.paths.project, unboundId, 'proxy_required')
        }
        if (egressEnabled() && !(result.proxy?.bound_vm_ids || []).length) {
          stopProxyEgress(cfg.paths.project, id)
        }
        return json(res, 200, panel.ok(result.proxy))
      }
      if (req.method === 'DELETE' && /^\/api\/panel\/proxies\/[^/]+$/.test(p)) {
        const id = p.split('/').pop()
        const snap = proxyPool.snapshot().proxies.find((proxy) => proxy.id === id)
        const targets = snap?.bound_vm_ids?.length ? snap.bound_vm_ids : snap?.bound_vm_id ? [snap.bound_vm_id] : []
        const result = proxyPool.remove(id)
        if (!result.ok)
          return json(res, 404, {
            ok: false,
            error: { type: 'not_found_error', code: result.error, message: result.error },
          })
        for (const unboundId of targets) {
          bindVmProxy(cfg.paths.project, unboundId, null)
          markUnschedulable(cfg.paths.project, unboundId, 'proxy_required')
        }
        if (egressEnabled()) stopProxyEgress(cfg.paths.project, id)
        return json(res, 200, panel.ok(result.removed))
      }
      // Auto-allocate proxy for a VM
      if (req.method === 'POST' && /^\/api\/panel\/vms\/[^/]+\/allocate-proxy$/.test(p)) {
        const vmId = p.split('/')[4]
        const allocated = proxyPool.allocateForVm(vmId)
        if (!allocated)
          return json(res, 409, {
            ok: false,
            error: { type: 'api_error', code: 'no_free_proxy', message: 'No free SOCKS5 in pool' },
          })
        bindVmProxy(cfg.paths.project, vmId, proxyPool.getProxyForVm(vmId))
        if (egressEnabled()) await ensureProxyEgress(cfg.paths.project, proxyPool.getProxyForVm(vmId))
        let worker = null
        const timezone = await syncVmTimezoneFromProxy(cfg.paths.project, proxyPool, vmId, {
          proxyId: allocated?.id || null,
        })
        const vm = getVm(cfg.paths.project, vmId)
        if (vm?.status === 'running' && process.env.KIN_CRS_MOCK !== '1') {
          setScheduleHold(cfg.paths.project, vmId, HOLD_MAINTENANCE, { tag: 'proxy_rebind_worker_reload' })
          worker = await reloadSlotReady(getVm(cfg.paths.project, vmId), cfg.paths.project, {
            routing: ctx.routingConfig,
          })
          if (worker.ok) restoreSchedulableIfReady(vmId, { by: 'proxy_rebind' })
        }
        return json(res, 200, panel.ok({ proxy: allocated, worker, timezone }))
      }

      return json(res, 404, {
        ok: false,
        error: { type: 'not_found_error', code: 'not_found', message: 'panel route not found' },
      })
    }

    // ---- intercept rules admin ----
    if (p === '/admin/intercept/rules') {
      if (!requireAuth(req, res)) return
      if (req.method === 'GET') {
        return json(res, 200, { rules: reloadRules() })
      }
      if (req.method === 'PUT') {
        const body = await readBody(req, 256 * 1024)
        const rules = Array.isArray(body) ? body : body.rules
        if (!Array.isArray(rules)) {
          return json(res, 400, { error: { message: 'rules must be array' } })
        }
        fs.writeFileSync(rulesFile(), JSON.stringify(rules, null, 2))
        cfg.intercept.rules = rules
        return json(res, 200, { ok: true, count: rules.length, rules })
      }
      if (req.method === 'DELETE') {
        fs.writeFileSync(rulesFile(), '[]')
        cfg.intercept.rules = []
        return json(res, 200, { ok: true, count: 0, rules: [] })
      }
    }

    if (req.method === 'GET' && p === '/admin/vm/oauth') {
      if (!requireAuth(req, res)) return
      return json(res, 200, await oauthStatusWithWorker())
    }
    if (req.method === 'POST' && p === '/admin/vm/oauth/refresh') {
      if (!requireAuth(req, res)) return
      const body = await readBody(req, 4096).catch(() => ({}))
      const id = String(body.vm_id || getActiveVmId(cfg.paths.project) || '').trim()
      const vmPath = path.join(cfg.paths.project, 'vms', `${id}.json`)
      if (!id || !fs.existsSync(vmPath)) {
        return json(res, 404, { ok: false, error: { code: 'vm_not_found', message: 'VM not found' } })
      }
      const data = await refreshWorkerCredentialForVm({
        vmId: id,
        vmPath,
        homeDir: path.join(cfg.paths.project, 'vms', id, 'cli-home'),
        vm: getVm(cfg.paths.project, id),
        force: true,
      })
      return json(res, data.ok ? 200 : 502, data)
    }

    // Claude CLI inference/update was removed; workers are built and deployed separately.
    if (req.method === 'GET' && p === '/admin/vm/claude-code/version') {
      if (!requireAuth(req, res)) return
      return json(res, 410, {
        error: { code: 'claude_cli_removed', message: 'Claude CLI runtime was replaced by the Go slot worker' },
      })
    }
    if (req.method === 'POST' && p === '/admin/vm/claude-code/update') {
      if (!requireAuth(req, res)) return
      return json(res, 410, {
        error: { code: 'claude_cli_removed', message: 'Build and roll out the Go slot worker instead' },
      })
    }

    return false
  }
}

async function readSeedSettings(projectRoot, vm) {
  const host = slotHost(vm)
  const result = {
    settings_json: null,
    claude_setting: null,
    kin_seed: null,
    cli_home: null,
    seed_files: {
      ok: false,
      source: host.kind,
      files: { settings_json: 'error', claude_setting: 'error', kin_seed: 'error' },
    },
  }
  try {
    const observed = await host.seedFiles(vm, path.join(projectRoot, 'vms', vm.id))
    result.cli_home = observed.cli_home
    let failed = false
    for (const [key, name] of [
      ['settings_json', 'settings.json'],
      ['claude_setting', 'claude.setting'],
      ['kin_seed', 'kin-seed.json'],
    ]) {
      const text = observed.files[name]
      if (text === null) {
        result.seed_files.files[key] = 'missing'
        continue
      }
      try {
        const value = key === 'claude_setting' ? text.replace(/\r\n?/g, '\n').replace(/\n+$/g, '') : JSON.parse(text)
        if (key !== 'claude_setting' && (!value || typeof value !== 'object' || Array.isArray(value)))
          throw new Error('seed_file_invalid')
        result[key] = value
        result.seed_files.files[key] = 'present'
      } catch {
        failed = true
      }
    }
    result.seed_files.ok = !failed
    if (failed) result.seed_files.error = 'seed_file_invalid'
  } catch {
    result.seed_files.error = 'seed_files_unavailable'
  }
  return result
}

async function readTelemetryUploadLog(projectRoot, vm) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/.test(String(vm?.id || ''))) return []
  const text = await slotHost(vm).telemetryLog(vm, path.join(projectRoot, 'vms', vm.id))
  return String(text)
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-40)
    .flatMap((line) => {
      try {
        const record = JSON.parse(line)
        if (
          typeof record?.at !== 'string' ||
          typeof record?.ok !== 'boolean' ||
          !Number.isSafeInteger(record?.events) ||
          record.events < 0
        )
          return []
        return [
          JSON.stringify({
            at: record.at,
            ok: record.ok,
            events: record.events,
            error:
              typeof record.error === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(record.error) ? record.error : null,
          }),
        ]
      } catch {
        return []
      }
    })
}
