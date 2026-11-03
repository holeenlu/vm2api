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
import { invalidateVmSlotReadCache } from '../vm/vm-file.mjs'
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
  return ({ accountResourceId, name, body = {}, userId, beforeWrite }) => {
    const routingConfig = options.routingConfig
    const projectRoot = cfg.paths.project
    const vms = listVms(projectRoot)
    const vmDefaults = normalizeVmConfig(routingConfig?.vm)
    const runtime = vmDefaults.default_runtime
    const historic = getDb()
      .prepare('SELECT id,vm_id FROM accounts')
      .all()
      .flatMap((a) => [{ id: a.id }, { id: a.vm_id }])
    const naming = newVmNaming(vms, historic, name, projectRoot)
    const id = naming.id
    const vmPath = path.join(projectRoot, 'vms', id + '.json'),
      slotDir = path.join(projectRoot, 'vms', id)
    fs.mkdirSync(path.dirname(vmPath), { recursive: true })
    let ownsFile = false,
      ownsDir = false,
      fileIdentity = null,
      complete = false
    const rollback = () => {
      if (ownsFile) {
        const stat = fs.lstatSync(vmPath)
        if (stat.ino !== fileIdentity.ino || stat.dev !== fileIdentity.dev) throw new Error('VM rollback file changed')
        const current = complete ? JSON.parse(fs.readFileSync(vmPath, 'utf8')) : null
        if (complete && current.vendor_account_resource_id !== accountResourceId)
          throw new Error('VM creation rollback ownership mismatch')
        fs.unlinkSync(vmPath)
      }
      if (ownsDir) fs.rmSync(slotDir, { recursive: true, force: true })
      invalidateVmSlotReadCache(projectRoot, id)
    }
    try {
      fs.mkdirSync(slotDir, { mode: 0o700 })
      ownsDir = true
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
      beforeWrite?.(vm)
      const fd = fs.openSync(vmPath, 'wx', 0o600)
      fileIdentity = fs.fstatSync(fd)
      ownsFile = true
      try {
        fs.writeFileSync(fd, JSON.stringify(vm, null, 2))
        complete = true
      } finally {
        fs.closeSync(fd)
      }
      writeGuestMachineIdFile(projectRoot, id, generated.guest_machine_id)
      seedFreshCliHome(projectRoot, vm)
      return { id, name: vm.name, status: vm.status, path: vmPath, rollback }
    } catch (error) {
      rollback()
      throw error
    }
  }
}
