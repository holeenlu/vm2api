import { resourceViewRole } from './panel-acl.mjs'
/** VM provisioning route adapter for create. */
export function createPanelVmProvisionRoutes(deps) {
  const {
    cfg,
    fs,
    path,
    json,
    readBody,
    listVms,
    accountQuota,
    newVmNaming,
    isValidVmId,
    panelIdentity,
    ctx,
    normalizeVmConfig,
    resolveMachineSpec,
    OS_CATALOG,
    kernelForIndex,
    RUNTIME_KVM,
    probeLocalKvm,
    preflightNode,
    stampVmKind,
    isCodexVm,
    slotHost,
    proxyPool,
    isLocalEgressId,
    isLocalEgressProxy,
    localProxyMismatchMessage,
    canBindProxyToVm,
    validTimezone,
    slotLocales,
    standardLocale,
    assignComputerFingerprint,
    takenFingerprintKeys,
    buildNewVmRecord,
    atomicWriteJson,
    writeGuestMachineIdFile,
    seedFreshCliHome,
    bindVmProxy,
    adoptVmProxyBinding,
    fillTimezoneFromExit,
    activateVmSlot,
    startSlotReady,
    patchVmRecord,
    markUnschedulable,
    getVm,
    clusterNodesOf,
    summarizeVm,
    panel,
  } = deps
  // 写完响应即视为已处理：panel-routes 按返回值决定是否继续匹配后面的路由
  const respond = (...args) => {
    json(...args)
    return true
  }
  return async function handlePanelVmProvisionRoutes(req, res, route) {
    const p = route
    // POST /api/panel/vms/create — configurable seed VM + pure Claude Code home
    if (req.method === 'POST' && p === '/api/panel/vms/create') {
      const body = await readBody(req, 32 * 1024)
      const existing = listVms(cfg.paths.project)
      // Usage, billing and account rows stay keyed by a deleted VM's id; handing that
      // id to a new slot makes it show the old account and spend. Auto-numbering skips them.
      const historic = (accountQuota?.snapshot?.().accounts || []).flatMap((a) => [
        { id: a.vm_id },
        { id: a.account_id },
      ])
      const naming = newVmNaming(existing, historic, body.name, cfg.paths.project)
      const idx = naming.index
      const rawId = body.id || naming.id
      const id = String(rawId).replace(/[^a-zA-Z0-9_-]/g, '')
      if (!isValidVmId(id)) return respond(res, 400, { ok: false, error: { message: 'invalid id' } })
      const vmsDir = path.join(cfg.paths.project, 'vms')
      fs.mkdirSync(vmsDir, { recursive: true })
      const vmPath = path.join(vmsDir, id + '.json')
      if (fs.existsSync(vmPath)) {
        return respond(res, 409, { ok: false, error: { message: 'vm id exists' } })
      }
      const ident = panelIdentity(req)
      // 被授予「创建」能力的 admin 与 super_admin 用同一套节点放置与出口绑定规则
      const role = resourceViewRole(ident)
      const startNow = body.start !== false && body.status !== 'stopped'
      const wantKernel = body.kernel && OS_CATALOG[body.kernel] ? body.kernel : kernelForIndex(idx)
      const nodeId = body.node_id ? String(body.node_id) : null
      const vmDefaults = normalizeVmConfig(ctx.routingConfig?.vm)
      const requestedRuntime = body.runtime_type
      let runtime
      if (requestedRuntime == null || requestedRuntime === '') {
        runtime = vmDefaults.default_runtime
      } else {
        const kind = String(requestedRuntime).trim().toLowerCase()
        if (kind !== 'docker' && kind !== 'kvm') {
          return respond(res, 400, {
            ok: false,
            error: {
              type: 'invalid_request_error',
              code: 'invalid_runtime_type',
              message: 'runtime_type 必须是 docker 或 kvm',
            },
          })
        }
        runtime = kind
      }
      let machine
      try {
        machine = resolveMachineSpec({ config: vmDefaults, overrides: body.machine, runtime })
      } catch (error) {
        if (error?.status === 400 || error?.code === 'invalid_machine') {
          return respond(res, 400, {
            ok: false,
            error: { type: 'invalid_request_error', code: 'invalid_machine', message: error.message },
          })
        }
        throw error
      }
      if (nodeId) {
        if (role !== 'super_admin') {
          return respond(res, 403, {
            ok: false,
            error: { code: 'placement_forbidden', message: '只有管理员可以把虚拟机放到集群节点' },
          })
        }
        const kindProbe = { node_id: nodeId }
        stampVmKind(kindProbe, body)
        if (isCodexVm(kindProbe) && !slotHost(kindProbe).supports('codex')) {
          return respond(res, 400, {
            ok: false,
            error: { code: 'remote_unsupported', message: '集群节点上的虚拟机暂不支持此操作' },
          })
        }
        let preflight
        try {
          preflight = await preflightNode(nodeId, { kernel: wantKernel, runtime, memory: machine.memory })
        } catch (e) {
          return respond(res, e?.status || 500, {
            ok: false,
            error: { code: e?.code || 'placement_failed', message: String(e?.message || e) },
          })
        }
        if (!preflight.ok) {
          return respond(res, 409, {
            ok: false,
            error: {
              code: 'placement_preflight_failed',
              message: '目标节点预检未通过',
              checks: preflight.checks,
            },
          })
        }
      }
      // An explicit exit (e.g. local egress for a node: that VPS's own route) replaces auto-allocation.
      let pickedProxyId = typeof body.proxy_id === 'string' ? body.proxy_id.trim() : ''
      if (pickedProxyId && isLocalEgressId(pickedProxyId)) {
        // Local egress is per VPS: a generic pick resolves to the target machine's own row.
        const resolved = proxyPool.resolveLocalTarget(pickedProxyId, nodeId || null)
        if (!resolved.ok) {
          return respond(res, 409, {
            ok: false,
            error: { code: resolved.error, message: localProxyMismatchMessage },
          })
        }
        pickedProxyId = resolved.id
      }
      if (pickedProxyId) {
        const row = proxyPool.snapshot().proxies.find((proxy) => proxy.id === pickedProxyId)
        const owner = null
        if (!row || !canBindProxyToVm(row, { owner_user_id: owner }, { role })) {
          return respond(res, 404, {
            ok: false,
            error: { code: 'proxy_not_found', message: '所选出口不存在或不能绑到此槽位' },
          })
        }
        const used = Array.isArray(row.bound_vm_ids) ? row.bound_vm_ids.length : 0
        if (!row.enabled || row.status === 'dead' || row.blocked_reason || used >= (row.bind_limit || 5)) {
          return respond(res, 409, {
            ok: false,
            error: { code: 'proxy_unavailable', message: '所选出口已失效或已绑满' },
          })
        }
      }
      if (runtime === RUNTIME_KVM && !nodeId) {
        const probe = typeof ctx.probeLocalKvm === 'function' ? ctx.probeLocalKvm : probeLocalKvm
        const kvm = await probe({ routing: ctx.routingConfig })
        if (!kvm?.ok) {
          return respond(res, 409, {
            ok: false,
            error: { code: 'kvm_unavailable', message: kvm?.error || '本机 KVM 不可用' },
          })
        }
      }
      const requestedTimezone = validTimezone(body.timezone)
      const requestedLocale = body.locale == null || body.locale === '' ? standardLocale : String(body.locale)
      if (!slotLocales.includes(requestedLocale)) {
        return respond(res, 400, {
          ok: false,
          error: { code: 'invalid_locale', message: `语言必须是 ${slotLocales.join('、')}` },
        })
      }
      let generated
      try {
        generated = assignComputerFingerprint(
          cfg.paths.project,
          {
            id,
            kernel: wantKernel,
            timezone: requestedTimezone,
            locale: requestedLocale,
            runtime: { type: runtime },
          },
          { taken: takenFingerprintKeys(existing) },
        )
      } catch (e) {
        return respond(res, 400, {
          ok: false,
          error: {
            code: e.code || 'computer_create_failed',
            message: String(e.message || e),
          },
        })
      }
      let vm
      try {
        vm = buildNewVmRecord({
          id,
          name: naming.name,
          kernel: wantKernel,
          runtime,
          machine,
          generated,
          body: { ...body, timezone: requestedTimezone },
          routing: ctx.routingConfig,
          status: startNow ? 'running' : body.status || 'stopped',
          nodeId,
        })
      } catch (error) {
        return respond(res, 400, {
          ok: false,
          error: { code: error.code || 'invalid_create_schedule', message: error.message },
        })
      }
      if (fs.existsSync(vmPath)) return respond(res, 409, { ok: false, error: { message: 'vm id exists' } })
      atomicWriteJson(vmPath, vm, { mode: 0o600 })
      writeGuestMachineIdFile(cfg.paths.project, id, generated.guest_machine_id)
      try {
        seedFreshCliHome(cfg.paths.project, vm)
      } catch (e) {}
      let allocated = null
      let proxyError = null
      const wantProxy = body.auto_allocate_proxy === true || startNow || !!pickedProxyId
      // px-local 没有 SOCKS URL，但它是合法出口；不要把它当成"未绑定"。
      const hasExit = (v) => !!(v?.proxy?.url || isLocalEgressProxy(v?.proxy))
      if (wantProxy && !hasExit(vm)) {
        if (pickedProxyId) {
          const bound = proxyPool.bind(pickedProxyId, id)
          if (bound.ok) allocated = bound.proxy
          else proxyError = bound.error || 'proxy_bind_failed'
        } else {
          try {
            allocated = proxyPool.allocateForVm(id, {
              ownerUserId: vm.owner_user_id || null,
              role,
            })
          } catch (e) {}
        }
        if (allocated) {
          bindVmProxy(cfg.paths.project, id, proxyPool.getProxyForVm(id))
          adoptVmProxyBinding(vm, getVm(cfg.paths.project, id))
        }
      }
      // vm is written again below; carry the exit's zone so that write keeps it.
      const zoned = await fillTimezoneFromExit(id)
      if (zoned?.applied) {
        vm.timezone = zoned.timezone
        vm.timezone_source = 'proxy_geo'
        if (vm.fingerprint && typeof vm.fingerprint === 'object') vm.fingerprint.timezone = zoned.timezone
      }
      if (body.activate === true) {
        try {
          activateVmSlot(id)
        } catch (e) {}
      }
      let startError = null
      if (startNow && hasExit(vm)) {
        let boot
        try {
          boot = await startSlotReady(vm, cfg.paths.project, { routing: ctx.routingConfig })
        } catch (e) {
          boot = { ok: false, error: String(e?.message || e) }
        }
        if (!boot.ok) {
          // Slot JSON is already on disk. 500 here makes the console treat
          // create as a no-op, so the new row never refetches into the list.
          patchVmRecord(cfg.paths.project, id, { status: 'error' })
          markUnschedulable(cfg.paths.project, id, 'runtime_start_failed', {
            message: String(boot.error || 'runtime start failed').slice(0, 240),
          })
          startError = boot.error || 'runtime start failed'
        } else {
          patchVmRecord(cfg.paths.project, id, { status: 'running' })
        }
      } else if (startNow) {
        patchVmRecord(cfg.paths.project, id, { status: 'stopped' })
      }
      const saved = getVm(cfg.paths.project, id) || vm
      return respond(
        res,
        200,
        panel.ok({
          vm: panel.publicVmBootView(summarizeVm(saved, cfg.paths.project, ctx.routingConfig)),
          allocated_proxy: panel.publicAllocatedProxy(proxyPool, allocated, {
            nodeId: saved.node_id || nodeId || null,
            role,
            nodes: clusterNodesOf(ctx),
          }),
          ...(startError ? { start_error: startError } : {}),
          ...(proxyError ? { proxy_error: proxyError } : {}),
        }),
      )
    }

    return false
  }
}
