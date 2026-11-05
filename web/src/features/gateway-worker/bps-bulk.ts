/** 批量编辑的 BPS 设置：每个开关可保持不变、开启或关闭；模型名单按追加 / 移除 / 替换合并。 */
export type BpsBulkValue = {
  flags: Partial<Record<BpsBulkFlag, '' | 'on' | 'off'>>
  modelMode: '' | 'add' | 'remove' | 'replace'
  models: string
  interval: string
}

export const BPS_BULK_FLAGS = [
  ['enabled', 'codexBpsEnabled'],
  ['omit_unsupported_tools', 'codexBpsOmitTools'],
  ['ignore_encrypted_content', 'codexBpsIgnoreEncrypted'],
  ['auto_disable_on_403', 'codexBpsAutoDisable'],
  ['auto_recover_on_403', 'codexBpsAutoRecover'],
  ['cache_creation_as_input', 'codexBpsCacheAsInput'],
] as const

export type BpsBulkFlag = (typeof BPS_BULK_FLAGS)[number][0]

export const emptyBpsBulk: BpsBulkValue = {
  flags: {},
  modelMode: '',
  models: '',
  interval: '',
}

/** 把表单转为 bulk-edit 的 bps 补丁；没有任何改动时返回 null。 */
export function bpsBulkPatch(
  value: BpsBulkValue,
  error: (key: string) => Error
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {}
  for (const [key] of BPS_BULK_FLAGS) {
    const state = value.flags[key]
    if (state) out[key] = state === 'on'
  }
  if (value.modelMode) {
    const ids = [
      ...new Set(
        value.models
          .split(/[\s,]+/)
          .map((id) => id.trim())
          .filter(Boolean)
      ),
    ]
    if (ids.some((id) => id.includes('*')) || ids.length > 100)
      throw error('codexBpsBulkModelsInvalid')
    if (!ids.length && value.modelMode !== 'replace')
      throw error('codexBpsBulkModelsRequired')
    out.models = { operation: value.modelMode, ids }
  }
  if (value.interval.trim()) {
    const n = Number(value.interval)
    if (!Number.isInteger(n) || n < 1 || n > 10080)
      throw error('codexBpsRecoveryInterval')
    out.recovery_interval_minutes = n
  }
  return Object.keys(out).length ? out : null
}
