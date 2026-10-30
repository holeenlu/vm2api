import { t as tVm } from '@/i18n'
import type { PreflightCheck, PreflightCheckId } from '@/types/panel-cluster'
import type { Vm } from '@/types/panel-vm'
import { isApiError } from '@/lib/api'

/** 远端槽位上被后端 409 `remote_unsupported` 拒绝的操作统一用这句说明。 */
export function remoteUnsupportedText() {
  return tVm('vm:placement.notSupportedOnRemoteNodesYet')
}

/** `node_id` 为空 / 缺省即本机。 */
export function isRemoteVm(vm: Pick<Vm, 'node_id'> | null | undefined) {
  return !!vm?.node_id
}

export const PREFLIGHT_CHECK_LABEL: Record<PreflightCheckId, string> = {
  ssh: 'SSH',
  docker: 'Docker',
  get arch() {
    return tVm('vm:physicalFeaturesCard.architecture')
  },
  get memory() {
    return tVm('vm:createVmForm.memoryAlternative')
  },
  get disk() {
    return tVm('vm:createVmForm.disk')
  },
  sudo: 'sudo',
  swap: 'Swap',
  get image() {
    return tVm('vm:detailStatusBoard.image')
  },
  hostd: 'hostd',
  get relay() {
    return tVm('vm:placement.relay')
  },
  kvm: 'KVM',
  get runtime() {
    return tVm('vm:placement.executionMode')
  },
  macos: 'macOS',
  launchd: 'launchd',
  get sleep() {
    return tVm('vm:placement.sleep')
  },
  get socket_path() {
    return tVm('vm:placement.socket')
  },
  get payload() {
    return tVm('vm:placement.artifacts')
  },
}

export type PreflightMark = 'ok' | 'fail' | 'warn'

/** ✓ 通过；✗ 失败的 error 级（阻断创建）；! 失败的 warn 级（只提示）。 */
export function preflightMark(check: Pick<PreflightCheck, 'ok' | 'level'>) {
  if (check.ok) return 'ok' as const
  return check.level === 'warn' ? ('warn' as const) : ('fail' as const)
}

/**
 * 409 `placement_preflight_failed` 的 `error.checks`。形状不对的条目丢弃，
 * 不是 ApiError 或没带 checks 时返回空数组。
 */
export function preflightChecksFromError(error: unknown): PreflightCheck[] {
  if (!isApiError(error) || !Array.isArray(error.checks)) return []
  return error.checks.filter(
    (c): c is PreflightCheck =>
      !!c &&
      typeof c === 'object' &&
      typeof (c as PreflightCheck).id === 'string' &&
      typeof (c as PreflightCheck).ok === 'boolean' &&
      ((c as PreflightCheck).level === 'error' ||
        (c as PreflightCheck).level === 'warn')
  )
}

/** 构建日志只留最后 `lines` 行；尾部换行不算一行。 */
export function logTail(log: string | null | undefined, lines = 20): string {
  const rows = String(log || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n+$/, '')
    .split('\n')
  return rows.slice(-lines).join('\n')
}
