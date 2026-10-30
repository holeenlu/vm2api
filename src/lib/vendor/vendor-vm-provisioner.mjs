import fs from 'node:fs'
import path from 'node:path'
import { getDb } from '../db/database.mjs'
import { buildNewVmRecord } from '../vm/vm-create-config.mjs'
import { assignComputerFingerprint } from '../identity/slot-computer.mjs'
import {
  generateWorkstationFingerprint,
  takenFingerprintKeys,
  writeGuestMachineIdFile,
} from '../identity/workstation-fingerprint.mjs'
import { atomicWriteJson } from '../vm/vm-file.mjs'
import { seedFreshCliHome } from '../vm/vm-recreate.mjs'
import { listVms } from '../vm/vm-registry.mjs'
import { STANDARD_LOCALE, kernelForIndex, newVmNaming } from '../vm/vm-runtime.mjs'
import { normalizeVmConfig, resolveMachineSpec } from '../vm/machine-spec.mjs'

/**
 * Create the runtime slot used by a supplier account. This is a dedicated
 * provisioning seam; it does not call the operator panel HTTP endpoint.
 * Credential exchange remains separate, while the runtime is prepared with
 * the same system VM defaults used by the operator create flow.
 */
export function createVendorVmProvisioner(options = {}) {
  const { cfg } = options
  if (!cfg?.paths?.project) return null
  return ({ accountResourceId, name, body = {}, userId }) => {
    const routingConfig = options.routingConfig
    const projectRoot = cfg.paths.project
    const vms = listVms(projectRoot)
    const vmDefaults = normalizeVmConfig(routingConfig?.vm)
    const runtime = vmDefaults.default_runtime
    const historic = getDb()
      .prepare('SELECT id,vm_id FROM accounts')
      .all()
      .flatMap((a) => [{ id: a.id }, { id: a.vm_id }])
    const naming = newVmNaming(vms, historic, name)
    const id = naming.id
    const kernel = kernelForIndex(naming.index)
    const timezone = null
    const locale = STANDARD_LOCALE
    const machine = resolveMachineSpec({ config: vmDefaults, runtime })
    const fingerprintInput = { id, kernel, timezone, locale, runtime: { type: runtime } }
    let generated
    try {
      generated = assignComputerFingerprint(projectRoot, fingerprintInput, { taken: takenFingerprintKeys(vms) })
    } catch (error) {
      if (error?.code !== 'computer_service_missing') throw error
      generated = generateWorkstationFingerprint(fingerprintInput, { taken: takenFingerprintKeys(vms) })
    }
    const vm = buildNewVmRecord({
      id,
      name: naming.name,
      kernel,
      runtime,
      machine,
      generated,
      body: { platform: body.platform, proxy_cli_enabled: !!body.proxy },
      routing: routingConfig,
      ownerUserId: userId || null,
      proxy: body.proxy || null,
      vendorAccountResourceId: accountResourceId,
    })
    fs.mkdirSync(path.join(projectRoot, 'vms'), { recursive: true })
    atomicWriteJson(path.join(projectRoot, 'vms', `${id}.json`), vm, { mode: 0o600 })
    writeGuestMachineIdFile(projectRoot, id, generated.guest_machine_id)
    seedFreshCliHome(projectRoot, vm)
    return { id, name: vm.name, status: vm.status, path: path.join(projectRoot, 'vms', `${id}.json`) }
  }
}
