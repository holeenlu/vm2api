import { t as tVm } from '@/i18n'
import type { VmKernelSnapshot } from '@/types/panel-vm'

type NativeTelemetry = VmKernelSnapshot['telemetry']

/** A saved switch is not the VM's acknowledgement or proof of a cleared queue. */
export function telemetryPolicyConfirmed(
  telemetry: NativeTelemetry,
  enabled: boolean
): boolean {
  if (!telemetry || telemetry.state === 'unsupported') return false
  if (enabled) return telemetry.enabled && telemetry.state !== 'disabled'
  return (
    !telemetry.enabled &&
    telemetry.state === 'disabled' &&
    telemetry.pending_events === 0
  )
}

export function telemetryStatusLabel(
  telemetry: NativeTelemetry,
  desired: boolean | null = null
): string {
  if (telemetry?.state === undefined && desired === null) {
    if (telemetry?.enabled === false)
      return tVm('vm:telemetryStatus.notEnabled')
    if (telemetry?.enabled !== true)
      return tVm('vm:telemetryStatus.statusUnknown')
    if (telemetry.running === true)
      return tVm('vm:telemetryStatus.processRunning')
    if (telemetry.running === false)
      return tVm('vm:telemetryStatus.enabledProcessStopped')
    return tVm('vm:telemetryStatus.enabledProcessStateUnknown')
  }
  if (telemetry?.state === 'unsupported')
    return tVm('vm:telemetryStatus.unsupported')
  if (desired !== null && !telemetryPolicyConfirmed(telemetry, desired)) {
    return desired
      ? tVm('vm:telemetryStatus.pendingEnable')
      : tVm('vm:telemetryStatus.pendingDisable')
  }
  if (!telemetry) return tVm('vm:telemetryStatus.statusUnknown')
  switch (telemetry.state) {
    case 'disabled':
      return tVm('vm:telemetryStatus.disabledConfirmed')
    case 'waiting_credentials':
      return tVm('vm:telemetryStatus.waitingCredentials')
    case 'waiting_egress':
      return tVm('vm:telemetryStatus.waitingEgress')
    case 'uploading':
      return tVm('vm:telemetryStatus.uploading')
    case 'error':
      return tVm('vm:telemetryStatus.uploadError')
    case 'idle':
      return telemetry.pending_events
        ? tVm('vm:telemetryStatus.pendingBatch', {
            count: telemetry.pending_events,
          })
        : tVm('vm:telemetryStatus.idle')
  }
  return tVm('vm:telemetryStatus.statusUnknown')
}
