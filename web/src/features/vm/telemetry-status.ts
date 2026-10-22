import { t as tVm } from '@/i18n'
import type { VmKernelSnapshot } from '@/types/panel-vm'

export function telemetryStatusLabel(telemetry: VmKernelSnapshot['telemetry']) {
  if (telemetry?.enabled === false) return tVm('vm:telemetryStatus.notEnabled')
  if (telemetry?.enabled !== true)
    return tVm('vm:telemetryStatus.statusUnknown')
  if (telemetry.running === true)
    return tVm('vm:telemetryStatus.processRunning')
  if (telemetry.running === false)
    return tVm('vm:telemetryStatus.enabledProcessStopped')
  return tVm('vm:telemetryStatus.enabledProcessStateUnknown')
}
