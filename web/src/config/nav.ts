import { t } from '@/i18n'
import type { FileRoutesById } from '@/routeTree.gen'

export type ViewId =
  | 'groups'
  | 'subscriptions'
  | 'overview'
  | 'cluster'
  | 'vm'
  | 'codex-accounts'
  | 'gateway-workers'
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
  | 'suppliers'
  | 'supplier-accounts'
  | 'profile'
  | 'wrap'

export const VIEW_TITLES: Record<ViewId, string> = {
  get groups() {
    return t('common:groups')
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
  get 'codex-accounts'() {
    return t('common:codexAccounts')
  },
  get 'gateway-workers'() {
    return t('common:gatewayWorkers')
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
  get suppliers() {
    return t('supplierAdmin:title')
  },
  get 'supplier-accounts'() {
    return t('supplierAdmin:accounts')
  },
  get profile() {
    return t('common:myProfile')
  },
  get wrap() {
    return t('common:kernel')
  },
}

// 总览、统计与使用记录的职责边界，避免同一块数据在多页重复出现。
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

/**
 * 路径对应的视图键：一般取第一段；供应商平台的账号池单独成视图
 * （supplier-accounts），获授账号资源查看权的管理员只能进这一页。
 */
export function viewOfPath(path: string): string {
  const parts = String(path || '')
    .replace(/^\//, '')
    .split(/[?#]/)[0]
    .split('/')
  if (parts[0] === 'suppliers' && parts[1] === 'accounts')
    return 'supplier-accounts'
  return parts[0] || ''
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
    'vm',
    'codex-accounts',
  ]) {
    if (allow.has(candidate)) return `/${candidate}`
  }
  if (allow.has('supplier-accounts')) return '/suppliers/accounts'
  return '/welcome'
}

type AuthenticatedPath<T = keyof FileRoutesById> =
  T extends `/_authenticated/${infer Head}/${string}`
    ? `/${Head}`
    : T extends `/_authenticated/${infer Head}`
      ? `/${Head}`
      : never

/**
 * Console page → panel view (`ROLE_VIEWS` in src/lib/admin/panel-acl.mjs).
 * Keyed by the first path segment, so nested pages (`/vm/$id`,
 * `/settings/$tab`) follow their parent; `/suppliers/accounts` is the one
 * exception (see `viewOfPath`). `null` = any signed-in user.
 * The sidebar and the route guard both read this table.
 */
export const ROUTE_VIEWS = {
  '/': null,
  '/overview': 'overview',
  '/statistics': 'statistics',
  '/logs': 'logs',
  '/users': 'users',
  '/keys': 'keys',
  '/billing': 'billing',
  '/profile': 'profile',
  '/subscriptions': 'subscriptions',
  '/groups': 'groups',
  '/cluster': 'cluster',
  '/vm': 'vm',
  '/codex-accounts': 'codex-accounts',
  '/gateway-workers': 'gateway-workers',
  '/import': 'import',
  '/specs': 'specs',
  '/proxies': 'proxies',
  '/suppliers': 'suppliers',
  '/models': 'models',
  '/api': 'api',
  '/anthropic': 'anthropic',
  '/risk': 'risk',
  '/system': 'system',
  '/settings': 'settings',
  '/wrap': 'wrap',
  '/database': 'database',
} as const satisfies Record<AuthenticatedPath, ViewId | null>

/** `undefined` = not a console page (left to the not-found route). */
export function viewForPath(path: string): ViewId | null | undefined {
  const head = `/${path.split(/[?#]/)[0].split('/').find(Boolean) ?? ''}`
  if (!(head in ROUTE_VIEWS)) return undefined
  const view = ROUTE_VIEWS[head as keyof typeof ROUTE_VIEWS]
  return view === 'suppliers' && viewOfPath(path) === 'supplier-accounts'
    ? 'supplier-accounts'
    : view
}

/** Missing views list = server without panel roles (show everything). */
export function hasPanelView(
  views: readonly string[] | null | undefined,
  view: ViewId
): boolean {
  if (views == null) return true
  return views.includes(view) || views.includes(`/${view}`)
}

export function canOpenPath(
  views: readonly string[] | null | undefined,
  path: string
): boolean {
  const view = viewForPath(path)
  return view == null || hasPanelView(views, view)
}
