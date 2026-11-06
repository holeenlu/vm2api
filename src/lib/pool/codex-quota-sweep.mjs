/**
 * Codex 额度调度回写（#737）：把每个 Codex 槽的 5h/7d 限制回写到槽文件。
 *
 * 选槽从不依赖这份回写——`orderCodexSessionSlots` 按槽记录里的 extra 与当前策略实时判定停放，
 * 回写只服务面板状态与旧版「额度关调度」迁移。此前每次选槽（含每次等待唤醒、每次换号）都同步
 * 遍历并读写全部 `vms/*.json`，50 并发时主线程被这些同步 I/O 占满（#737）。
 *
 * 现在选槽只登记一次「需要回写」，同一项目目录最多每 CODEX_QUOTA_SWEEP_MIN_GAP_MS 执行一轮，
 * 且在请求之外（定时器回调）执行；额度变化（persistCodexUsage）、策略保存（routing-runtime）、
 * 用量探测（usage-probe reconcile）仍各自即时回写单个槽，不经这里。
 */
import path from 'node:path'
import { isCodexVm, syncCodexQuotaSchedule } from '../vm/vm-registry.mjs'
import { listVmRecordFiles, readJsonCached } from '../vm/vm-file.mjs'

/**
 * 两轮回写的最小间隔。回写内容只随时间推移（窗口重置、限制到期）或额度头变化而变；后者已由
 * persistCodexUsage 即时处理，前者 5 秒的面板滞后可以接受，同时把每秒数百次的全量读写压到每 5 秒一次。
 */
export const CODEX_QUOTA_SWEEP_MIN_GAP_MS = 5_000

const sweeps = new Map()

/** 同步遍历一次全部 Codex 槽记录并回写额度限制；单个槽失败不影响其余槽。返回处理的槽数。 */
export function syncAllCodexQuotaSchedules(projectRoot, { now = Date.now(), policy = null } = {}) {
  if (!projectRoot) return 0
  const vmDir = path.join(projectRoot, 'vms')
  let synced = 0
  for (const file of listVmRecordFiles(vmDir)) {
    let vm
    try {
      vm = readJsonCached(path.join(vmDir, file))
    } catch {
      continue
    }
    if (!vm?.id || !isCodexVm(vm)) continue
    try {
      syncCodexQuotaSchedule(projectRoot, vm, { now, policy })
      synced += 1
    } catch (error) {
      console.warn(`[codex-quota-sweep] ${vm.id}: ${error?.message || error}`)
    }
  }
  return synced
}

/**
 * 登记一次回写，不在调用方同步执行。已有待执行的一轮时只更新策略（以最后一次登记的为准）；
 * 距上一轮不足最小间隔时推迟到间隔结束。返回本次是否新排了一轮。
 */
export function requestCodexQuotaSweep(projectRoot, policy = null, { minGapMs = CODEX_QUOTA_SWEEP_MIN_GAP_MS } = {}) {
  if (!projectRoot) return false
  let state = sweeps.get(projectRoot)
  if (!state) {
    state = { lastAt: 0, timer: null, policy: null }
    sweeps.set(projectRoot, state)
  }
  state.policy = policy
  if (state.timer) return false
  const wait = Math.max(0, state.lastAt + minGapMs - Date.now())
  state.timer = setTimeout(() => {
    state.timer = null
    state.lastAt = Date.now()
    syncAllCodexQuotaSchedules(projectRoot, { policy: state.policy })
  }, wait)
  state.timer.unref?.()
  return true
}

/** 测试与停机用：取消全部待执行的回写并清空节流状态。 */
export function resetCodexQuotaSweeps() {
  for (const state of sweeps.values()) if (state.timer) clearTimeout(state.timer)
  sweeps.clear()
}
