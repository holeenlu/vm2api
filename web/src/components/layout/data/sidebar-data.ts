import { t } from '@/i18n'
import {
  Boxes,
  Cable,
  ChartColumn,
  Cpu,
  Database,
  Download,
  KeyRound,
  Layers,
  LayoutDashboard,
  MessageSquareText,
  ReceiptText,
  ScrollText,
  Send,
  Server,
  Settings,
  ShieldAlert,
  Sparkles,
  UsersRound,
} from 'lucide-react'
import type { NavGroup, NavItem, SidebarData } from '../types'

// 面板按运营管理、资源管理、系统管理分组；具体页面由后端返回的
// views 做角色裁剪。供应商门户使用独立入口，不混入普通面板导航。
const ALL_GROUPS: NavGroup[] = [
  {
    get title() {
      return t('common:operationsCenter')
    },
    items: [
      {
        get title() {
          return t('common:apiKeys')
        },
        url: '/keys',
        icon: KeyRound,
      },
      {
        get title() {
          return t('common:overview')
        },
        url: '/overview',
        icon: LayoutDashboard,
      },
      {
        get title() {
          return t('common:users')
        },
        url: '/users',
        icon: UsersRound,
      },
      {
        get title() {
          return t('common:providers')
        },
        url: '/providers',
        icon: Server,
      },
      {
        get title() {
          return t('common:statistics')
        },
        url: '/statistics',
        icon: ChartColumn,
      },
      {
        get title() {
          return t('common:usageHistory')
        },
        url: '/logs',
        icon: ScrollText,
      },
      {
        get title() {
          return t('common:billing')
        },
        url: '/billing',
        icon: ReceiptText,
      },
      {
        get title() {
          return t('common:operations')
        },
        url: '/ops',
        icon: LayoutDashboard,
      },
    ],
  },
  {
    get title() {
      return t('common:resourcesCenter')
    },
    items: [
      {
        get title() {
          return t('common:groups')
        },
        url: '/groups',
        icon: Layers,
      },
      {
        get title() {
          return t('common:cluster')
        },
        url: '/cluster',
        icon: Boxes,
      },
      {
        get title() {
          return t('common:virtualMachines')
        },
        url: '/vm',
        icon: Server,
      },
      {
        get title() {
          return t('common:import')
        },
        url: '/import',
        icon: Download,
      },
      {
        get title() {
          return t('common:specifications')
        },
        url: '/specs',
        icon: Cpu,
      },
      {
        get title() {
          return t('common:proxyPool')
        },
        url: '/proxies',
        icon: Cable,
      },
    ],
  },
  {
    get title() {
      return t('common:platformSettings')
    },
    items: [
      {
        get title() {
          return t('common:models')
        },
        url: '/models',
        icon: Sparkles,
      },
      {
        get title() {
          return t('common:upstreamAPIs')
        },
        url: '/api',
        icon: Cable,
      },
      {
        get title() {
          return t('common:anthropic')
        },
        url: '/anthropic',
        icon: Send,
      },
      {
        get title() {
          return t('common:riskAudit')
        },
        url: '/risk',
        icon: ShieldAlert,
      },
      {
        get title() {
          return t('common:systemPrompts')
        },
        url: '/system',
        icon: MessageSquareText,
      },
      {
        get title() {
          return t('common:settings')
        },
        url: '/settings',
        icon: Settings,
      },
      {
        get title() {
          return t('common:kernel')
        },
        url: '/wrap',
        icon: Layers,
      },
      {
        get title() {
          return t('common:database')
        },
        url: '/database',
        icon: Database,
      },
    ],
  },
  {
    get title() {
      return t('common:myAccount')
    },
    items: [
      {
        get title() {
          return t('common:apiKeys')
        },
        url: '/keys?scope=mine',
        icon: KeyRound,
      },
      {
        get title() {
          return t('common:usageHistory')
        },
        url: '/logs?scope=mine',
        icon: ChartColumn,
      },
    ],
  },
]

function itemView(item: NavItem): string {
  if (item.url) return String(item.url).replace(/^\//, '').split('?')[0]
  return item.title
}

export function navGroupsFor(
  views?: string[] | null,
  role?: string | null
): NavGroup[] {
  if (views == null) return ALL_GROUPS
  const allow = new Set(views.map((v) => String(v).trim()).filter(Boolean))
  if (allow.size === 0) return []
  const personal = role === 'admin' || role === 'user'
  const allowed = (item: NavItem) => {
    const key = itemView(item)
    return allow.has(key) || allow.has(`/${key}`)
  }
  const groups = ALL_GROUPS.filter(
    (group) => group.title !== t('common:myAccount')
  )
    .map((group) => ({
      ...group,
      title: role === 'admin' && group === ALL_GROUPS[0] ? '' : group.title,
      items: group.items.filter((item) => {
        if (!allowed(item)) return false
        const key = itemView(item)
        if (personal && key === 'keys') return false
        return role !== 'user' || key !== 'logs'
      }),
    }))
    .filter((group) => group.items.length > 0)
  if (personal) {
    const account = ALL_GROUPS.find(
      (group) => group.title === t('common:myAccount')
    )
    const items = (account?.items.filter(allowed) ?? []).map((item) =>
      role === 'user' && item.url
        ? { ...item, url: String(item.url).split('?')[0] }
        : item
    )
    if (account && items.length) groups.push({ ...account, items })
  }
  return role === 'user' && groups.length
    ? [{ title: '', items: groups.flatMap((group) => group.items) }]
    : groups
}

export const sidebarData: SidebarData = {
  navGroups: ALL_GROUPS,
}
