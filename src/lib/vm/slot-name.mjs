/**
 * 运营后台槽位命名：创建时名称留空的槽位先用自动编号占位，拿到授权邮箱后改名为完整授权邮箱。
 * 同一个邮箱已被别的槽位占用时保留占位名，等下一次授权或人工命名。
 * 规则与供应商平台的账号命名（vendor-account-name.mjs）一致，但改的是槽位记录的 name，两处各自落盘。
 */
import fs from 'node:fs'
import path from 'node:path'
import { atomicWriteJson, listVmRecordFiles } from './vm-file.mjs'

const text = (value) => (typeof value === 'string' ? value.trim() : '')

/** 槽位已记录的授权邮箱：Claude 与 GPT 槽位写在各自的凭据块里。 */
export function slotAuthorizationEmail(vm) {
  return text(vm?.email) || text(vm?.codex?.email) || text(vm?.claude?.email)
}

/** 其他槽位已占用的名称与 ID，统一小写比较。 */
export function takenSlotNames(projectRoot, selfId = null) {
  const dir = path.join(projectRoot, 'vms')
  const taken = new Set()
  for (const file of listVmRecordFiles(dir)) {
    const id = file.slice(0, -5)
    if (selfId && id === selfId) continue
    taken.add(id.toLowerCase())
    try {
      const name = text(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))?.name)
      if (name) taken.add(name.toLowerCase())
    } catch {}
  }
  return taken
}

/** 按新规则算名称：完整授权邮箱，已被别的槽位占用返回空串。 */
export function resolveSlotName(email, taken) {
  const mail = text(email)
  if (!mail || taken.has(mail.toLowerCase())) return ''
  return mail
}

/**
 * 待命名的槽位拿到授权邮箱后就地定名，由调用方负责写盘。
 * 命名成功才清除 `name_from_authorization`，冲突时保留标记等下次授权。
 */
export function applySlotNameFromAuthorization(projectRoot, vm, email, { taken = null } = {}) {
  if (!projectRoot || !vm?.id || vm.name_from_authorization !== true) return false
  const name = resolveSlotName(email, taken || takenSlotNames(projectRoot, vm.id))
  if (!name) return false
  vm.name = name
  delete vm.name_from_authorization
  return true
}

/**
 * 启动回填：存量槽位名称仍是自动编号且已有授权邮箱时改为新规则的名称。
 * 跳过人工命名过的槽位和供应商账号的运行环境，返回实际改名的槽位。
 */
export function backfillSlotNames(projectRoot) {
  const dir = path.join(projectRoot, 'vms')
  const rows = []
  const names = new Map()
  for (const file of listVmRecordFiles(dir)) {
    let vm = null
    try {
      vm = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
    } catch {
      continue
    }
    if (!vm?.id) continue
    rows.push({ file: path.join(dir, file), vm })
    names.set(vm.id, text(vm.name).toLowerCase())
  }
  const renamed = []
  for (const { file, vm } of rows) {
    if (vm.vendor_account_resource_id) continue
    // 名称等于 ID = 创建时留空拿到的自动编号；其余是人工命名，不动。
    if (vm.name_from_authorization !== true && text(vm.name) !== vm.id) continue
    const taken = new Set()
    for (const [id, name] of names) {
      if (id === vm.id) continue
      taken.add(id.toLowerCase())
      if (name) taken.add(name)
    }
    const name = resolveSlotName(slotAuthorizationEmail(vm), taken)
    if (!name) continue
    const from = vm.name
    vm.name = name
    delete vm.name_from_authorization
    vm.updated_at = new Date().toISOString()
    atomicWriteJson(file, vm, { mode: 0o600 })
    names.set(vm.id, name.toLowerCase())
    renamed.push({ id: vm.id, from, to: name })
  }
  return renamed
}
