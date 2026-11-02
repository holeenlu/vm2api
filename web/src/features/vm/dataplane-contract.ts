import { t as tVm } from '@/i18n'

export type KernelDataplane = 'wrap' | 'cc' | 'crag'

export const HOP_TRANSPORT_LABEL = 'Rust · cli-hop'

export function dataplaneHint() {
  return tVm('vm:dataplaneContract.transportIsFixedToRustCliHopDefaultCli')
}

export function dataplaneLabel(value: unknown): string {
  if (value === 'crag') return 'crag + cc-node'
  if (value === 'cc') return 'cc-node + kernel'
  return 'cli-node + kernel'
}
