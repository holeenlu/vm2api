import { resourceViewRole } from './panel-acl.mjs'
import { summarizeVm } from '../vm/vm-registry.mjs'

/** VM lifecycle adapter for start, recover and stop. */
export function createPanelVmLifecycleRoutes({
  cfg,
  routingConfig,
  proxyPool,
  clusterNodesOf,
  panel,
  panelIdentity,
  start,
  recover,
  stop,
  json,
  gatewayCapabilities = {},
}) {
  const respond = (...args) => {
    json(...args)
    return true
  }
  return async function handlePanelVmLifecycleRoutes(req, res, path) {
    if (req.method === 'POST' && /^\/api\/panel\/vms\/[^/]+\/(start|recover|stop)$/.test(path)) {
      const match = path.match(/^\/api\/panel\/vms\/([^/]+)\/(start|recover|stop)$/)
      const id = match[1]
      const action = match[2]
      if (action === 'start') {
        const started = await start(id, { role: resourceViewRole(panelIdentity(req)) })
        if (!started.ok)
          return respond(res, started.status, { ok: false, error: { code: started.code, message: started.error } })
        const vm = started.vm
        return respond(
          res,
          200,
          panel.ok({
            vm: panel.publicVmBootView(summarizeVm(vm, cfg.paths.project, routingConfig)),
            allocated_proxy: panel.publicAllocatedProxy(proxyPool, started.bound || null, {
              nodeId: vm?.node_id || null,
              role: resourceViewRole(panelIdentity(req)),
              nodes: clusterNodesOf(),
            }),
            runtime: panel.publicRuntimeView(vm?.runtime) || gatewayCapabilities.runtime,
            kernel: gatewayCapabilities.kernel,
            ...(started.boot ? { boot: panel.publicSlotBoot(started.boot) } : {}),
          }),
        )
      }
      if (action === 'recover') {
        const result = await recover(id, { role: resourceViewRole(panelIdentity(req)) })
        if (!result.ok)
          return respond(res, result.status, { ok: false, error: { code: result.code, message: result.error } })
        return respond(res, 200, panel.ok(result.report))
      }
      const result = await stop(id)
      if (!result.ok)
        return respond(res, result.status, { ok: false, error: { code: result.code, message: result.error } })
      return respond(
        res,
        200,
        panel.ok({
          vm: summarizeVm(result.vm, cfg.paths.project, routingConfig),
          runtime: panel.publicRuntimeView(result.vm.runtime) || gatewayCapabilities.runtime,
          kernel: gatewayCapabilities.kernel,
          halt: panel.publicSlotBoot(result.halt),
        }),
      )
    }
    return false
  }
}
