import { projectSeedSettings } from './ops/seed-settings-query.mjs'
import { seedSettingsPatchFromBody } from './ops/seed-settings-command.mjs'

/** Seed settings read/write adapter. Keeps publication locking and CAS semantics in one route seam. */
export function createPanelVmSeedRoutes({
  cfg,
  json,
  readBody,
  panel,
  getVm,
  fs,
  path,
  withVmLock,
  readSeedSettings,
  defaultSeedPolicy,
  seedTelemetryContract,
  readTelemetryUploadLog,
  isCodexVm,
  slotHost,
  isTelemetryEnabled,
  validTimezone,
  standardLocale,
  slotLocales,
  syncVmTimezoneFromProxy,
  proxyPool,
  atomicWriteJson,
  writeSlotSeedFiles,
  applyNativeTelemetry,
  routingConfig,
}) {
  const respond = (...args) => {
    json(...args)
    return true
  }
  return async function handlePanelVmSeedRoutes(req, res, route) {
    const p = route
    // GET /api/panel/vms/:id/seed-settings
    if (req.method === 'GET' && /^\/api\/panel\/vms\/[^/]+\/seed-settings$/.test(p)) {
      const id = p.split('/')[4]
      const vm = getVm(cfg.paths.project, id)
      if (!vm) return respond(res, 404, { ok: false, error: { message: 'vm not found' } })
      const observed = await readSeedSettings(cfg.paths.project, vm)
      const seed_policy = defaultSeedPolicy(vm.seed_policy || {})
      const debug = new URL(req.url || '/', 'http://localhost').searchParams.get('debug') === '1'
      const payload = projectSeedSettings({
        vmId: id,
        seedPolicy: seed_policy,
        telemetry: seedTelemetryContract(seed_policy),
        observed,
      })
      if (debug) {
        try {
          payload.telemetry_log = await readTelemetryUploadLog(cfg.paths.project, vm)
        } catch {
          payload.telemetry_log = []
          payload.telemetry_log_error = 'telemetry_log_unavailable'
        }
      }
      return respond(res, 200, panel.ok(payload))
    }
    // PUT /api/panel/vms/:id/seed-settings
    if (req.method === 'PUT' && /^\/api\/panel\/vms\/[^/]+\/seed-settings$/.test(p)) {
      const id = p.split('/')[4]
      const vmPath = path.join(cfg.paths.project, 'vms', `${id}.json`)
      if (!fs.existsSync(vmPath)) return respond(res, 404, { ok: false, error: { message: 'vm not found' } })
      const body = await readBody(req, 256 * 1024)
      return await withVmLock(`seed-settings:${vmPath}`, async () => {
        let vm = getVm(cfg.paths.project, id)
        if (!vm) return respond(res, 404, { ok: false, error: { message: 'vm not found' } })
        const patch = seedSettingsPatchFromBody(body)
        if (
          isCodexVm(vm) ||
          (slotHost(vm).native && isTelemetryEnabled(defaultSeedPolicy({ ...(vm.seed_policy || {}), ...patch })))
        ) {
          return respond(res, 409, {
            ok: false,
            error: { code: 'telemetry_unsupported', message: '此槽不支持 VM 原生遥测' },
          })
        }
        const followProxyTz = body.timezone_follow_proxy === true || body.timezoneFollowProxy === true
        const hasTimezone = Object.hasOwn(body, 'timezone')
        const hasLocale = Object.hasOwn(body, 'locale')
        let timezone = null
        let locale = null
        if (hasLocale) {
          locale = body.locale == null || body.locale === '' ? standardLocale : String(body.locale)
          if (!slotLocales.includes(locale)) {
            return respond(res, 400, {
              ok: false,
              error: { code: 'invalid_locale', message: `语言必须是 ${slotLocales.join('、')}` },
            })
          }
        }
        if (hasTimezone) {
          timezone = validTimezone(body.timezone)
          if (!timezone) {
            return respond(res, 400, {
              ok: false,
              error: {
                type: 'invalid_request_error',
                code: 'invalid_timezone',
                message: '时区必须是有效的 IANA 名称，如 Asia/Tokyo',
                param: 'timezone',
              },
            })
          }
        } else if (followProxyTz) {
          const route = JSON.stringify({ node_id: vm.node_id, proxy: vm.proxy })
          const synced = await syncVmTimezoneFromProxy(cfg.paths.project, proxyPool, id, {
            force: true,
            persist: false,
          })
          if (!synced.ok) {
            return respond(res, 400, {
              ok: false,
              error: {
                type: 'invalid_request_error',
                code: synced.reason || 'proxy_timezone_unknown',
                message: '未能从代理节点取到时区，请先检测代理地理位置',
              },
            })
          }
          vm = getVm(cfg.paths.project, id)
          if (!vm) return respond(res, 404, { ok: false, error: { message: 'vm not found' } })
          if (route !== JSON.stringify({ node_id: vm.node_id, proxy: vm.proxy })) {
            return respond(res, 409, {
              ok: false,
              error: { code: 'proxy_binding_changed', message: '代理绑定已变化，请重新保存时区设置' },
            })
          }
          timezone = synced.timezone
        }
        // Only patch owned fields on the latest record, never an object held across geo/publication awaits.
        vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
        const next = defaultSeedPolicy({ ...(vm.seed_policy || {}), ...patch })
        const unsupported = slotHost(vm).native || isCodexVm(vm)
        if (isCodexVm(vm) || (unsupported && isTelemetryEnabled(next))) {
          return respond(res, 409, {
            ok: false,
            error: { code: 'telemetry_unsupported', message: '此槽不支持 VM 原生遥测' },
          })
        }
        if (timezone) {
          vm.timezone = timezone
          vm.timezone_source = hasTimezone ? 'manual' : 'proxy_geo'
          if (vm.fingerprint && typeof vm.fingerprint === 'object') vm.fingerprint.timezone = timezone
        }
        if (locale) vm.locale = locale
        vm.seed_policy = next
        vm.updated_at = new Date().toISOString()
        atomicWriteJson(vmPath, vm, { mode: 0o600 })
        let service
        if (unsupported) {
          service = await withVmLock(`seed-publication:${vmPath}`, async () => {
            const outcome = {
              ok: false,
              wrote: false,
              supported: false,
              state: 'unsupported',
              published: false,
              applied: false,
            }
            const revision = (record) =>
              JSON.stringify([record.node_id, record.runtime, record.seed_policy, record.timezone, record.locale])
            try {
              const host = slotHost(vm)
              const existing = await host.seedFiles(vm, path.join(cfg.paths.project, 'vms', id))
              const fresh = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
              if (revision(fresh) !== revision(vm)) throw new Error('seed_publication_superseded')
              outcome.seed = writeSlotSeedFiles(cfg.paths.project, fresh, null, {
                existingSettings:
                  existing.files['settings.json'] === null ? {} : JSON.parse(existing.files['settings.json']),
                replaceEnv: Object.hasOwn(body, 'extra_env') || Object.hasOwn(body, 'settings_json_override'),
              })
              outcome.wrote = outcome.seed.wrote === true
              const result = await host.syncSeed(fresh, path.join(cfg.paths.project, 'vms', id))
              outcome.published = result.published === true
              if (revision(JSON.parse(fs.readFileSync(vmPath, 'utf8'))) !== revision(fresh))
                throw new Error('seed_publication_superseded')
              outcome.ok = outcome.published
            } catch {
              outcome.code = 'seed_publish_failed'
              outcome.error = '槽位种子配置尚未确认发布'
            }
            return outcome
          })
        } else {
          service = await applyNativeTelemetry({
            projectRoot: cfg.paths.project,
            vm,
            routing: routingConfig,
            replaceEnv: Object.hasOwn(body, 'extra_env') || Object.hasOwn(body, 'settings_json_override'),
          })
        }
        const { seed: written, ...publicService } = service
        const data = {
          vm_id: id,
          seed_policy: next,
          ...seedTelemetryContract(next),
          saved: true,
          published: service.published === true,
          applied: service.applied === true,
          settings_json: written?.settings || null,
          claude_setting: written?.claude_setting ?? null,
          kin_seed: written?.kin_seed || null,
          service: publicService,
        }
        if (!service.ok) {
          return respond(res, 502, {
            ok: false,
            error: { code: service.code || 'telemetry_not_applied', message: service.error || 'VM 原生配置尚未生效' },
            data,
          })
        }
        return respond(res, 200, panel.ok(data))
      })
    }
    return false
  }
}
