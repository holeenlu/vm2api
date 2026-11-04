import type {
  UsageLogFilterOptions,
  UsagePlatform,
} from '@/types/panel-usage-logs'
import type { LogsFilterState } from '../search'

export const PLATFORM_LABELS: Record<UsagePlatform, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
}

/**
 * 平台联动：选定平台后上游账号、模型只列该平台的选项；
 * 切换平台时清掉已知属于其他平台的账号/模型，深链带来的未知值保留。
 */
export function withPlatform(
  filters: LogsFilterState,
  platform: UsagePlatform | undefined,
  options: UsageLogFilterOptions | undefined
): LogsFilterState {
  const next = { ...filters, platform }
  if (!platform) return next
  const account = options?.accounts?.find((a) => a.id === filters.accountId)
  if (account && account.platform !== platform) next.accountId = undefined
  const model = options?.models.find((m) => m.id === filters.model)
  if (model && model.platform !== platform) next.model = undefined
  return next
}
