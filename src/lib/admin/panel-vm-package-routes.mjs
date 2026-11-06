import { resourceViewRole } from './panel-acl.mjs'
/** VM package import/export route adapter. */
export function createPanelVmPackageRoutes({
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
  routingConfig,
  packageImportBringUp,
  holdMaintenance,
}) {
  // 写完响应即视为已处理：panel-routes 按返回值决定是否继续匹配后面的路由
  const respond = (...args) => {
    json(...args)
    return true
  }
  return async function handlePanelVmPackageRoutes(req, res, route) {
    const p = route
    if (req.method === 'GET' && /^\/api\/panel\/vms\/[^/]+\/package$/.test(p)) {
      const id = p.split('/')[4]
      const result = exportVmPackage(cfg.paths.project, id, proxyPool)
      if (!result.ok) return respond(res, result.status || 404, { ok: false, error: result.error })
      return respond(res, 200, panel.ok(result.package))
    }
    if (req.method === 'PUT' && /^\/api\/panel\/vms\/[^/]+\/package$/.test(p)) {
      const id = p.split('/')[4]
      const body = await readBody(req, 256 * 1024).catch(() => null)
      const result = await commitVmPackage({
        projectRoot: cfg.paths.project,
        parsed: parseVmPackage(body),
        mode: 'update',
        targetId: id,
        owner: { role: resourceViewRole(panelIdentity(req)), userId: req.panelUserId },
        proxyPool,
      })
      if (!result.ok) return respond(res, result.status, { ok: false, error: result.error })
      await fillTimezoneFromExit(id)
      let worker = null
      // The package may swap credentials or exit; a running worker keeps the old ones until reloaded.
      if (packageImportBringUp !== false && result.vm.status === 'running' && process.env.KIN_CRS_MOCK !== '1') {
        await setScheduleHold(cfg.paths.project, id, holdMaintenance, { tag: 'package_update_worker_reload' })
        worker = await reloadSlotReady(getVm(cfg.paths.project, id), cfg.paths.project, {
          routing: routingConfig,
        })
        if (worker.ok) await restoreSchedulableIfReady(id, { by: 'credential_import' })
      }
      const saved = getVm(cfg.paths.project, id) || result.vm
      return respond(
        res,
        200,
        panel.ok({
          vm: await summarizeVm(saved, cfg.paths.project, routingConfig),
          worker_reload: worker ? { ok: !!worker.ok, error: worker.ok ? null : worker.error || null } : null,
        }),
      )
    }
    if (req.method === 'POST' && p === '/api/panel/vms/package') {
      const body = await readBody(req, 256 * 1024).catch(() => null)
      const parsed = parseVmPackage(body)
      const ident = panelIdentity(req)
      const historic = (((await accountQuota?.snapshot?.()) || {}).accounts || []).flatMap((a) => [
        { id: a.vm_id },
        { id: a.account_id },
      ])
      const result = await commitVmPackage({
        projectRoot: cfg.paths.project,
        parsed,
        mode: 'create',
        owner: { role: resourceViewRole(ident), userId: req.panelUserId },
        proxyPool,
        occupied: historic,
      })
      if (!result.ok) return respond(res, result.status, { ok: false, error: result.error })
      await fillTimezoneFromExit(result.vm.id)
      const brought =
        packageImportBringUp === false
          ? { start_error: null, official_cc_bootstrap: null, probe: null }
          : await bringUpImportedVm(result.vm.id)
      const saved = getVm(cfg.paths.project, result.vm.id) || result.vm
      return respond(
        res,
        result.status,
        panel.ok({
          vm: await summarizeVm(saved, cfg.paths.project, routingConfig),
          renamed_from: result.renamed_from,
          start_error: brought.start_error,
          official_cc_bootstrap: brought.official_cc_bootstrap,
          probe: brought.probe,
        }),
      )
    }
    return false
  }
}
