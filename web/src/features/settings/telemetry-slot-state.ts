import { t as translate } from '@/i18n'
import type { Vm, VmDetailPayload } from '@/types/panel-vm'
import { telemetryEnabled } from '@/features/vm/telemetry-policy'

export type LiveKey = 'live' | 'idle' | 'blocked' | 'parked' | 'unknown' | 'off'

export const LIVE_ORDER: LiveKey[] = [
  'live',
  'idle',
  'blocked',
  'parked',
  'unknown',
  'off',
]

export type SlotState = {
  vm: Vm
  on: boolean
  live: LiveKey
  label: string
  probing: boolean
}

/**
 * `on` is the seed bit. The sidecar process stays up even when worker.json has
 * telemetry disabled (no official identity), so a live process alone is not an upload.
 */
export function slotState(
  vm: Vm,
  detail: { data?: VmDetailPayload; isPending: boolean } | undefined
): SlotState {
  const on = telemetryEnabled(vm.seed_policy)
  const observed = detail?.data?.kernel?.telemetry
  const running = observed?.running
  if (!on) {
    return {
      vm,
      on,
      live: 'off',
      label:
        running === true && observed?.enabled === true
          ? translate('settings:telemetryState.stopping')
          : translate('settings:telemetry.off'),
      probing: false,
    }
  }
  if (vm.status !== 'running') {
    return {
      vm,
      on,
      live: 'parked',
      label: translate('settings:telemetryState.stopped'),
      probing: false,
    }
  }
  if (!detail || detail.isPending) {
    return {
      vm,
      on,
      live: 'unknown',
      label: translate('settings:telemetryState.probing'),
      probing: true,
    }
  }
  if (observed?.enabled === false) {
    return {
      vm,
      on,
      live: 'blocked',
      label: vm.node_id
        ? translate('settings:telemetryState.clusterNoIdentity')
        : translate('settings:telemetryState.noIdentity'),
      probing: false,
    }
  }
  if (running === true && observed?.enabled === true)
    return {
      vm,
      on,
      live: 'live',
      label: translate('settings:telemetry.uploading'),
      probing: false,
    }
  if (running === false)
    return {
      vm,
      on,
      live: 'idle',
      label: translate('settings:telemetryState.processStopped'),
      probing: false,
    }
  return {
    vm,
    on,
    live: 'unknown',
    label: translate('settings:unknownStatus'),
    probing: false,
  }
}
