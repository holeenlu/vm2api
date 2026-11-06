/** VM scheduling, maintenance and destructive lifecycle adapters. */
export function createPanelVmMaintenanceRoutes({
  cfg,
  json,
  readBody,
  panel,
  getVm,
  listVms,
  setScheduleOff,
  holdSchedulableSlots,
  waitForSlotDrain,
  kernelUpdateHold = 'kernel_update',
  resumeSchedulableSlots,
  isMaintenanceHold,
  activateVmSlot,
  deactivateVmSlot,
  clearVmCooldown,
  resetVmCircuit,
  deleteVm,
}) {
  const respond = (...args) => {
    json(...args)
    return true
  }
  return async function handlePanelVmMaintenanceRoutes(req, res, route) {
    if (req.method === 'POST' && route === '/api/panel/vms/schedule/hold') {
      const body = await readBody(req, 8192).catch(() => ({}))
      const reason = String(body?.reason || kernelUpdateHold).slice(0, 64)
      const ids = await holdSchedulableSlots(cfg.paths.project, reason)
      const drain = await waitForSlotDrain(ids)
      if (!drain.ok) {
        const restored = await resumeSchedulableSlots(cfg.paths.project, ids, reason)
        return respond(res, 409, {
          ok: false,
          error: { code: 'slots_busy', message: '在途请求未结束，已恢复调度' },
          data: { paused: ids.length, restored: restored.length, inflight: drain.inflight, drained: false },
        })
      }
      return respond(res, 200, panel.ok({ paused: ids.length, inflight: 0, drained: true }))
    }

    if (req.method === 'POST' && route === '/api/panel/vms/schedule/resume') {
      const body = await readBody(req, 8192).catch(() => ({}))
      const reason = String(body?.reason || kernelUpdateHold).slice(0, 64)
      const ids = ((await listVms(cfg.paths.project)) || [])
        .filter((vm) => isMaintenanceHold(vm, reason))
        .map((vm) => vm.id)
      const restored = await resumeSchedulableSlots(cfg.paths.project, ids, reason)
      return respond(res, 200, panel.ok({ restored: restored.length }))
    }

    const toggle = route.match(/^\/api\/panel\/vms\/([^/]+)\/schedulable$/)
    if (toggle && req.method === 'POST') {
      const id = toggle[1]
      if (!getVm(cfg.paths.project, id))
        return respond(res, 404, { ok: false, error: { code: 'vm_not_found', message: 'vm not found' } })
      const body = await readBody(req, 8192).catch(() => ({}))
      if (typeof body?.schedulable !== 'boolean')
        return respond(res, 400, { ok: false, error: { message: 'schedulable required' } })
      const currentVm = getVm(cfg.paths.project, id)
      const credentialFailure =
        /oauth_revoked|oauth_invalid_grant|invalid_grant|refresh_token_missing|token has been revoked/i.test(
          `${currentVm?.claude?.refresh_error || ''} ${currentVm?.schedule_disabled_reason || ''}`,
        )
      if (body.schedulable && credentialFailure)
        return respond(res, 409, {
          ok: false,
          error: { code: 'credential_unavailable', message: '凭证已失效或吊销，请重新导入凭证后再开启调度' },
        })
      const reason = body.schedulable ? null : body.reason || 'disabled'
      const summary = await setScheduleOff(cfg.paths.project, id, !body.schedulable, { reason, preserveStatus: true })
      return respond(
        res,
        200,
        panel.ok({
          id,
          schedulable: summary?.schedulable !== false,
          schedule_manual: summary?.schedule_manual === true,
          schedule_disabled_reason: summary?.schedule_disabled_reason || null,
          status: summary?.status || null,
        }),
      )
    }

    const cooldown = route.match(/^\/api\/panel\/vms\/([^/]+)\/cooldown\/clear$/)
    if (cooldown && req.method === 'POST') {
      const result = await clearVmCooldown(cooldown[1])
      return respond(res, result.status || 200, result.status ? result.body : result)
    }

    const circuit = route.match(/^\/api\/panel\/vms\/([^/]+)\/circuit\/reset$/)
    if (circuit && req.method === 'POST') {
      const result = await resetVmCircuit(decodeURIComponent(circuit[1]))
      return respond(res, result.status || 200, result.status ? result.body : result)
    }

    const activate = route.match(/^\/api\/panel\/vms\/([^/]+)\/activate$/)
    if (activate && req.method === 'POST') {
      const id = activate[1]
      if (!getVm(cfg.paths.project, id))
        return respond(res, 404, { ok: false, error: { code: 'vm_not_found', message: 'vm not found' } })
      return respond(res, 200, panel.ok(await activateVmSlot(id)))
    }

    const deactivate = route.match(/^\/api\/panel\/vms\/([^/]+)\/deactivate$/)
    if (deactivate && req.method === 'POST') {
      const id = deactivate[1]
      if (!getVm(cfg.paths.project, id))
        return respond(res, 404, { ok: false, error: { code: 'vm_not_found', message: 'vm not found' } })
      return respond(res, 200, panel.ok(deactivateVmSlot(id)))
    }

    if (req.method === 'POST' && /^\/api\/panel\/vms\/[^/]+\/update-claude-code$/.test(route))
      return respond(res, 410, {
        ok: false,
        error: {
          code: 'claude_cli_removed',
          message: 'Claude CLI runtime was replaced by the Go slot worker; build and roll out the worker instead',
        },
      })

    const deletion = route.match(/^\/api\/panel\/vms\/([^/]+)$/)
    if (deletion && req.method === 'DELETE') return deleteVm(deletion[1], respond, res, req)
    return false
  }
}
