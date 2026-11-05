/** Credential and machine identity mutations for an existing VM slot. */
export function createPanelVmCredentialRoutes({
  cfg,
  fs,
  path,
  json,
  readBody,
  withVmLock,
  getVm,
  patchVmRecord,
  migrateScheduleRecord,
  applyUnschedulable,
  invalidateLiveCredentialCache,
  stopCodexKernel,
  ensureCodexKernel,
  slotExec,
  isCodexVm,
  accountQuota,
  summarizeVm,
  routingConfig,
  assignComputerFingerprint,
  takenFingerprintKeys,
  listVms,
  atomicWriteJson,
  writeGuestMachineIdFile,
  applyGeneratedFingerprint,
  applyOfficialFingerprintToVm,
  officialCcHome,
}) {
  const respond = (...args) => {
    json(...args)
    return true
  }

  return async function handlePanelVmCredentialRoutes(req, res, route) {
    const match = route.match(
      /^\/api\/panel\/vms\/([^/]+)\/(credential\/clear|reset-fingerprint|reconcile-fingerprint)$/,
    )
    if (!match) return false
    const id = match[1]
    const action = match[2]
    const vmPath = path.join(cfg.paths.project, 'vms', `${id}.json`)
    if (!fs.existsSync(vmPath))
      return respond(res, 404, { ok: false, error: { code: 'vm_not_found', message: 'vm not found' } })

    if (action === 'reset-fingerprint' && req.method === 'POST') {
      const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
      const generated = assignComputerFingerprint(cfg.paths.project, vm, {
        taken: takenFingerprintKeys(listVms(cfg.paths.project), { exceptId: id }),
      })
      vm.timezone = generated.timezone
      vm.locale = generated.locale
      vm.fingerprint = applyGeneratedFingerprint({}, generated)
      vm.updated_at = generated.reset_at
      atomicWriteJson(vmPath, vm, { mode: 0o600 })
      writeGuestMachineIdFile(cfg.paths.project, id, generated.guest_machine_id)
      applyOfficialFingerprintToVm(vmPath, path.join(cfg.paths.project, 'vms', id, 'cli-home'))
      let saved = vm
      try {
        saved = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
      } catch {}
      return respond(res, 200, { ok: true, data: { id, fingerprint: saved.fingerprint } })
    }

    if (action === 'reconcile-fingerprint' && req.method === 'POST') {
      const result = applyOfficialFingerprintToVm(vmPath, officialCcHome(cfg.paths.project, id))
      const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
      return respond(res, 200, {
        ok: true,
        data: {
          vm_id: id,
          ...result,
          identity_source: vm.fingerprint?.identity_source || null,
          has_official_user: !!vm.fingerprint?.official_user_id,
          has_official_machine: !!vm.fingerprint?.official_machine_id,
        },
      })
    }

    if (action !== 'credential/clear' || req.method !== 'POST')
      return respond(res, 405, { ok: false, error: { code: 'method_not_allowed', message: 'method not allowed' } })
    await readBody(req, 32 * 1024).catch(() => ({}))
    return withVmLock(vmPath, async () => {
      if (!fs.existsSync(vmPath))
        return respond(res, 404, { ok: false, error: { code: 'vm_not_found', message: 'vm not found' } })
      const prev = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
      prev.id = prev.id || id
      const slotDir = path.join(cfg.paths.project, 'vms', id)
      const removed = []
      for (const file of [
        path.join(slotDir, 'codex-credentials.json'),
        path.join(slotDir, 'cli-home', '.codex', 'auth.json'),
        path.join(slotDir, 'cli-home', '.claude', 'credentials.json'),
        path.join(slotDir, 'cli-home', '.claude', '.credentials.json'),
      ]) {
        try {
          if (fs.existsSync(file)) {
            fs.rmSync(file, { force: true })
            removed.push(path.relative(cfg.paths.project, file))
          }
        } catch {}
      }
      const vm =
        patchVmRecord(cfg.paths.project, id, (record) => {
          record.email = null
          record.account_uuid = null
          record.org_uuid = null
          record.expires_at = null
          record.codex = {}
          record.claude = {}
          record.worker_credential = null
          record.refresh_status = null
          record.refresh_error = null
          record.restriction_reason = null
          record.restriction_until = null
          migrateScheduleRecord(record)
          applyUnschedulable(record, 'no_credential')
          return record
        }) || prev
      try {
        invalidateLiveCredentialCache()
      } catch {}
      const kernel = { stopped: false, restarted: false, error: null }
      try {
        kernel.stopped = !!stopCodexKernel(id)
        if (isCodexVm(vm)) {
          const started = await ensureCodexKernel(slotExec(cfg.paths.project, getVm(cfg.paths.project, id) || vm), {
            timeoutMs: 8000,
          })
          kernel.restarted = !!started?.ok
          if (!started?.ok) kernel.error = started?.reason || 'codex_kernel_start_failed'
        }
      } catch (error) {
        kernel.error = String(error?.message || error).slice(0, 160)
      }
      try {
        const repo = accountQuota?.repo
        const row = repo && typeof repo.get === 'function' ? repo.get(id) : null
        if (row && typeof repo.save === 'function') repo.save({ ...row, email: null, name: id })
      } catch {}
      const saved = getVm(cfg.paths.project, id) || vm
      const currentRouting = typeof routingConfig === 'function' ? routingConfig() : routingConfig
      return respond(res, 200, {
        ok: true,
        data: {
          cleared: { vm_id: id, files: removed, kernel },
          vm: summarizeVm(saved, cfg.paths.project, currentRouting),
        },
      })
    })
  }
}
