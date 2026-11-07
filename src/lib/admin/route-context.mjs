/**
 * Stable adapters shared by panel route factories.
 *
 * Keeping these bindings in one place lets route modules be split by domain
 * without changing the server context shape or any handler contract.
 */
export function createPanelRouteContext(ctx, { defaultReadRawBody, refreshClusterSlotPayloads } = {}) {
  const json = (...args) => ctx.json(...args)
  const readBody = (...args) => ctx.readBody(...args)
  const readRawBody = (...args) => (ctx.readRawBody || defaultReadRawBody)(...args)
  const requireAuth = (...args) => ctx.requireAuth(...args)

  return {
    cfg: ctx.cfg,
    json,
    readBody,
    readRawBody,
    refreshCluster: ctx.refreshClusterSlotPayloads || refreshClusterSlotPayloads,
    requireAuth,
    routingConfigPath: ctx.routingConfigPath,
    stickyRouter: ctx.stickyRouter,
    accountQuota: ctx.accountQuota,
    proxyPool: ctx.proxyPool,
    apiKeyStore: ctx.apiKeyStore,
    apiEndpointStore: ctx.apiEndpointStore,
    apiScheduler: ctx.apiScheduler,
    panelUsers: ctx.panelUsers,
    requestLog: ctx.requestLog,
    vmTestSchedule: ctx.vmTestSchedule,
    backupService: ctx.backupService,
    stats: ctx.stats,
    persistRoutingPatch: (...args) => ctx.persistRoutingPatch(...args),
    applyVmConcurrency: (...args) => ctx.applyVmConcurrency(...args),
    applyVmRpm: (...args) => ctx.applyVmRpm(...args),
    applyVmSessionSlots: (...args) => ctx.applyVmSessionSlots(...args),
    inheritVmScheduling: (...args) => ctx.inheritVmScheduling(...args),
    applyVmQuotaOverride: (...args) => ctx.applyVmQuotaOverride(...args),
    initPoolRuntime: (...args) => ctx.initPoolRuntime(...args),
    poolSchedulerConfig: (...args) => ctx.poolSchedulerConfig(...args),
    commitImportedOauth: (...args) => ctx.commitImportedOauth(...args),
    requireSlotProxy: (...args) => ctx.requireSlotProxy(...args),
    officialCcStatsHandler: (...args) => ctx.officialCcStatsHandler(...args),
    refreshWorkerCredentialForVm: (...args) => ctx.refreshWorkerCredentialForVm(...args),
    fetchWorkerModels: (...args) => ctx.fetchWorkerModels(...args),
  }
}
