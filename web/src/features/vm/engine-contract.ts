import { t as tVm } from '@/i18n'
import type { InferenceEngine } from '@/types/panel-vm'
import { HOP_TRANSPORT_LABEL } from '@/features/vm/dataplane-contract'

export const DEFAULT_RESOLVED_ENGINE: InferenceEngine = 'rust'

export const INFERENCE_ENGINE_OPTIONS: {
  value: InferenceEngine
  label: string
}[] = [
  {
    value: 'auto',
    get label() {
      return tVm('vm:engineContract.automaticInheritRust')
    },
  },
  { value: 'rust', label: HOP_TRANSPORT_LABEL },
]

export function normalizeInferenceEngine(
  value: unknown,
  fallback: InferenceEngine
): InferenceEngine {
  if (value === 'auto' || value === 'rust') return value
  if (value === 'go') return 'rust'
  return fallback
}

export function inferenceEnginePatchValue(value: InferenceEngine) {
  return value === 'auto' ? '' : 'rust'
}

/** 公开仓全局引擎固定 rust。历史 go 取值一并收掉。 */
export function normalizeGlobalClaudeEngine(_value: unknown): 'rust' {
  return 'rust'
}

/** 公开仓不再回落 Go。 */
export function isFallbackToGo(_value: unknown): boolean {
  return false
}

export function inferenceEngineLabel(
  value: InferenceEngine | null | undefined
) {
  if (value === 'go') return HOP_TRANSPORT_LABEL
  return (
    INFERENCE_ENGINE_OPTIONS.find((option) => option.value === value)?.label ||
    tVm('vm:detailAccountTab.unknown')
  )
}
