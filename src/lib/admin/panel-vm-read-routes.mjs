import { liveAccountStats } from './live-account-stats.mjs'
import { resourceViewRole } from './panel-acl.mjs'
import { fleetStatus } from '../vm/fleet-update.mjs'
import { normalizeVmConfig } from '../vm/machine-spec.mjs'
import { sharedQuotaPeers } from '../usage/shared-quota.mjs'

/**
 * Read-only VM panel routes.  Authentication, capability checks and tenant
 * filtering remain in panel-routes; this factory only adapts existing panel
 * projections and preserves their response envelopes.
 */
export function createPanelVmReadRoutes({
  panel,
  cfg,
  accountQuota,
  routingConfig,
  poolScheduler,
  proxyPool,
  requestLog,
  db,
  kernelHealth,
  clusterNodesOf,
  panelIdentity,
  filterVmsForPanel,
  listVms,
  probeLocalKvm,
  usageProbeMonitor,
  liveStats = null,
  json,
}) {
  const respond = (...args) => {
    json(...args)
    return true
  }

  return async function handlePanelVmReadRoutes(req, res, path) {
    if (req.method === 'GET' && path === '/api/panel/vms') {
      const ident = panelIdentity(req)
      const result = await panel.buildVmList({
        cfg,
        accountQuota,
        routingConfig,
        poolScheduler,
        proxyPool,
        requestLog,
        // 被授予资源查看能力的 admin 与 super_admin 看到同样的虚拟机数据
        role: resourceViewRole(ident),
        ownerUserId: ident.role === 'user' ? req.panelUserId : null,
        db,
        clusterNodes: await clusterNodesOf(),
      })
      // 同号槽位：共享同一份上游额度的其他槽位（见 usage/shared-quota.mjs）
      const peers = await sharedQuotaPeers(db)
      if (peers.size)
        for (const vm of result.data?.items || []) if (peers.has(vm.id)) vm.shared_quota_with = peers.get(vm.id)
      try {
        Promise.resolve(usageProbeMonitor?.refreshVisible?.((result.data?.items || []).map((vm) => vm.id))).catch(
          () => {},
        )
      } catch {}
      return respond(res, 200, result)
    }

    // 账号实时指标（最近 1 / 5 分钟，内存窗口）：VM 与 Gateway 账号按行 id 汇总
    if (req.method === 'GET' && path === '/api/panel/vms/live-stats') {
      return respond(res, 200, panel.ok((liveStats || liveAccountStats).snapshot()))
    }

    if (req.method === 'GET' && path === '/api/panel/vms/fleet-status') {
      return respond(res, 200, panel.ok({ items: await fleetStatus(cfg.paths.project) }))
    }

    if (req.method === 'GET' && path === '/api/panel/vms/create-options') {
      const probe = typeof probeLocalKvm === 'function' ? probeLocalKvm : async () => null
      const kvm = await probe({ routing: routingConfig })
      return respond(
        res,
        200,
        panel.ok({
          vm: normalizeVmConfig(routingConfig?.vm),
          kvm,
        }),
      )
    }

    if (req.method === 'GET' && /^\/api\/panel\/vms\/[^/]+$/.test(path)) {
      const id = path.split('/').pop()
      const ident = panelIdentity(req)
      const result = await panel.buildVmDetail({
        cfg,
        accountQuota,
        id,
        routingConfig,
        poolScheduler,
        requestLog,
        proxyPool,
        kernelHealth,
        clusterNodes: await clusterNodesOf(),
        role: resourceViewRole(ident),
      })
      if (result.status) return respond(res, result.status, result.body)
      return respond(res, 200, result)
    }

    return false
  }
}
