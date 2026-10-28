import { t } from '@/i18n'

export type ViewId =
  | 'groups'
  | 'ops'
  | 'subscriptions'
  | 'overview'
  | 'cluster'
  | 'vm'
  | 'import'
  | 'specs'
  | 'billing'
  | 'proxies'
  | 'models'
  | 'risk'
  | 'system'
  | 'keys'
  | 'api'
  | 'anthropic'
  | 'logs'
  | 'statistics'
  | 'database'
  | 'settings'
  | 'users'
  | 'wrap'

export const VIEW_TITLES: Record<ViewId, string> = {
  get groups() {
    return t('common:groups')
  },
  get ops() {
    return t('common:operations')
  },
  get subscriptions() {
    return t('common:subscriptions')
  },
  get overview() {
    return t('common:overview')
  },
  get cluster() {
    return t('common:cluster')
  },
  get vm() {
    return t('common:virtualMachines')
  },
  get import() {
    return t('common:import')
  },
  get specs() {
    return t('common:specifications')
  },
  get billing() {
    return t('common:billing')
  },
  get proxies() {
    return t('common:proxyPool')
  },
  get models() {
    return t('common:models')
  },
  get risk() {
    return t('common:riskAudit')
  },
  get system() {
    return t('common:systemPrompts')
  },
  get keys() {
    return t('common:apiKeys')
  },
  get api() {
    return t('common:upstreamAPIs')
  },
  get anthropic() {
    return t('common:anthropic')
  },
  get logs() {
    return t('common:usageHistory')
  },
  get statistics() {
    return t('common:statistics')
  },
  get database() {
    return t('common:database')
  },
  get settings() {
    return t('common:settings')
  },
  get users() {
    return t('common:users')
  },
  get wrap() {
    return t('common:kernel')
  },
}

// 监控组四页的职责边界，避免同一块数据在多页重复出现。
export const VIEW_DESCRIPTIONS: Partial<Record<ViewId, string>> = {
  get overview() {
    return t('common:overviewDescription')
  },
  get statistics() {
    return t('common:statisticsDescription')
  },
  get logs() {
    return t('common:logsDescription')
  },
}

export function firstAllowedPath(views?: string[] | null): string {
  const allow = new Set((views || []).map((v) => String(v).replace(/^\//, '')))
  for (const candidate of [
    'overview',
    'users',
    'keys',
    'statistics',
    'logs',
    'billing',
  ]) {
    if (allow.has(candidate)) return `/${candidate}`
  }
  return '/welcome'
}
