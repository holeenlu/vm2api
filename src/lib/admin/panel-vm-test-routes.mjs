import { identityCanResource } from './panel-acl.mjs'
/**
 * VM test and schedule route adapter.
 *
 * The underlying schedule store and connectivity runner remain owned by the
 * panel composition root. This module only owns route matching, body limits
 * and response envelopes so test operations can be changed independently from
 * VM lifecycle/configuration code.
 */
export function createPanelVmTestRoutes({
  cfg,
  panel,
  panelIdentity,
  readBody,
  json,
  getVm,
  isValidVmId,
  vmTestSchedule,
  VmTestScheduleError,
  runVmTestChat,
  resolveTestModels,
}) {
  const respond = (...args) => {
    json(...args)
    return true
  }
  const scheduleError = (error, fallback) => ({
    ok: false,
    error: {
      code: error?.code || fallback,
      message: String(error?.message || error),
    },
  })

  return async function handlePanelVmTestRoutes(req, res, path, url) {
    const scheduleMatch = path.match(/^\/api\/panel\/vms\/([^/]+)\/test-schedule$/)
    if (scheduleMatch) {
      const id = scheduleMatch[1]
      if (!isValidVmId(id))
        return respond(res, 400, { ok: false, error: { code: 'invalid_vm_id', message: 'invalid vm id' } })
      if (!getVm(cfg.paths.project, id))
        return respond(res, 404, { ok: false, error: { code: 'vm_not_found', message: 'vm not found' } })
      if (req.method === 'GET') return respond(res, 200, panel.ok({ schedule: await vmTestSchedule.get(id) }))
      if (req.method === 'DELETE') {
        await vmTestSchedule.remove(id)
        return respond(res, 200, panel.ok({ schedule: null }))
      }
      if (req.method !== 'PUT')
        return respond(res, 405, { ok: false, error: { code: 'method_not_allowed', message: 'method not allowed' } })
      let body
      try {
        body = await readBody(req, 64 * 1024)
      } catch (error) {
        return respond(res, 400, {
          ok: false,
          error: { code: 'invalid_request', message: String(error?.message || 'invalid JSON body') },
        })
      }
      try {
        return respond(res, 200, panel.ok({ schedule: await vmTestSchedule.save(id, body) }))
      } catch (error) {
        const typed = error instanceof VmTestScheduleError
        return respond(res, typed ? error.status : 400, scheduleError(error, 'test_schedule_save_failed'))
      }
    }

    if (path === '/api/panel/test-schedule/default') {
      if (req.method === 'GET') return respond(res, 200, panel.ok({ schedule: vmTestSchedule.getDefaultTemplate() }))
      if (req.method !== 'PUT')
        return respond(res, 405, { ok: false, error: { code: 'method_not_allowed', message: 'method not allowed' } })
      let body
      try {
        body = await readBody(req, 16 * 1024)
      } catch (error) {
        return respond(res, 400, {
          ok: false,
          error: { code: 'invalid_request', message: String(error?.message || 'invalid JSON body') },
        })
      }
      try {
        if (body == null || body.schedule == null) await vmTestSchedule.clearDefaultTemplate()
        else await vmTestSchedule.saveDefaultTemplate(body.schedule)
        return respond(res, 200, panel.ok({ schedule: vmTestSchedule.getDefaultTemplate() }))
      } catch (error) {
        const typed = error instanceof VmTestScheduleError
        return respond(res, typed ? error.status : 400, scheduleError(error, 'test_schedule_default_failed'))
      }
    }

    if (path === '/api/panel/test-schedule/sync') {
      if (req.method !== 'POST')
        return respond(res, 405, { ok: false, error: { code: 'method_not_allowed', message: 'method not allowed' } })
      let body
      try {
        body = await readBody(req, 256 * 1024)
      } catch (error) {
        return respond(res, 400, {
          ok: false,
          error: { code: 'invalid_request', message: String(error?.message || 'invalid JSON body') },
        })
      }
      try {
        return respond(
          res,
          200,
          panel.ok(
            await vmTestSchedule.syncSchedules({
              scope: body?.scope,
              vmIds: body?.vm_ids,
              schedule: body?.schedule,
              test: body?.test ?? null,
            }),
          ),
        )
      } catch (error) {
        const typed = error instanceof VmTestScheduleError
        return respond(res, typed ? error.status : 400, scheduleError(error, 'test_schedule_sync_failed'))
      }
    }

    const chatMatch = path.match(/^\/api\/panel\/vms\/([^/]+)\/test-chat$/)
    if (chatMatch) {
      if (req.method !== 'POST')
        return respond(res, 405, { ok: false, error: { code: 'method_not_allowed', message: 'method not allowed' } })
      const body = await readBody(req, 64 * 1024).catch(() => ({}))
      const result = await runVmTestChat({
        projectRoot: cfg.paths.project,
        vmId: chatMatch[1],
        model: body.model || body.model_id || '',
        prompt: body.prompt || body.message || '',
        max_tokens: body.max_tokens,
        reasoning_effort: body.reasoning_effort || body.effort,
        timeoutMs: body.timeout_ms || body.timeoutMs,
        baseUrl: `http://127.0.0.1:${cfg.port}`,
        apiKey: cfg.api_key,
        accountQuota: cfg.accountQuota,
      })
      return respond(res, 200, panel.ok(result))
    }

    if (path === '/api/panel/test-models') {
      if (req.method !== 'GET')
        return respond(res, 405, { ok: false, error: { code: 'method_not_allowed', message: 'method not allowed' } })
      const refresh =
        identityCanResource(panelIdentity(req), 'edit') && ['1', 'true'].includes(url?.searchParams.get('refresh'))
      const payload = await resolveTestModels({
        projectRoot: cfg.paths.project,
        vmId: url?.searchParams.get('vm_id') || url?.searchParams.get('vm') || '',
        platform: url?.searchParams.get('platform') || url?.searchParams.get('kind') || '',
        refresh,
      })
      return respond(res, 200, panel.ok(payload))
    }
    return false
  }
}
