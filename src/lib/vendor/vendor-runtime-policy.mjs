import { vendorGroupPlatforms } from './vendor-groups.mjs'
import { getDb, isDbOpen } from '../db/database.mjs'
import {
  accountResource,
  accountResourceSync,
  activeGroupNames,
  activeGroupNamesSync,
  proxyStatus,
  proxyStatusSync,
  vmGroupMemberships,
  vmGroupMembershipsSync,
} from './repos/runtime-policy-repo.mjs'
import { getVendorRow, getVendorRowSync } from './repos/vendors-repo.mjs'
import { getVendorVmResource, getVendorVmResourceSync } from './repos/resources-repo.mjs'
const parse = (value) => {
  try {
    return JSON.parse(value || '{}')
  } catch {
    return {}
  }
}
const platformName = (value) => ({ claude: 'anthropic', codex: 'openai' })[value] || value

const ASYNC_READS = {
  accountResource,
  getVendorVmResource,
  getVendorRow,
  vmGroupMemberships,
  activeGroupNames,
  proxyStatus,
}
const SYNC_READS = {
  accountResource: accountResourceSync,
  getVendorVmResource: getVendorVmResourceSync,
  getVendorRow: getVendorRowSync,
  vmGroupMemberships: vmGroupMembershipsSync,
  activeGroupNames: activeGroupNamesSync,
  proxyStatus: proxyStatusSync,
}

// 判定逻辑只写一份：每次读库 yield 一个读取结果（异步版本是 Promise，同步版本是值），由驱动函数交回结果。
function* runtimeBlockSteps(vm, db, read) {
  const account = yield read.accountResource(db, vm.vendor_account_resource_id)
  if (!account) return 'vendor_archived'
  const config = parse(account.config_json)
  const resource = yield read.getVendorVmResource(db, config.vm_resource_id, account.vendor_id)
  if (
    !resource ||
    parse(resource.config_json).runtime_vm_id !== vm.id ||
    [account.status, resource.status].includes('archived')
  )
    return 'vendor_archived'
  if (account.status !== 'active' || resource.status === 'paused') return 'vendor_paused'
  const vendor = yield read.getVendorRow(db, account.vendor_id)
  const parent = vendor?.parent_id ? yield read.getVendorRow(db, vendor.parent_id) : null
  if (!vendor || vendor.status !== 'active' || (vendor.parent_id && parent?.status !== 'active'))
    return 'vendor_disabled'
  const scopes = [vendor, ...(parent ? [parent] : [])]
  const platform = platformName(vm.platform || vm.family || config.platform)
  if (config.platform && platformName(config.platform) !== platform) return 'vendor_scope_revoked'
  const memberships = yield read.vmGroupMemberships(db, vm.id)
  if (
    !memberships.length ||
    memberships.some(
      (g) => g.status !== 'active' || g.deleted_at || g.mixed_kind || !vendorGroupPlatforms(g).includes(platform),
    )
  )
    return 'vendor_scope_revoked'
  const groups = memberships.map((g) => String(g.group_id))
  for (const scope of scopes) {
    const platforms = parse(scope.platforms_json)
    if (platforms.length && !platforms.map(platformName).includes(platform)) return 'vendor_scope_revoked'
    const allowed = parse(scope.groups_json)
    if (allowed.length) {
      const allowedGroups = (yield read.activeGroupNames(db))
        .filter((g) => allowed.includes(String(g.id)) || allowed.includes(g.name))
        .map((g) => String(g.id))
      if (!groups.length || groups.some((id) => !allowedGroups.includes(id))) return 'vendor_scope_revoked'
    }
  }
  if (config.proxy_id) {
    const proxy = yield read.proxyStatus(db, config.proxy_id, account.vendor_id)
    if (!proxy || proxy.status !== 'active') return 'vendor_proxy_disabled'
  }
  return null
}

// Consult authoritative supplier state when selecting a slot. A cached vm.json
// or a later credential refresh must not revive paused/revoked supply.
export async function vendorRuntimeBlock(vm, db = isDbOpen() ? getDb() : null) {
  if (!vm?.vendor_account_resource_id) return null
  if (!db) return 'vendor_policy_unavailable'
  const steps = runtimeBlockSteps(vm, db, ASYNC_READS)
  let step = steps.next()
  while (!step.done) step = steps.next(await step.value)
  return step.value
}

/**
 * R6 临时同步出口（B7 删除）：推理热路径（vm-registry summarizeVm / isSchedulable、codex-slot-pool）与
 * VM 批量编辑（vm-bulk-edit，B6c）仍同步调用。判定逻辑与 vendorRuntimeBlock 共用 runtimeBlockSteps。
 */
export function vendorRuntimeBlockSync(vm, db = isDbOpen() ? getDb() : null) {
  if (!vm?.vendor_account_resource_id) return null
  if (!db) return 'vendor_policy_unavailable'
  const steps = runtimeBlockSteps(vm, db, SYNC_READS)
  let step = steps.next()
  while (!step.done) step = steps.next(step.value)
  return step.value
}
