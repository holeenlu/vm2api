/** VM reset/recreate lifecycle adapter. */
export function createPanelVmResetRoutes({
  cfg,
  json,
  readBody,
  panel,
  fs,
  path,
  withVmLock,
  destroySlot,
  recreateVmFiles,
  getVm,
  invalidateLiveCredentialCache,
  hasBoundExit,
  proxyPool,
  bindVmProxy,
  adoptVmProxyBinding,
  patchVmRecord,
  markUnschedulable,
  startSlotReady,
  summarizeVm,
  routingConfig,
}) {
  return async function handlePanelVmResetRoutes(req, res, route) {
    const p = route
    if (req.method === 'POST' && /^\/api\/panel\/vms\/[^/]+\/reset$/.test(p)) {
      const id = p.split('/')[4]
      const vmPath = path.join(cfg.paths.project, 'vms', `${id}.json`)
      if (!fs.existsSync(vmPath)) return json(res, 404, { ok: false, error: { message: 'vm not found' } })
      const body = await readBody(req, 32 * 1024).catch(() => ({}))
      const mode = body.mode === 'keep' ? 'keep' : 'traits'
      return await withVmLock(vmPath, async () => {
        if (!fs.existsSync(vmPath)) return json(res, 404, { ok: false, error: { message: 'vm not found' } })
        const prev = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
        const gone = await destroySlot(prev)
        if (!gone.ok) {
          return json(res, 500, { ok: false, error: { message: gone.error || 'destroy failed', code: gone.code } })
        }
        let { vm } = recreateVmFiles(cfg.paths.project, prev, { mode })
        try {
          invalidateLiveCredentialCache()
        } catch {}
        if (!hasBoundExit(vm.proxy)) {
          try {
            const allocated = proxyPool.allocateForVm(id)
            if (allocated) {
              bindVmProxy(cfg.paths.project, id, proxyPool.getProxyForVm(id))
              adoptVmProxyBinding(vm, getVm(cfg.paths.project, id))
            }
          } catch {}
        }
        if (!hasBoundExit(vm.proxy)) {
          vm =
            (patchVmRecord(cfg.paths.project, id, { status: 'stopped' }),
            markUnschedulable(cfg.paths.project, id, 'proxy_required'),
            getVm(cfg.paths.project, id)) || vm
          return json(res, 409, {
            ok: false,
            error: { code: 'proxy_required', message: 'No healthy SOCKS5 is available for this VM' },
            vm: summarizeVm(vm, cfg.paths.project, routingConfig),
            destroyed: gone.action,
          })
        }
        const boot = await startSlotReady(vm, cfg.paths.project, { recreate: true, routing: routingConfig })
        if (!boot.ok) {
          vm =
            (patchVmRecord(cfg.paths.project, id, { status: 'stopped' }),
            markUnschedulable(cfg.paths.project, id, 'runtime_start_failed', {
              message: String(boot.error || 'runtime start failed').slice(0, 240),
            }),
            getVm(cfg.paths.project, id)) || vm
          if (gone.action !== 'absent') {
            return json(res, 500, {
              ok: false,
              error: { message: boot.error || 'runtime start failed', code: boot.code },
              vm: summarizeVm(vm, cfg.paths.project, routingConfig),
              destroyed: gone.action,
            })
          }
          return json(
            res,
            200,
            panel.ok({
              vm: summarizeVm(vm, cfg.paths.project, routingConfig),
              destroyed: gone.action,
              recreated: true,
              mode,
              runtime: panel.publicSlotBoot(boot),
            }),
          )
        }
        vm =
          (patchVmRecord(cfg.paths.project, id, { status: 'running' }),
          mode === 'keep' ? null : markUnschedulable(cfg.paths.project, id, 'no_credential'),
          getVm(cfg.paths.project, id)) || vm
        return json(
          res,
          200,
          panel.ok({
            vm: summarizeVm(getVm(cfg.paths.project, id) || vm),
            destroyed: gone.action,
            recreated: true,
            mode,
            boot: panel.publicSlotBoot(boot),
          }),
        )
      })
    }
    return false
  }
}
