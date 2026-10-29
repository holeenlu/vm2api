import fs from 'node:fs'
import path from 'node:path'
import { validTimezone } from '../core/timezone.mjs'
import { standardSeedPolicy } from '../protocol/seed-policy.mjs'
import { assignComputerFingerprint } from '../identity/slot-computer.mjs'
import {
  applyGeneratedFingerprint,
  generateWorkstationFingerprint,
  takenFingerprintKeys,
  writeGuestMachineIdFile,
} from '../identity/workstation-fingerprint.mjs'
import { atomicWriteJson } from '../vm/vm-file.mjs'
import { seedFreshCliHome } from '../vm/vm-recreate.mjs'
import { listVms } from '../vm/vm-registry.mjs'
import { OS_CATALOG, STANDARD_LOCALE, kernelForIndex, nextNumericIndex, padVm } from '../vm/vm-runtime.mjs'
import { stampVmKind } from '../vm/vm-kind.mjs'
import { normalizeVmConfig, resolveMachineSpec } from '../vm/machine-spec.mjs'

function clean(value) {
  return String(value ?? '').trim()
}

function nextVendorVmId(projectRoot, resourceId) {
  const preferred = `vendor-vm-${
    clean(resourceId)
      .replace(/[^A-Za-z0-9]/g, '')
      .slice(-16) || 'slot'
  }`
  const existing = new Set(listVms(projectRoot).map((vm) => vm.id))
  if (!existing.has(preferred)) return preferred
  let index = nextNumericIndex(listVms(projectRoot))
  while (existing.has(`vendor-vm-${padVm(index)}`)) index += 1
  return `vendor-vm-${padVm(index)}`
}

/**
 * Create the runtime slot used by a supplier account. This is a dedicated
 * provisioning seam; it does not call the operator panel HTTP endpoint.
 * Credential exchange and starting the slot remain separate lifecycle steps.
 */
export function createVendorVmProvisioner({ cfg, routingConfig } = {}) {
  if (!cfg?.paths?.project) return null
  return ({ resourceId, accountResourceId, name, body = {}, userId }) => {
    const projectRoot = cfg.paths.project
    const vms = listVms(projectRoot)
    const id = nextVendorVmId(projectRoot, resourceId)
    const runtime = clean(body.runtime_type).toLowerCase() === 'kvm' ? 'kvm' : 'docker'
    const kernel = OS_CATALOG[body.kernel] ? body.kernel : kernelForIndex(nextNumericIndex(vms))
    const timezone = validTimezone(body.timezone) || null
    const locale = clean(body.locale) || STANDARD_LOCALE
    const machine = resolveMachineSpec({ config: normalizeVmConfig(routingConfig?.vm), runtime })
    const fingerprintInput = { id, kernel, timezone, locale, runtime: { type: runtime } }
    let generated
    try {
      generated = assignComputerFingerprint(projectRoot, fingerprintInput, { taken: takenFingerprintKeys(vms) })
    } catch (error) {
      if (error?.code !== 'computer_service_missing') throw error
      generated = generateWorkstationFingerprint(fingerprintInput, { taken: takenFingerprintKeys(vms) })
    }
    const timestamp = new Date().toISOString()
    const vm = {
      id,
      name: clean(name) || id,
      status: 'stopped',
      kernel,
      timezone: timezone || generated.timezone || null,
      timezone_source: timezone ? 'manual' : 'auto',
      locale: generated.locale || locale,
      region: clean(body.region) || null,
      note: '供应商账号自动创建 · 等待授权',
      proxy: body.proxy || null,
      policy: {
        maxConcurrency: 0,
        concurrencyOverride: false,
        maxRpm: 0,
        rpmOverride: false,
        weight: 1,
        inflight: 0,
      },
      claude: {},
      fingerprint: applyGeneratedFingerprint({}, generated),
      stats: {},
      created_at: timestamp,
      updated_at: timestamp,
      schedulable: false,
      schedule_disabled_reason: 'no_credential',
      unschedulable: { reason: 'no_credential', detail: null, at: timestamp },
      proxy_cli_enabled: !!body.proxy,
      proxy_required: !!body.proxy,
      seed_policy: standardSeedPolicy(),
      runtime: { type: runtime },
      machine,
      owner_user_id: userId || null,
      origin: 'platform',
      vendor_account_resource_id: accountResourceId,
    }
    stampVmKind(vm, body)
    fs.mkdirSync(path.join(projectRoot, 'vms'), { recursive: true })
    atomicWriteJson(path.join(projectRoot, 'vms', `${id}.json`), vm, { mode: 0o600 })
    writeGuestMachineIdFile(projectRoot, id, generated.guest_machine_id)
    seedFreshCliHome(projectRoot, vm)
    return { id, status: vm.status, path: path.join(projectRoot, 'vms', `${id}.json`) }
  }
}
