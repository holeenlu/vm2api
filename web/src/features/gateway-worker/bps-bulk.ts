/** 批量编辑的 BPS 设置：每个开关可保持不变、开启或关闭；模型名单按追加 / 移除 / 替换合并。 */
export type BpsBulkValue = {
  flags: Partial<Record<BpsBulkFlag, '' | 'on' | 'off'>>
  modelMode: '' | 'add' | 'remove' | 'replace'
  models: string
  interval: string
  /** 429 冷却秒数（1–600），空表示不变 */
  cooldown: string
  /** 开启 403 自动移组时移入的分组：分组 ID，'0' 表示退出所有分组 */
  target: string
}

export const BPS_BULK_FLAGS = [
  ['enabled', 'codexBpsEnabled'],
  ['omit_unsupported_tools', 'codexBpsOmitTools'],
  ['ignore_encrypted_content', 'codexBpsIgnoreEncrypted'],
  ['auto_disable_on_403', 'codexBpsAutoDisable'],
  ['auto_recover_on_403', 'codexBpsAutoRecover'],
  ['auto_move_on_403', 'codexBpsAutoMove'],
  ['cache_creation_as_input', 'codexBpsCacheAsInput'],
] as const

export type BpsBulkFlag = (typeof BPS_BULK_FLAGS)[number][0]

export const emptyBpsBulk: BpsBulkValue = {
  flags: {},
  modelMode: '',
  models: '',
  interval: '',
  cooldown: '',
  target: '',
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
  if (value.cooldown.trim()) {
    const n = Number(value.cooldown)
    if (!Number.isInteger(n) || n < 1 || n > 600)
      throw error('codexBpsRateLimitCooldown')
    out.rate_limit_cooldown_seconds = n
  }
  // 开启 403 自动移组必须选移入分组（0 = 退出所有分组）；关闭时服务端清空目标分组
  if (value.flags.auto_move_on_403 === 'on') {
    const target = Number(value.target)
    if (value.target === '' || !Number.isSafeInteger(target) || target < 0)
      throw error('codexBpsBulkTargetRequired')
    out.target_group_id = target
  }
  return Object.keys(out).length ? out : null
}
