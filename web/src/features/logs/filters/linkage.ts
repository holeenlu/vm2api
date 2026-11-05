import type {
  UsageLogFilterOptions,
  UsagePlatform,
} from '@/types/panel-usage-logs'
import type { LogsFilterState } from '../search'

export const PLATFORM_LABELS: Record<UsagePlatform, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
}

export type ScopedFilterOptions = {
  groups: UsageLogFilterOptions['groups']
  models: string[]
  accounts: { id: string; name: string }[]
  vms: { id: string; name: string }[]
}

type Group = UsageLogFilterOptions['groups'][number]
type Model = UsageLogFilterOptions['models'][number]

function groupAllowsModel(group: Group, model: Model) {
  if (group.models.length) return group.models.includes(model.id)
  if (!group.platform || group.platform === 'mixed') return true
  return model.platform === group.platform
}

/**
 * 筛选联动：平台约束分组（含 mixed 分组）、模型、上游账号、槽位；
 * 分组约束模型（白名单，未设白名单按分组平台）、上游账号与槽位（分组资源）。
 * 选中的分组不在选项里（深链）时不施加分组约束。
 */
export function scopeFilterOptions(
  filters: LogsFilterState,
  options: UsageLogFilterOptions | undefined
): ScopedFilterOptions {
  const platform = filters.platform
  const inPlatform = (p: UsagePlatform | null) => !platform || p === platform
  const group = filters.groupId
    ? options?.groups.find((g) => g.id === filters.groupId)
    : undefined
  const inGroup = (groupIds: string[]) => !group || groupIds.includes(group.id)
  return {
    groups: (options?.groups ?? []).filter(
      (g) => !platform || g.platform === platform || g.platform === 'mixed'
    ),
    models: (options?.models ?? [])
      .filter(
        (m) =>
          m.id.trim() &&
          inPlatform(m.platform) &&
          (!group || groupAllowsModel(group, m))
      )
      .map((m) => m.id),
    accounts: (options?.accounts ?? [])
      .filter((a) => inPlatform(a.platform) && inGroup(a.groupIds))
      .map(({ id, name }) => ({ id, name })),
    vms: (options?.vms ?? [])
      .filter((v) => inPlatform(v.platform) && inGroup(v.groupIds))
      .map(({ id, name }) => ({ id, name })),
  }
}

/**
 * 平台或分组变化后清掉已不在可选范围内的分组、模型、上游账号、槽位；
 * 不在选项里的值（深链、近期无记录）无法判断归属，保留交给后端。
 */
export function reconcileFilters(
  filters: LogsFilterState,
  options: UsageLogFilterOptions | undefined
): LogsFilterState {
  if (!options) return filters
  const next = { ...filters }
  const known = <T extends { id: string }>(
    list: T[] | undefined,
    id?: string
  ) => !!id && !!list?.some((item) => item.id === id)
  if (
    known(options.groups, next.groupId) &&
    !scopeFilterOptions(next, options).groups.some((g) => g.id === next.groupId)
  )
    next.groupId = undefined
  const scoped = scopeFilterOptions(next, options)
  if (known(options.models, next.model) && !scoped.models.includes(next.model!))
    next.model = undefined
  if (
    known(options.accounts, next.accountId) &&
    !scoped.accounts.some((a) => a.id === next.accountId)
  )
    next.accountId = undefined
  if (
    known(options.vms, next.vmId) &&
    !scoped.vms.some((v) => v.id === next.vmId)
  )
    next.vmId = undefined
  return next
}
