import { diagnoseSlotServices } from '../vm/slot-recovery.mjs'
import { getVm } from '../vm/vm-registry.mjs'

/** Read-only VM diagnosis route. */
export function createPanelVmDiagnoseRoutes({ cfg, routingConfig, kernelWatchdog, panelIdentity, json }) {
  return async function handlePanelVmDiagnoseRoutes(req, res, path) {
    if (req.method === 'GET' && /^\/api\/panel\/vms\/[^/]+\/diagnose$/.test(path)) {
      const id = path.split('/')[4]
      const vm = getVm(cfg.paths.project, id)
      if (!vm) {
        json(res, 404, { ok: false, error: { code: 'vm_not_found', message: 'vm not found' } })
        return true
      }
      const diagnosis = await diagnoseSlotServices(vm, {
        projectRoot: cfg.paths.project,
        routing: routingConfig,
        watchdog: kernelWatchdog,
        internal: panelIdentity(req).role === 'super_admin',
      })
      json(res, 200, { ok: true, data: diagnosis })
      return true
    }
    return false
  }
}
