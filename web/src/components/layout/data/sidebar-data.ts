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

// 面板按职责分组；具体页面由后端返回的 views 做角色裁剪。
// 供应商门户后续使用独立入口，不混入普通面板导航。
const ALL_GROUPS: NavGroup[] = [
  {
    get title() {
      return t('common:operationsCenter')
    },
    items: [
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
          return t('common:subscriptions')
        },
        url: '/subscriptions',
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
      return t('common:accessManagement')
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
          return t('common:apiKeys')
        },
        url: '/keys',
        icon: KeyRound,
      },
      {
        get title() {
          return t('common:anthropic')
        },
        url: '/anthropic',
        icon: Send,
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
]

function itemView(item: NavItem): string {
  if (item.url) return String(item.url).replace(/^\//, '')
  return item.title
}

export function navGroupsFor(views?: string[] | null): NavGroup[] {
  if (views == null) return ALL_GROUPS
  const allow = new Set(views.map((v) => String(v).trim()).filter(Boolean))
  if (allow.size === 0) return []
  return ALL_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => {
      const key = itemView(item)
      return allow.has(key) || allow.has(`/${key}`)
    }),
  })).filter((group) => group.items.length > 0)
}

export const sidebarData: SidebarData = {
  navGroups: ALL_GROUPS,
}
