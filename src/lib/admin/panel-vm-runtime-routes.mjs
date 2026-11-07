/** VM runtime operations that do not mutate slot configuration. */
export function createPanelVmRuntimeRoutes({
  cfg,
  json,
  readBody,
  panel,
  panelIdentity,
  getVm,
  reloadSlotReady,
  slotShell,
  assertVendorRuntimeVm,
  collectSlotIdentity,
  routing,
  auditSensitiveAction,
}) {
  const respond = (...args) => {
    json(...args)
    return true
  }
  return async function handlePanelVmRuntimeRoutes(req, res, route) {
    const reload = route.match(/^\/api\/panel\/vms\/([^/]+)\/reload$/)
    if (reload && req.method === 'POST') {
      const id = reload[1]
      const vm = getVm(cfg.paths.project, id)
      if (!vm) return respond(res, 404, { ok: false, error: { message: 'vm not found' } })
      const reloaded = await reloadSlotReady(vm, cfg.paths.project, { routing })
      if (!reloaded.ok)
        return respond(res, 500, {
          ok: false,
          error: { message: reloaded.error || 'reload failed', code: reloaded.code },
        })
      return respond(res, 200, panel.ok({ id, reload: reloaded }))
    }

    const shell = route.match(/^\/api\/panel\/vms\/([^/]+)\/shell-ticket$/)
    if (shell && req.method === 'POST') {
      const body = await readBody(req, 1024).catch(() => ({}))
      const vmId = shell[1]
      const supplier = panelIdentity(req).role === 'vendor'
      if (supplier && body.login !== true) {
        const error = { code: 'login_only', message: '供应商终端仅用于官方登录' }
        return respond(res, 403, { ok: false, error })
      }
      const issued = await slotShell.issueTicket(vmId, {
        login: body.login === true,
        restrictedLogin: supplier,
        ...(supplier ? { authorize: () => assertVendorRuntimeVm(req, vmId) } : {}),
      })
      if (!issued.ok) return respond(res, issued.status, { ok: false, error: issued.error })
      // 票据本身不进审计；记录操作者、来源 IP、目标 VM 与签发时间
      await auditSensitiveAction(req, 'vm.shell_ticket', vmId, {
        login: body.login === true,
        role: panelIdentity(req).role,
        expires_in: issued.expires_in,
      })
      return respond(res, 200, panel.ok({ ticket: issued.ticket, expires_in: issued.expires_in }))
    }

    const identity = route.match(/^\/api\/panel\/vms\/([^/]+)\/collect-identity$/)
    if (identity && req.method === 'POST') {
      const id = identity[1]
      const vm = getVm(cfg.paths.project, id)
      if (!vm) return respond(res, 404, { ok: false, error: { message: 'vm not found' } })
      const collected = await collectSlotIdentity(cfg.paths.project, vm)
      if (!collected.ok)
        return respond(res, 502, {
          ok: false,
          error: { message: collected.error || 'collect failed', code: collected.code },
        })
      return respond(res, 200, panel.ok(collected))
    }
    return false
  }
}
