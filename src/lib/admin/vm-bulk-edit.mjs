/** Single-process control-plane commands. No await between validation and writes other than DbClient
 * reads/writes (R6 B6c: they settle as microtasks on the single SQLite connection, no I/O in between).
 * SQLite membership commits are atomic; VM file writes have durable per-field receipts.
 * Retrying the same command never replays a completed field or overwrites a changed field.
 */
import { createHash } from 'node:crypto'
import { GroupsRepo } from '../db/repos/groups-repo.mjs'
import { dbClient } from '../db/db-client.mjs'
import { getVm, patchVmRecord, persistVmScheduleLevel } from '../vm/vm-registry.mjs'
import { isValidVmId } from '../vm/vm-file.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'
import { deriveScheduleFields, migrateScheduleRecord } from '../pool/schedule-state.mjs'
import { vendorRuntimeBlock } from '../vendor/vendor-runtime-policy.mjs'
import { audit, relayError } from './relay-common.mjs'
import { validateVmGroups } from './vm-group-validation.mjs'
import { insertVmBulkEdit, updateVmBulkEditReport, vmBulkEditById } from './repos/vm-bulk-edit-repo.mjs'

const fields = ['schedulable', 'max_concurrency', 'max_rpm', 'weight', 'schedule_level']
const done = (cell) => ['saved', 'unchanged', 'not_applicable'].includes(cell.status)
const canonical = (x) =>
  Array.isArray(x)
    ? x.map(canonical)
    : x && typeof x === 'object'
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, canonical(x[k])]),
        )
      : x
const hash = (x) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(x)))
    .digest('hex')
const same = (a, b) => hash(a) === hash(b)
const fail = (code, message, status = 400) => {
  throw relayError(code, message, status)
}
const validOperation = (id) => typeof id === 'string' && /^[a-zA-Z0-9_-]{16,80}$/.test(id)
function idsOf(ids) {
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    ids.length > 500 ||
    ids.some((id) => typeof id !== 'string' || id.length > 128 || !isValidVmId(id)) ||
    new Set(ids).size !== ids.length
  )
    fail('invalid_batch', '请选择 1–500 个不同的有效槽位')
  return ids
}
function valuesOf(vm) {
  const policy = vm.policy || {}
  const schedule = structuredClone(vm)
  migrateScheduleRecord(schedule)
  return {
    schedulable: schedule.schedule_off !== true,
    max_concurrency: policy.concurrencyOverride ? Number(policy.maxConcurrency) : null,
    max_rpm: policy.rpmOverride ? Number(policy.maxRpm) : null,
    weight: Number(policy.weight ?? 1),
    schedule_level: policy.priority ?? null,
  }
}
function applicable(field, vm) {
  return field === 'weight' ? isCodexVm(vm) : field === 'schedule_level' ? !isCodexVm(vm) : true
}
function parsePatch(patch) {
  if (
    !patch ||
    Array.isArray(patch) ||
    typeof patch !== 'object' ||
    !Object.keys(patch).length ||
    Object.keys(patch).some((key) => ![...fields, 'groups'].includes(key))
  )
    fail('invalid_patch', '批量编辑字段不正确')
  for (const field of fields) {
    if (!Object.hasOwn(patch, field)) continue
    const value = patch[field]
    if (field === 'schedulable') {
      if (typeof value !== 'boolean') fail('invalid_patch', '调度开关必须为布尔值')
    } else if (value !== null) {
      const [min, max] = {
        max_concurrency: [1, 256],
        max_rpm: [0, 1000000],
        weight: [1, 100],
        schedule_level: [1, 10],
      }[field]
      if (!Number.isInteger(value) || value < min || value > max) fail('invalid_patch', `${field}: ${min}–${max}`)
    }
  }
  if (patch.groups) {
    const g = patch.groups
    if (
      !['add', 'remove', 'replace'].includes(g.operation) ||
      !Array.isArray(g.ids) ||
      g.ids.length > 500 ||
      g.ids.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
      new Set(g.ids).size !== g.ids.length ||
      (g.operation !== 'replace' && !g.ids.length)
    )
      fail('invalid_groups', '分组操作或选择不正确')
  } else if (Object.hasOwn(patch, 'groups')) fail('invalid_groups', '分组操作不正确')
  return patch
}

export function createVmBulkEditService({ db, project, applyVmConcurrency, applyVmRpm, inheritVmScheduling }) {
  const groups = new GroupsRepo(db)
  async function vmOf(id) {
    const vm = getVm(project, id)
    if (!vm || vm.status === 'archived') fail('vm_not_found', `${id}: 槽位不存在或已归档`, 404)
    if ((await vendorRuntimeBlock(vm, db)) === 'vendor_archived')
      fail('resource_archived', `${id}: 供应商资源已归档`, 409)
    return vm
  }
  async function snapshot(ids) {
    // 逐个顺序读取：与原同步 map 一样，第一个不合格的槽位决定报错
    const items = []
    for (const id of idsOf(ids)) {
      const vm = await vmOf(id),
        values = valuesOf(vm)
      items.push({
        id,
        name: vm.name || id,
        platform: isCodexVm(vm) ? 'openai' : 'anthropic',
        values,
        versions: Object.fromEntries(fields.map((f) => [f, hash(values[f])])),
        group_ids: (await groups.forResource('vm', id)).map((g) => g.id).sort((a, b) => a - b),
        groups_version: await groups.resourceVersion('vm', id),
      })
    }
    return { items }
  }
  async function load(id, actor) {
    if (!validOperation(id)) fail('invalid_operation_id', '操作编号不正确')
    const row = await vmBulkEditById(db, id)
    if (!row) return null
    if (row.actor !== actor) fail('forbidden', '不能读取其他操作者的批量操作', 403)
    return { hash: row.request_hash, report: JSON.parse(row.report_json) }
  }
  async function persist(report) {
    report.status = report.items.every((item) => Object.values(item.fields).every(done)) ? 'complete' : 'incomplete'
    await updateVmBulkEditReport(db, JSON.stringify(report), new Date().toISOString(), report.operation_id)
  }
  async function apply(id, field, desired) {
    let vm
    if (field === 'max_concurrency' || field === 'max_rpm') {
      vm =
        desired === null
          ? inheritVmScheduling(id, { [field === 'max_concurrency' ? 'concurrency' : 'rpm']: true })
          : (field === 'max_concurrency' ? applyVmConcurrency : applyVmRpm)(id, desired, { override: true })
    } else if (field === 'schedule_level') vm = persistVmScheduleLevel(project, id, desired)
    else
      vm = patchVmRecord(project, id, (current) => {
        if (field === 'weight') current.policy = { ...current.policy, weight: desired }
        else {
          // Unlike the single-slot recovery action, a bulk switch must NOT clear restrictions.
          migrateScheduleRecord(current)
          current.schedule_off = !desired
          delete current.schedule_off_reason
          deriveScheduleFields(current, { preserveStatus: true })
        }
        return current
      })
    if (!vm || !same(valuesOf(await vmOf(id))[field], desired))
      fail('write_unconfirmed', '持久化结果未确认，请重试', 503)
  }
  async function save(input, actor) {
    if (!input || !validOperation(input.operation_id)) fail('invalid_operation_id', '缺少有效操作编号')
    const patch = parsePatch(input.patch)
    if (!Array.isArray(input.items)) fail('invalid_batch', '缺少目标快照')
    idsOf(input.items.map((i) => i?.id))
    const digest = hash(input),
      previous = await load(input.operation_id, actor)
    if (previous && previous.hash !== digest) fail('operation_conflict', '操作编号已用于其他修改', 409)
    if (previous?.report.status === 'complete') return previous.report
    const report = previous?.report || { operation_id: input.operation_id, status: 'incomplete', items: [] }
    const targets = []
    for (const item of input.items) targets.push({ item, vm: await vmOf(item.id) })
    if (patch.groups && new Set(targets.map(({ vm }) => isCodexVm(vm))).size > 1)
      fail('group_platform_mismatch', '修改分组前请选择同一平台的目标')
    // Freeze desired group sets once. Retries never recompute add/remove against changed membership.
    if (!previous) {
      // 分组归属先异步读出（R6 B6b：GroupsRepo 已改 async），再同步冻结
      const memberships = new Map()
      if (patch.groups)
        for (const { item } of targets)
          memberships.set(
            item.id,
            (await groups.forResource('vm', item.id)).map((g) => g.id).sort((a, b) => a - b),
          )
      report.items = targets.map(({ item, vm }) => {
        const before = valuesOf(vm),
          cells = {}
        for (const field of fields.filter((f) => Object.hasOwn(patch, f))) {
          if (!applicable(field, vm)) {
            cells[field] = { status: 'not_applicable' }
            continue
          }
          if (typeof item.versions?.[field] !== 'string') fail('snapshot_required', `${item.id}: 请重新打开编辑器`, 409)
          const desired = field === 'weight' && patch[field] === null ? 1 : patch[field]
          cells[field] = { status: 'pending', before: before[field], desired, expected: item.versions[field] }
        }
        if (patch.groups) {
          if (!Number.isSafeInteger(item.groups_version)) fail('snapshot_required', '缺少分组版本', 409)
          const beforeIds = memberships.get(item.id)
          const ids = patch.groups.ids
          const desired = (
            patch.groups.operation === 'replace'
              ? [...ids]
              : patch.groups.operation === 'add'
                ? [...new Set([...beforeIds, ...ids])]
                : beforeIds.filter((g) => !ids.includes(g))
          ).sort((a, b) => a - b)
          cells.groups = { status: 'pending', before: beforeIds, desired, expected: item.groups_version }
        }
        return { id: item.id, fields: cells }
      })
    }
    // All predictable errors are found before creating a command or writing any configuration.
    for (const row of report.items) {
      const vm = await vmOf(row.id),
        now = valuesOf(vm)
      for (const [field, cell] of Object.entries(row.fields)) {
        if (done(cell)) continue
        if (field !== 'groups' && !applicable(field, vm)) fail('platform_changed', `${row.id}: 平台已变化`, 409)
        if (field === 'schedulable' && cell.desired) {
          if ((await vendorRuntimeBlock(vm, db)) || /^vendor_/.test(String(vm.schedule_disabled_reason || '')))
            fail('vendor_controlled', `${row.id}: 供应商状态限制调度`, 409)
          if (
            /oauth_revoked|invalid_grant|refresh_token_missing|token has been revoked/i.test(
              `${vm.claude?.refresh_error || ''} ${vm.unschedulable?.reason || ''} ${vm.schedule_disabled_reason || ''}`,
            )
          )
            fail('credential_unavailable', `${row.id}: 请先重新授权凭证`, 409)
        }
        if (field === 'groups') {
          if ((await groups.resourceVersion('vm', row.id)) !== cell.expected)
            fail('version_conflict', `${row.id}: 分组已变化，请重新载入`, 409)
          await validateVmGroups(groups, vm, cell.desired)
          if (!cell.desired.length && cell.before.length && input.confirm_empty_groups !== true)
            fail('empty_groups_confirmation', '请确认清空分组后将停止接收普通用户的新请求')
        } else if (hash(now[field]) !== cell.expected && !(cell.status === 'writing' && same(now[field], cell.desired)))
          fail('version_conflict', `${row.id}: ${field} 已被其他操作修改，请重新载入`, 409)
      }
    }
    if (!previous)
      await insertVmBulkEdit(db, input.operation_id, actor, digest, JSON.stringify(report), new Date().toISOString())
    // Membership writes and their receipts commit together, retaining existing all-batch semantics.
    try {
      await dbClient(db).tx(async () => {
        for (const row of report.items) {
          const cell = row.fields.groups
          if (!cell || done(cell)) continue
          if (same(cell.before, cell.desired)) cell.status = 'unchanged'
          else {
            await groups.assignResource('vm', row.id, cell.desired, cell.expected, actor)
            cell.status = 'saved'
          }
        }
        await persist(report)
      })
    } catch (e) {
      // Read the rolled-back receipt, never return the mutated in-memory successes.
      const committed = (await load(input.operation_id, actor)).report
      committed.error = { code: e.code || 'groups_write_failed', message: '分组保存失败，请查询状态后重试' }
      return committed
    }
    for (const row of report.items) {
      for (const [field, cell] of Object.entries(row.fields)) {
        if (field === 'groups' || done(cell)) continue
        const recovering = cell.status === 'writing'
        try {
          const current = valuesOf(await vmOf(row.id))[field]
          if (!recovering && same(current, cell.desired)) cell.status = 'unchanged'
          else {
            cell.status = 'writing'
            delete cell.error
            await persist(report)
            await apply(row.id, field, cell.desired)
            await dbClient(db).tx(async () => {
              await audit(
                db,
                actor,
                'vm.bulk_edit',
                row.id,
                { [field]: cell.before },
                { [field]: cell.desired },
                input.operation_id,
              )
              cell.status = 'saved'
              await persist(report)
            })
          }
        } catch (e) {
          // May have persisted the file before runtime projection failed. Keep writing state so
          // only original/desired values can be reconciled; never call an uncertain write "failed".
          cell.status = 'writing'
          cell.error = { code: e.code || 'write_unconfirmed', message: '保存未确认，可查询后重试' }
        }
        await persist(report)
      }
    }
    return report
  }
  return {
    snapshot,
    save,
    get: async (id, actor) => {
      const item = await load(id, actor)
      if (!item) fail('operation_not_found', '尚未收到该保存操作', 404)
      return item.report
    },
  }
}
