import { runFleetUpdate } from '../vm/fleet-update.mjs'
import { reconcileOfficialFingerprints } from '../identity/official-fingerprint.mjs'

/** Low-risk VM fleet commands. Runtime lifecycle commands remain in panel-routes. */
export function createPanelVmCommandRoutes({ cfg, routingConfig, readBody, json }) {
  const respond = (...args) => {
    json(...args)
    return true
  }
  return async function handlePanelVmCommandRoutes(req, res, path) {
    if (req.method === 'POST' && path === '/api/panel/vms/reconcile-fingerprints')
      return respond(res, 200, { ok: true, data: reconcileOfficialFingerprints(cfg.paths.project) })
    if (req.method === 'POST' && path === '/api/panel/vms/fleet-update') {
      const body = await readBody(req, 32 * 1024).catch(() => ({}))
      const report = await runFleetUpdate(cfg.paths.project, {
        action: body.action || 'roll',
        ids: Array.isArray(body.ids) ? body.ids : null,
        concurrency: body.concurrency,
        routing: routingConfig,
      })
      return respond(res, 200, { ok: true, data: report })
    }
    return false
  }
}
