import { getVm } from '../vm/vm-registry.mjs'

/** VM inference probe and real-exit geo probe adapters. */
export function createPanelVmProbeRoutes({ cfg, routingConfig, accountQuota, panel, probeExitGeo, json }) {
  return async function handlePanelVmProbeRoutes(req, res, path) {
    if (req.method === 'POST' && /^\/api\/panel\/vms\/[^/]+\/probe$/.test(path)) {
      const id = path.split('/')[4]
      const result = await panel.buildProbeOne({ cfg, accountQuota, id, hop: true, force: true, routingConfig })
      if (result.status) {
        json(res, result.status, result.body)
        return true
      }
      json(res, 200, result)
      return true
    }
    if (req.method === 'POST' && /^\/api\/panel\/vms\/[^/]+\/exit-probe$/.test(path)) {
      const id = path.split('/')[4]
      const vm = getVm(cfg.paths.project, id)
      if (!vm) {
        json(res, 404, { ok: false, error: { message: 'vm not found' } })
        return true
      }
      const result = await probeExitGeo(vm)
      if (!result.ok) {
        json(res, 502, { ok: false, error: { code: result.code || 'exit_probe_failed', message: result.error } })
        return true
      }
      json(res, 200, panel.ok({ vm_id: id, ...result }))
      return true
    }
    return false
  }
}
